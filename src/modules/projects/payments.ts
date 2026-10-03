import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../../db';
import { files, projectPayments, statements } from '../../db/schema';
import { toLatinDigits } from '../../lib/text';
import { fileUrl, purgeFiles, saveUpload } from '../files/files.service';
import { singleFile, uploadLimiter } from '../files/upload';
import { ah, moneyInput, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { emitTo } from '../../lib/events';
import { requireAuth } from '../../middlewares/auth';
import { notify } from '../notifications/notify';
import { faNum } from '../contracts/contract.service';
import { projectFor, type Project } from './access';

type Payment = typeof projectPayments.$inferSelect;
type View = Awaited<ReturnType<typeof projectFor>>;

export const PAYMENT_LABELS = ['پیش‌پرداخت', 'قسط مرحله', 'دستمزد هفتگی', 'صورت‌وضعیت', 'تسویهٔ نهایی', 'حسن انجام کار', 'سایر'] as const;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date()); // YYYY-MM-DD

/** شمارهٔ پیگیری/مرجع بانک: فقط حروف و رقم لاتین */
export const normTracking = (s?: string | null) => (s ? toLatinDigits(s).toUpperCase().replace(/[^A-Z0-9]/g, '') : '') || null;

/** نشانه‌های قابل‌اعتماد بودن یک پرداخت (برای نمایش به طرف مقابل؛ تأیید نهایی با خود اوست) */
function checksOf(x: Pick<Payment, 'amount' | 'milestoneIndex' | 'paidOn' | 'trackingNo' | 'receiptFileId'>, p: Project): string[] {
  const out: string[] = [];
  if (!x.receiptFileId) out.push('NO_RECEIPT');
  if (!x.trackingNo) out.push('NO_TRACKING');
  if (x.milestoneIndex != null && p.amount != null) {
    const due = Math.round((p.amount * (p.paymentPlan[x.milestoneIndex]?.pct ?? 0)) / 100);
    if (due && Math.abs(due - x.amount) > due * 0.01) out.push('AMOUNT_MISMATCH');
  }
  const created = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date(p.createdAt.getTime() - 86400_000));
  if (x.paidOn < created) out.push('BEFORE_PROJECT');
  return out;
}

function shape(x: Payment, v: View, receipt?: { id: string; isPublic: boolean; mime?: string } | null) {
  const byMe = x.recordedByProfileId === v.me.id;
  return {
    id: x.id,
    amount: x.amount,
    label: x.label,
    milestoneIndex: x.milestoneIndex,
    statementId: x.statementId,
    paidOn: x.paidOn,
    note: x.note,
    status: x.status,
    disputeReason: x.disputeReason,
    recordedByMe: byMe,
    trackingNo: x.trackingNo,
    bank: x.bank,
    receiptUrl: receipt ? fileUrl(receipt) : null,
    receiptMime: receipt?.mime ?? null,
    checks: x.checks ?? [],
    // «مستند» = رسید یا شمارهٔ پیگیری دارد و طرف مقابل رسیدن پول را تأیید کرده
    documented: x.status === 'confirmed' && !!(x.receiptFileId || x.trackingNo),
    can: { respond: !byMe && x.status === 'recorded', delete: byMe && x.status !== 'confirmed', receipt: byMe && x.status === 'recorded' },
    createdAt: x.createdAt,
  };
}

/** خلاصه: مبلغ هر مرحله طبق برنامهٔ پرداخت و جمع پرداخت‌های تأییدشده/در انتظار */
function summary(p: Project, list: Payment[]) {
  const sum = (f: (x: Payment) => boolean) => list.filter(f).reduce((a, x) => a + x.amount, 0);
  const confirmed = sum((x) => x.status === 'confirmed');
  const pending = sum((x) => x.status === 'recorded');
  return {
    total: p.amount,
    confirmed,
    pending,
    disputed: sum((x) => x.status === 'disputed'),
    remaining: p.amount != null ? Math.max(0, p.amount - confirmed) : null,
    retention: p.amount != null ? Math.round((p.amount * p.retentionPct) / 100) : null,
    milestones: p.paymentPlan.map((m, i) => ({
      index: i,
      title: m.title,
      pct: m.pct,
      due: p.amount != null ? Math.round((p.amount * m.pct) / 100) : null,
      paid: sum((x) => x.milestoneIndex === i && x.status === 'confirmed'),
    })),
  };
}

