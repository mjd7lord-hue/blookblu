import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import { db } from '../../db';
import { statements, type StatementItem, type StatementTotals } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { emitTo } from '../../lib/events';
import { toLatinDigits } from '../../lib/text';
import { requireAuth } from '../../middlewares/auth';
import { notify } from '../notifications/notify';
import { faNum } from '../contracts/contract.service';
import { assertActive, projectFor, projectSysMessage } from './access';

type Statement = typeof statements.$inferSelect;
type View = Awaited<ReturnType<typeof projectFor>>;

/* ---------- محاسبه ---------- */

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeTotals(items: StatementItem[], retentionPct: number, insurancePct: number): StatementTotals {
  const val = (f: (x: StatementItem) => number) => Math.round(items.reduce((s, x) => s + f(x) * x.unitPrice, 0));
  const contractValue = val((x) => x.qty);
  const doneValue = val((x) => x.done);
  const prevValue = val((x) => x.prevDone);
  const periodValue = doneValue - prevValue;
  const retention = Math.round((periodValue * retentionPct) / 100);
  const insurance = Math.round((periodValue * insurancePct) / 100);
  return {
    contractValue,
    doneValue,
    prevValue,
    periodValue,
    retention,
    insurance,
    payable: periodValue - retention - insurance,
    progressPct: contractValue ? Math.round((doneValue / contractValue) * 100) : 0,
  };
}

// عدد با ارقام فارسی و ممیز «٫» هم قبول است
const num = z.preprocess((v) => (typeof v === 'string' ? Number(toLatinDigits(v).replace(/[٬,\s]/g, '').replace('٫', '.')) : v), z.number().finite());
const itemInput = z.object({
  key: z.string().max(20).optional(),
  title: z.string().trim().min(2).max(120),
  unit: z.string().trim().min(1).max(30),
  qty: num.pipe(z.number().positive().max(1e9)),
  unitPrice: num.pipe(z.number().int().min(0).max(1e12)),
  done: num.pipe(z.number().min(0).max(1e9)),
});
type ItemInput = z.infer<typeof itemInput>;

/**
 * ردیف‌های ورودی + ردیف‌های صورت‌وضعیت تأییدشدهٔ قبلی:
 * «قبلی» از آخرین صورت‌وضعیت تأییدشده می‌آید و قابل کم کردن نیست؛ ردیف قبلیِ دارای کار حذف نمی‌شود.
 */
function mergeItems(input: ItemInput[], base: StatementItem[]): StatementItem[] {
  const baseMap = new Map(base.map((b) => [b.key, b]));
  const out: StatementItem[] = [];
  const seen = new Set<string>();
  for (const it of input) {
    const b = it.key ? baseMap.get(it.key) : undefined;
    const key = b ? b.key : crypto.randomBytes(5).toString('hex');
    if (seen.has(key)) throw badRequest(`ردیف «${it.title}» دو بار آمده است`, 'DUPLICATE_ROW');
    seen.add(key);
    const prevDone = b ? b.done : 0;
    if (it.done < prevDone) throw badRequest(`«${it.title}»: مقدار انجام‌شده از صورت‌وضعیت قبلی (${faNum(prevDone)}) کمتر نمی‌شود`, 'ROW_BELOW_PREV');
    if (it.done > it.qty) throw badRequest(`«${it.title}»: انجام‌شده از مقدار کل بیشتر است؛ مقدار کل را اصلاح کن`, 'DONE_OVER_QTY');
    out.push({ key, title: it.title, unit: it.unit, qty: round2(it.qty), unitPrice: it.unitPrice, prevDone: round2(prevDone), done: round2(it.done) });
  }
  // ردیف‌های قبلی که نیامده‌اند، بدون کار تازه می‌مانند
  for (const b of base) {
    if (!seen.has(b.key) && b.done > 0) out.push({ ...b, prevDone: b.done });
  }
  if (!out.length) throw badRequest('حداقل یک ردیف کار لازم است', 'NO_ROWS');
  if (out.length > 60) throw badRequest('حداکثر ۶۰ ردیف', 'TOO_MANY_ROWS');
  return out;
}

