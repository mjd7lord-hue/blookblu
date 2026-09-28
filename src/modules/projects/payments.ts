import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { projectPayments, statements } from '../../db/schema';
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

function shape(x: Payment, v: View) {
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
    can: { respond: !byMe && x.status === 'recorded', delete: byMe && x.status !== 'confirmed' },
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

/* ---------- /api/projects/:id/payments ---------- */

export const projectPaymentsRouter = Router({ mergeParams: true });
projectPaymentsRouter.use(requireAuth);

projectPaymentsRouter.get(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const v = await projectFor(req.user!.id, id);
    const rows = await list(v);
    res.json({ items: rows.map((x) => shape(x, v)), summary: summary(v.p, rows), labels: PAYMENT_LABELS });
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
      }),
      req.body,
    );
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
        paidOn: body.paidOn ?? today(),
        note: body.note || null,
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