async function list(v: View) {
  return db.select().from(projectPayments).where(eq(projectPayments.projectId, v.p.id)).orderBy(desc(projectPayments.paidOn), desc(projectPayments.createdAt));
}
async function receiptsOf(rows: Payment[]) {
  const m = new Map<string, { id: string; isPublic: boolean; mime: string }>();
  for (const id of rows.map((x) => x.receiptFileId).filter((x): x is string => !!x)) {
    const [f] = await db.select({ id: files.id, isPublic: files.isPublic, mime: files.mime }).from(files).where(eq(files.id, id)).limit(1);
    if (f) m.set(id, f);
  }
  return m;
}
async function assertUniqueTracking(trackingNo: string | null, exceptId?: string) {
  if (!trackingNo) return;
  const [dup] = await db
    .select({ id: projectPayments.id })
    .from(projectPayments)
    .where(exceptId ? and(eq(projectPayments.trackingNo, trackingNo), ne(projectPayments.id, exceptId)) : eq(projectPayments.trackingNo, trackingNo))
    .limit(1);
  if (dup) throw conflict('این شمارهٔ پیگیری قبلاً برای پرداخت دیگری ثبت شده؛ هر رسید فقط یک بار ثبت می‌شود', 'DUP_TRACKING');
}

/* ---------- /api/projects/:id/payments ---------- */

export const projectPaymentsRouter = Router({ mergeParams: true });
projectPaymentsRouter.use(requireAuth);

projectPaymentsRouter.get(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const v = await projectFor(req.user!.id, id);
    const rows = await list(v);
    const rc = await receiptsOf(rows);
    res.json({ items: rows.map((x) => shape(x, v, x.receiptFileId ? rc.get(x.receiptFileId) : null)), summary: summary(v.p, rows), labels: PAYMENT_LABELS });
  }),
);

projectPaymentsRouter.post(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        amount: moneyInput.refine((n) => n !== null && n > 0, 'مبلغ را بنویس'),
        label: z.enum(PAYMENT_LABELS),
        milestoneIndex: z.number().int().min(0).max(7).nullish(),
        statementId: z.string().uuid().nullish(),
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ به شکل 2026-09-28').optional(),
        note: z.string().trim().max(500).optional(),
        trackingNo: z.string().max(60).nullish(),
        bank: z.string().trim().max(40).nullish(),
      }),
      req.body,
    );
    const trackingNo = normTracking(body.trackingNo);
    if (trackingNo && (trackingNo.length < 4 || trackingNo.length > 30)) throw badRequest('شمارهٔ پیگیری درست نیست', 'BAD_TRACKING');
    const paidOn = body.paidOn ?? today();
    if (paidOn > today()) throw badRequest('تاریخ پرداخت نمی‌تواند در آینده باشد', 'FUTURE_PAYMENT');
    await assertUniqueTracking(trackingNo);
    const v = await projectFor(req.user!.id, id);
    if (v.p.status === 'cancelled') throw conflict('این پروژه لغو شده است', 'PROJECT_CLOSED');
    if (body.milestoneIndex != null && body.milestoneIndex >= v.p.paymentPlan.length) throw badRequest('این مرحلهٔ پرداخت در قرارداد نیست', 'BAD_MILESTONE');
    if (body.statementId) {
      const [st] = await db
        .select({ status: statements.status })
        .from(statements)
        .where(and(eq(statements.id, body.statementId), eq(statements.projectId, id)))
        .limit(1);
      if (!st) throw badRequest('صورت‌وضعیت مربوط به این پروژه نیست', 'BAD_STATEMENT');
      if (st.status !== 'approved') throw badRequest('فقط صورت‌وضعیت تأییدشده پرداخت می‌شود', 'STATEMENT_NOT_APPROVED');
    }
    const [x] = await db
      .insert(projectPayments)
      .values({
        projectId: id,
        recordedByProfileId: v.me.id,
        amount: body.amount!,
        label: body.label,
        milestoneIndex: body.milestoneIndex ?? null,
        statementId: body.statementId ?? null,
        paidOn,
        note: body.note || null,
        trackingNo,
        bank: body.bank || null,
        checks: checksOf({ amount: body.amount!, milestoneIndex: body.milestoneIndex ?? null, paidOn, trackingNo, receiptFileId: null }, v.p),
      })
      .returning();
    await notify(v.other.userId, {
      type: 'req',
      title: 'پرداخت ثبت شد؛ تأیید کن',
      body: `${v.me.name}: ${faNum(x.amount)} تومان بابت ${x.label}`,
      link: { screen: 'pdet', id },
    });
    emitTo([v.client.userId, v.provider.userId], { type: 'payment', data: { projectId: id, paymentId: x.id } });
    res.status(201).json({ payment: shape(x, v) });
  }),
);

/* ---------- /api/payments/:id ---------- */

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

async function ownPayment(userId: string, id: string) {
  const [x] = await db.select().from(projectPayments).where(eq(projectPayments.id, id)).limit(1);
  if (!x) throw notFound('پرداخت پیدا نشد');
  const v = await projectFor(userId, x.projectId); // غیرِ طرفین: «پیدا نشد»
  return { x, v };
}