async function lastApproved(projectId: string) {
  const [s] = await db
    .select()
    .from(statements)
    .where(and(eq(statements.projectId, projectId), eq(statements.status, 'approved')))
    .orderBy(desc(statements.number))
    .limit(1);
  return s;
}

function shape(s: Statement, v: View, full = true) {
  const provider = v.side === 'provider';
  const open = v.p.status === 'active';
  return {
    id: s.id,
    number: s.number,
    status: s.status,
    statusName: { draft: 'پیش‌نویس', sent: 'منتظر تأیید کارفرما', approved: 'تأیید شد', rejected: 'رد شد؛ اصلاح و ارسال دوباره' }[s.status],
    totals: s.totals,
    retentionPct: s.retentionPct,
    insurancePct: s.insurancePct,
    note: s.note,
    rejectReason: s.rejectReason,
    ...(full ? { items: s.items } : { rows: s.items.length }),
    sentAt: s.sentAt,
    approvedAt: s.approvedAt,
    createdAt: s.createdAt,
    can: {
      edit: open && provider && (s.status === 'draft' || s.status === 'rejected'),
      send: open && provider && (s.status === 'draft' || s.status === 'rejected'),
      delete: provider && (s.status === 'draft' || s.status === 'rejected'),
      approve: open && !provider && s.status === 'sent',
      reject: open && !provider && s.status === 'sent',
    },
  };
}

/* ---------- /api/projects/:id/statements ---------- */

export const projectStatementsRouter = Router({ mergeParams: true });
projectStatementsRouter.use(requireAuth);

projectStatementsRouter.get(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const v = await projectFor(req.user!.id, id);
    const rows = await db.select().from(statements).where(eq(statements.projectId, id)).orderBy(desc(statements.number));
    // ردیف‌های پیشنهادی برای صورت‌وضعیت بعدی (از آخرین تأییدشده)
    const base = await lastApproved(id);
    res.json({
      items: rows.map((s) => shape(s, v, false)),
      nextBase: base ? base.items.map((x) => ({ ...x, prevDone: x.done })) : [],
    });
  }),
);

/** فقط مجری: صورت‌وضعیت تازه (پیش‌نویس) — ردیف‌ها از آخرین صورت‌وضعیت تأییدشده پر می‌شوند */
projectStatementsRouter.post(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        items: z.array(itemInput).max(60).optional(),
        retentionPct: z.number().min(0).max(20).optional(),
        insurancePct: z.number().min(0).max(20).optional(),
        note: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    const v = await projectFor(req.user!.id, id);
    assertActive(v.p);
    if (v.side !== 'provider') throw forbidden('صورت‌وضعیت را مجری تنظیم می‌کند', 'PROVIDER_ONLY');
    const [open] = await db
      .select({ id: statements.id, number: statements.number })
      .from(statements)
      .where(and(eq(statements.projectId, id), inArray(statements.status, ['draft', 'sent', 'rejected'])))
      .limit(1);
    if (open) throw conflict(`صورت‌وضعیت شمارهٔ ${faNum(open.number)} هنوز باز است`, 'STATEMENT_OPEN', { id: open.id });

    const base = (await lastApproved(id))?.items ?? [];
    const items = body.items ? mergeItems(body.items, base) : base.map((x) => ({ ...x, prevDone: x.done }));
    if (!items.length) throw badRequest('برای اولین صورت‌وضعیت، ردیف‌های کار را بفرست', 'NO_ROWS');
    const retentionPct = body.retentionPct ?? v.p.retentionPct;
    const insurancePct = body.insurancePct ?? 0;

    const s = await db.transaction(async (tx) => {
      const [{ n }] = await tx.select({ n: max(statements.number) }).from(statements).where(eq(statements.projectId, id));
      const [row] = await tx
        .insert(statements)
        .values({
          projectId: id,
          number: (n ?? 0) + 1,
          items,
          retentionPct,
          insurancePct,
          totals: computeTotals(items, retentionPct, insurancePct),
          note: body.note || null,
          createdByProfileId: v.me.id,
        })
        .returning();
      return row;
    });
    res.status(201).json({ statement: shape(s, v) });
  }),
);