/** رسید واریز: عکس/اسکرین‌شات یا PDF (فیلد file) + شمارهٔ پیگیری؛ فقط ثبت‌کننده و تا وقتی تأیید نشده */
paymentsRouter.post(
  '/:id/receipt',
  uploadLimiter,
  singleFile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ trackingNo: z.string().max(60).optional(), bank: z.string().trim().max(40).optional() }), req.body ?? {});
    const { x, v } = await ownPayment(req.user!.id, id);
    if (x.recordedByProfileId !== v.me.id) throw forbidden('رسید را کسی می‌گذارد که پرداخت را ثبت کرده', 'NOT_OWNER');
    if (x.status !== 'recorded') throw conflict('پرداخت تأییدشده یا اعتراض‌شده قابل تغییر نیست', 'PAYMENT_LOCKED');
    if (!req.file) throw badRequest('عکس یا فایل رسید را انتخاب کن', 'NO_FILE');
    // یک رسید (همان فایل) فقط یک بار در کل بلوک
    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const [dup] = await db.select({ id: projectPayments.id }).from(projectPayments).where(and(eq(projectPayments.receiptHash, hash), ne(projectPayments.id, id))).limit(1);
    if (dup) throw conflict('این رسید قبلاً برای پرداخت دیگری ثبت شده است', 'DUP_RECEIPT');
    const trackingNo = body.trackingNo !== undefined ? normTracking(body.trackingNo) : x.trackingNo;
    if (trackingNo && (trackingNo.length < 4 || trackingNo.length > 30)) throw badRequest('شمارهٔ پیگیری درست نیست', 'BAD_TRACKING');
    await assertUniqueTracking(trackingNo, id);
    const f = await saveUpload(req.user!.id, 'receipt', req.file, { projectId: x.projectId });
    const old = x.receiptFileId;
    const [nx] = await db
      .update(projectPayments)
      .set({ receiptFileId: f.id, receiptHash: hash, trackingNo, bank: body.bank || x.bank, checks: checksOf({ ...x, trackingNo, receiptFileId: f.id }, v.p) })
      .where(eq(projectPayments.id, id))
      .returning();
    if (old) await purgeFiles([old]).catch(() => {});
    await notify(v.other.userId, {
      type: 'req',
      title: 'رسید واریز رسید؛ بررسی و تأیید کن',
      body: `${v.me.name}: ${faNum(x.amount)} تومان${trackingNo ? ' · پیگیری ' + trackingNo : ''}`,
      link: { screen: 'pdet', id: x.projectId },
    });
    emitTo([v.client.userId, v.provider.userId], { type: 'payment', data: { projectId: x.projectId, paymentId: id } });
    res.json({ payment: shape(nx, v, { id: f.id, isPublic: f.isPublic, mime: f.mime }) });
  }),
);

/** طرف مقابل تأیید می‌کند که این پول رسید/پرداخت شد — یا اعتراض می‌کند */
paymentsRouter.post(
  '/:id/:action(confirm|dispute)',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const action = req.params.action as 'confirm' | 'dispute';
    const { reason } = parse(
      z.object({ reason: action === 'dispute' ? z.string().trim().min(3, 'دلیل اعتراض را بنویس').max(500) : z.string().optional() }),
      req.body ?? {},
    );
    const { x, v } = await ownPayment(req.user!.id, id);
    if (x.recordedByProfileId === v.me.id) throw forbidden('پرداختی را که خودت ثبت کرده‌ای، طرف مقابل تأیید می‌کند', 'OWN_PAYMENT');
    if (x.status !== 'recorded') throw conflict('به این پرداخت قبلاً جواب داده شده', 'ALREADY_ANSWERED');
    const [nx] = await db
      .update(projectPayments)
      .set({ status: action === 'confirm' ? 'confirmed' : 'disputed', disputeReason: action === 'dispute' ? reason : null, respondedAt: new Date() })
      .where(and(eq(projectPayments.id, id), eq(projectPayments.status, 'recorded')))
      .returning();
    if (!nx) throw conflict('به این پرداخت قبلاً جواب داده شده', 'ALREADY_ANSWERED');
    await notify(v.other.userId, {
      type: 'req',
      title: action === 'confirm' ? 'پرداخت تأیید شد' : 'به پرداخت اعتراض شد',
      body: `${faNum(x.amount)} تومان بابت ${x.label}${action === 'dispute' ? ` — ${reason}` : ''}`,
      link: { screen: 'pdet', id: x.projectId },
    });
    emitTo([v.client.userId, v.provider.userId], { type: 'payment', data: { projectId: x.projectId, paymentId: id } });
    res.json({ payment: shape(nx, v) });
  }),
);

paymentsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { x, v } = await ownPayment(req.user!.id, id);
    if (x.recordedByProfileId !== v.me.id) throw forbidden('فقط پرداختی را که خودت ثبت کرده‌ای می‌توانی حذف کنی', 'NOT_OWNER');
    if (x.status === 'confirmed') throw conflict('پرداخت تأییدشده حذف نمی‌شود', 'PAYMENT_CONFIRMED');
    await db.delete(projectPayments).where(eq(projectPayments.id, id));
    res.json({ ok: true });
  }),
);