/* ---------- /api/statements/:id ---------- */

export const statementsRouter = Router();
statementsRouter.use(requireAuth);

async function load(userId: string, id: string) {
  const [s] = await db.select().from(statements).where(eq(statements.id, id)).limit(1);
  if (!s) throw notFound('صورت‌وضعیت پیدا نشد');
  const v = await projectFor(userId, s.projectId);
  return { s, v };
}

statementsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { s, v } = await load(req.user!.id, id);
    res.json({ statement: shape(s, v) });
  }),
);

statementsRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        items: z.array(itemInput).max(60).optional(),
        retentionPct: z.number().min(0).max(20).optional(),
        insurancePct: z.number().min(0).max(20).optional(),
        note: z.string().trim().max(1000).nullable().optional(),
      }),
      req.body,
    );
    const { s, v } = await load(req.user!.id, id);
    assertActive(v.p);
    if (v.side !== 'provider') throw forbidden('صورت‌وضعیت را مجری ویرایش می‌کند', 'PROVIDER_ONLY');
    if (s.status !== 'draft' && s.status !== 'rejected') throw conflict('صورت‌وضعیت ارسال‌شده ویرایش نمی‌شود', 'STATEMENT_LOCKED');
    const base = (await lastApproved(v.p.id))?.items ?? [];
    const items = body.items ? mergeItems(body.items, base) : s.items;
    const retentionPct = body.retentionPct ?? s.retentionPct;
    const insurancePct = body.insurancePct ?? s.insurancePct;
    const [ns] = await db
      .update(statements)
      .set({
        items,
        retentionPct,
        insurancePct,
        totals: computeTotals(items, retentionPct, insurancePct),
        note: body.note === undefined ? s.note : body.note || null,
        updatedAt: new Date(),
      })
      .where(and(eq(statements.id, id), inArray(statements.status, ['draft', 'rejected'])))
      .returning();
    if (!ns) throw conflict('صورت‌وضعیت ارسال‌شده ویرایش نمی‌شود', 'STATEMENT_LOCKED');
    res.json({ statement: shape(ns, v) });
  }),
);

statementsRouter.post(
  '/:id/send',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { s, v } = await load(req.user!.id, id);
    assertActive(v.p);
    if (v.side !== 'provider') throw forbidden('صورت‌وضعیت را مجری می‌فرستد', 'PROVIDER_ONLY');
    if (s.totals.periodValue <= 0) throw badRequest('در این دوره کاری ثبت نشده؛ مقدار انجام‌شده را به‌روز کن', 'NOTHING_TO_BILL');
    const [ns] = await db
      .update(statements)
      .set({ status: 'sent', sentAt: new Date(), rejectReason: null, updatedAt: new Date() })
      .where(and(eq(statements.id, id), inArray(statements.status, ['draft', 'rejected'])))
      .returning();
    if (!ns) throw conflict('این صورت‌وضعیت قبلاً ارسال شده', 'STATEMENT_LOCKED');
    await projectSysMessage(v.p, `صورت‌وضعیت شمارهٔ ${faNum(s.number)} ارسال شد: ${faNum(s.totals.payable)} تومان قابل پرداخت.`);
    await notify(v.other.userId, {
      type: 'req',
      title: `صورت‌وضعیت شمارهٔ ${faNum(s.number)} رسید`,
      body: `${v.me.name}: ${faNum(s.totals.payable)} تومان`,
      link: { screen: 'sov', id },
    });
    emitTo([v.client.userId, v.provider.userId], { type: 'statement', data: { projectId: v.p.id, statementId: id, status: 'sent' } });
    res.json({ statement: shape(ns, v) });
  }),
);

/** کارفرما تأیید می‌کند؛ می‌تواند مقدار انجام‌شدهٔ ردیف‌ها را کم کند (نه بیشتر از ادعای مجری) */
statementsRouter.post(
  '/:id/approve',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ adjust: z.array(z.object({ key: z.string().max(20), done: num.pipe(z.number().min(0)) })).max(60).optional() }), req.body ?? {});
    const { s, v } = await load(req.user!.id, id);
    assertActive(v.p);
    if (v.side !== 'client') throw forbidden('صورت‌وضعیت را کارفرما تأیید می‌کند', 'CLIENT_ONLY');
    if (s.status !== 'sent') throw conflict('این صورت‌وضعیت منتظر تأیید نیست', 'NOT_SENT');
    const items = s.items.map((x) => {
      const a = body.adjust?.find((y) => y.key === x.key);
      if (!a) return x;
      if (a.done > x.done || a.done < x.prevDone) {
        throw badRequest(`«${x.title}»: مقدار تأییدی باید بین ${faNum(x.prevDone)} و ${faNum(x.done)} باشد`, 'BAD_ADJUST');
      }
      return { ...x, done: round2(a.done) };
    });
    const totals = computeTotals(items, s.retentionPct, s.insurancePct);
    const [ns] = await db
      .update(statements)
      .set({ status: 'approved', items, totals, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(statements.id, id), eq(statements.status, 'sent')))
      .returning();
    if (!ns) throw conflict('این صورت‌وضعیت منتظر تأیید نیست', 'NOT_SENT');
    const changed = totals.payable !== s.totals.payable;
    await projectSysMessage(
      v.p,
      `صورت‌وضعیت شمارهٔ ${faNum(s.number)} تأیید شد${changed ? ' (با اصلاح کارفرما)' : ''}: ${faNum(totals.payable)} تومان قابل پرداخت.`,
    );
    await notify(v.other.userId, {
      type: 'req',
      title: `صورت‌وضعیت شمارهٔ ${faNum(s.number)} تأیید شد`,
      body: `${faNum(totals.payable)} تومان${changed ? ' — کارفرما مقدار بعضی ردیف‌ها را اصلاح کرد' : ''}`,
      link: { screen: 'sov', id },
    });
    emitTo([v.client.userId, v.provider.userId], { type: 'statement', data: { projectId: v.p.id, statementId: id, status: 'approved' } });
    res.json({ statement: shape(ns, v) });
  }),
);

statementsRouter.post(
  '/:id/reject',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'دلیل را بنویس').max(1000) }), req.body);
    const { s, v } = await load(req.user!.id, id);
    if (v.side !== 'client') throw forbidden('صورت‌وضعیت را کارفرما بررسی می‌کند', 'CLIENT_ONLY');
    const [ns] = await db
      .update(statements)
      .set({ status: 'rejected', rejectReason: reason, updatedAt: new Date() })
      .where(and(eq(statements.id, id), eq(statements.status, 'sent')))
      .returning();
    if (!ns) throw conflict('این صورت‌وضعیت منتظر تأیید نیست', 'NOT_SENT');
    await notify(v.other.userId, { type: 'req', title: `صورت‌وضعیت شمارهٔ ${faNum(s.number)} رد شد`, body: reason, link: { screen: 'sov', id } });
    emitTo([v.client.userId, v.provider.userId], { type: 'statement', data: { projectId: v.p.id, statementId: id, status: 'rejected' } });
    res.json({ statement: shape(ns, v) });
  }),
);

statementsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { s, v } = await load(req.user!.id, id);
    if (v.side !== 'provider') throw forbidden('صورت‌وضعیت را مجری حذف می‌کند', 'PROVIDER_ONLY');
    if (s.status !== 'draft' && s.status !== 'rejected') throw conflict('صورت‌وضعیت ارسال‌شده یا تأییدشده حذف نمی‌شود', 'STATEMENT_LOCKED');
    // حذف آخرین شماره؛ اگر وسطی باشد شماره‌ها پیوسته نمی‌مانند — فقط پیش‌نویس باز حذف می‌شود و همیشه آخرین است
    await db.delete(statements).where(and(eq(statements.id, id), inArray(statements.status, ['draft', 'rejected'])));
    res.json({ ok: true });
  }),
);
