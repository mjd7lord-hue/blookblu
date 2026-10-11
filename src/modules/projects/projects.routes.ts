import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { contracts, conversations, dailyReports, profiles, projectPayments, projects, reviews, STAGES } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { emitTo } from '../../lib/events';
import { requireAuth } from '../../middlewares/auth';
import { postMessage } from '../chat/chat.service';
import { clientP, load, party, providerP, type Party, type Project } from './access';
import { notify } from '../notifications/notify';
import { publicFileUrl } from '../files/files.service';
import { voidPendingContract } from '../contracts/contract.service';

const faDigits = (n: number) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);

const r = Router();
r.use(requireAuth);

type Summary = { paid: number; pending: number; lastReport: { date: string; done: string } | null };
const EMPTY: Summary = { paid: 0, pending: 0, lastReport: null };
/** خلاصهٔ کارت خانه: پول تأییدشده/در انتظار تأیید و آخرین گزارش روزانه */
async function summaries(ids: string[]) {
  const m = new Map<string, Summary>();
  if (!ids.length) return m;
  const [pays, reps] = await Promise.all([
    db
      .select({
        id: projectPayments.projectId,
        paid: sql<number>`coalesce(sum(${projectPayments.amount}) filter (where ${projectPayments.status} = 'confirmed'), 0)::bigint`,
        pending: sql<number>`coalesce(sum(${projectPayments.amount}) filter (where ${projectPayments.status} = 'recorded'), 0)::bigint`,
      })
      .from(projectPayments)
      .where(inArray(projectPayments.projectId, ids))
      .groupBy(projectPayments.projectId),
    db
      .selectDistinctOn([dailyReports.projectId], { id: dailyReports.projectId, date: dailyReports.reportDate, done: dailyReports.done })
      .from(dailyReports)
      .where(inArray(dailyReports.projectId, ids))
      .orderBy(dailyReports.projectId, desc(dailyReports.reportDate), desc(dailyReports.createdAt)),
  ]);
  for (const x of pays) m.set(x.id, { paid: Number(x.paid), pending: Number(x.pending), lastReport: null });
  for (const x of reps) m.set(x.id, { ...(m.get(x.id) ?? EMPTY), lastReport: { date: x.date, done: x.done.slice(0, 140) } });
  return m;
}

function shape(row: { p: Project; client: Party; provider: Party }, userId: string, myRating: number | undefined, sum: Summary = EMPTY) {
  const iAmClient = row.client.userId === userId;
  const reviewed = myRating !== undefined;
  const strip = ({ userId: _u, avatarFileId, ...x }: Party) => ({ ...x, avatarUrl: publicFileUrl(avatarFileId) });
  return {
    ...row.p,
    stageName: row.p.status === 'cancelled' ? 'لغو شده' : STAGES[row.p.stage],
    myRole: iAmClient ? 'client' : 'provider',
    client: strip(row.client),
    provider: strip(row.provider),
    other: strip(iAmClient ? row.provider : row.client),
    // ستاره‌ای که من به طرف مقابل داده‌ام (null = هنوز نداده‌ام)
    myRating: myRating ?? null,
    // کارت خانه: پول دریافت‌شده (تأیید طرف مقابل) و در انتظار تأیید، آخرین گزارش روزانه
    paid: sum.paid,
    paidPending: sum.pending,
    lastReport: sum.lastReport,
    // دکمه‌های مجاز برای کاربر فعلی
    can: {
      start: row.p.status === 'active' && row.p.stage === 1,
      finish: row.p.status === 'active' && row.p.stage === 2 && iAmClient,
      progress: row.p.status === 'active' && !iAmClient,
      cancel: row.p.status === 'active' && row.p.stage < 3,
      review: row.p.status === 'done' && !reviewed,
    },
  };
}
async function myReviewed(userId: string, projectIds: string[]) {
  if (!projectIds.length) return new Map<string, number>();
  const mine = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId));
  const rows = await db
    .select({ projectId: reviews.projectId, rating: reviews.rating })
    .from(reviews)
    .where(and(inArray(reviews.projectId, projectIds), inArray(reviews.fromProfileId, mine)));
  return new Map(rows.map((x) => [x.projectId!, x.rating]));
}

/** پروژه‌های من؛ با ?role= فقط پروژه‌های یک نقش */
r.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        role: z.enum(['worker', 'specialist', 'engineer', 'contractor', 'company', 'general']).optional(),
        status: z.enum(['active', 'done', 'cancelled']).optional(),
      }),
      req.query,
    );
    const mineQ = db
      .select({ id: profiles.id })
      .from(profiles)
      .where(q.role ? and(eq(profiles.userId, req.user!.id), eq(profiles.role, q.role)) : eq(profiles.userId, req.user!.id));
    const conds = [or(inArray(projects.clientProfileId, mineQ), inArray(projects.providerProfileId, mineQ))!];
    if (q.status) conds.push(eq(projects.status, q.status));
    const rows = await db
      .select({ p: projects, client: party(clientP), provider: party(providerP) })
      .from(projects)
      .innerJoin(clientP, eq(clientP.id, projects.clientProfileId))
      .innerJoin(providerP, eq(providerP.id, projects.providerProfileId))
      .where(and(...conds))
      .orderBy(sql`case ${projects.status} when 'active' then 0 when 'done' then 1 else 2 end`, desc(projects.updatedAt));
    const ids = rows.map((x) => x.p.id);
    const [reviewed, sums] = await Promise.all([myReviewed(req.user!.id, ids), summaries(ids)]);
    res.json({ items: rows.map((x) => shape(x, req.user!.id, reviewed.get(x.p.id), sums.get(x.p.id))) });
  }),
);

r.get(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const row = await load(req.user!.id, id);
    const [reviewed, sums, [ctr]] = await Promise.all([
      myReviewed(req.user!.id, [id]),
      summaries([id]),
      db.select({ status: contracts.status, number: contracts.number }).from(contracts).where(eq(contracts.projectId, id)).limit(1),
    ]);
    // contract: null = هنوز قرارداد تنظیم نشده
    res.json({ project: { ...shape(row, req.user!.id, reviewed.get(id), sums.get(id)), contract: ctr ?? null } });
  }),
);

async function afterChange(row: Awaited<ReturnType<typeof load>>, p: Project, actorUserId: string, sysText: string, title: string) {
  if (p.conversationId) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, p.conversationId)).limit(1);
    if (conv) {
      await db.update(conversations).set({ stage: p.stage }).where(eq(conversations.id, conv.id));
      await postMessage(conv, null, { kind: 'sys', body: sysText, projectId: p.id });
    }
  }
  const otherUser = row.client.userId === actorUserId ? row.provider.userId : row.client.userId;
  await notify(otherUser, { type: 'req', title, body: p.title, link: { screen: 'pdet', id: p.id } });
  emitTo([row.client.userId, row.provider.userId], { type: 'project', data: { project: p } });
}

/** شروع کار: توافق → در حال اجرا (هر دو طرف) */
r.post(
  '/:id/start',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const row = await load(req.user!.id, id);
    if (row.p.status !== 'active' || row.p.stage !== 1) throw conflict('این پروژه در مرحلهٔ «توافق» نیست', 'BAD_STAGE');
    const [p] = await db
      .update(projects)
      .set({ stage: 2, startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.stage, 1)))
      .returning();
    if (!p) throw conflict('وضعیت پروژه عوض شده؛ دوباره باز کن', 'BAD_STAGE');
    await afterChange(row, p, req.user!.id, 'کار شروع شد؛ مرحله: در حال اجرا.', 'کار پروژه شروع شد');
    res.json({ project: shape({ ...row, p }, req.user!.id, undefined) });
  }),
);

/** پایان کار: فقط کارفرما تأیید می‌کند → «تمام» و +۱ پروژهٔ انجام‌شده برای هر دو */
r.post(
  '/:id/finish',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const row = await load(req.user!.id, id);
    if (row.client.userId !== req.user!.id) throw forbidden('پایان کار را کارفرما تأیید می‌کند', 'CLIENT_ONLY');
    if (row.p.status !== 'active' || row.p.stage !== 2) throw conflict('این پروژه در حال اجرا نیست', 'BAD_STAGE');
    const p = await db.transaction(async (tx) => {
      const [np] = await tx
        .update(projects)
        .set({ stage: 3, status: 'done', finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(projects.id, id), eq(projects.stage, 2)))
        .returning();
      if (!np) throw conflict('وضعیت پروژه عوض شده؛ دوباره باز کن', 'BAD_STAGE');
      await tx
        .update(profiles)
        .set({ doneCount: sql`${profiles.doneCount} + 1` })
        .where(inArray(profiles.id, [np.clientProfileId, np.providerProfileId]));
      return np;
    });
    await afterChange(row, p, req.user!.id, 'کار تمام شد و کارفرما تأیید کرد. حالا می‌توانید به هم امتیاز بدهید.', 'پروژه تمام شد؛ امتیاز بده');
    res.json({ project: shape({ ...row, p }, req.user!.id, undefined) });
  }),
);

r.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'دلیل لغو را بنویس').max(500) }), req.body);
    const row = await load(req.user!.id, id);
    if (row.p.status !== 'active') throw conflict('این پروژه فعال نیست', 'BAD_STAGE');
    const [p] = await db
      .update(projects)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.status, 'active')))
      .returning();
    if (!p) throw conflict('وضعیت پروژه عوض شده', 'BAD_STAGE');
    await voidPendingContract(id);
    await afterChange(row, p, req.user!.id, `پروژه لغو شد. دلیل: ${reason}`, 'پروژه لغو شد');
    res.json({ project: shape({ ...row, p }, req.user!.id, undefined) });
  }),
);

/**
 * پیشرفت کار: مجری فهرست کار (واحدها یا مراحل) را تیک می‌زند یا ویرایش می‌کند؛ کارفرما فقط می‌بیند.
 * تیک تازه ← پیام سیستمی در چت و اعلان برای کارفرما.
 */
r.put(
  '/:id/progress',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({ items: z.array(z.object({ t: z.string().trim().min(1).max(60), done: z.boolean() })).max(30) }),
      req.body,
    );
    const row = await load(req.user!.id, id);
    if (row.provider.userId !== req.user!.id) throw forbidden('پیشرفت کار را مجری ثبت می‌کند؛ تو می‌توانی ببینی', 'PROVIDER_ONLY');
    if (row.p.status !== 'active') throw conflict('این پروژه فعال نیست', 'BAD_STAGE');
    const before = new Map(row.p.progress.map((x) => [x.t, x]));
    const now = new Date().toISOString();
    const items = body.items.map((x) => ({ t: x.t, done: x.done, at: x.done ? (before.get(x.t)?.done ? before.get(x.t)!.at ?? now : now) : null }));
    const fresh = items.filter((x) => x.done && !before.get(x.t)?.done);
    const [p] = await db.update(projects).set({ progress: items, updatedAt: new Date() }).where(eq(projects.id, id)).returning();
    if (fresh.length) {
      const n = items.filter((x) => x.done).length;
      await afterChange(row, p, req.user!.id, `پیشرفت کار: «${fresh.map((x) => x.t).join('، ')}» تمام شد (${faDigits(n)} از ${faDigits(items.length)}).`, 'پیشرفت تازه در پروژه');
    } else emitTo([row.client.userId, row.provider.userId], { type: 'project', data: { project: p } });
    res.json({ project: shape({ ...row, p }, req.user!.id, undefined) });
  }),
);

/** نظر و امتیاز: فقط بعد از پروژهٔ تمام‌شده، هر طرف یک بار */
r.post(
  '/:id/review',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ rating: z.number().int().min(1).max(5), text: z.string().trim().max(1000).optional() }), req.body);
    const row = await load(req.user!.id, id);
    if (row.p.status !== 'done') throw badRequest('امتیاز فقط بعد از تمام شدن پروژه ثبت می‌شود', 'NOT_DONE');
    const iAmClient = row.client.userId === req.user!.id;
    const from = iAmClient ? row.client : row.provider;
    const to = iAmClient ? row.provider : row.client;
    const review = await db.transaction(async (tx) => {
      const [rv] = await tx
        .insert(reviews)
        .values({ projectId: id, fromProfileId: from.id, toProfileId: to.id, rating: body.rating, text: body.text || null })
        .onConflictDoNothing()
        .returning();
      if (!rv) throw conflict('برای این پروژه قبلاً امتیاز داده‌اید', 'ALREADY_REVIEWED');
      await tx
        .update(profiles)
        .set({
          ratingAvg: sql`(${profiles.ratingAvg} * ${profiles.ratingCount} + ${body.rating}) / (${profiles.ratingCount} + 1)`,
          ratingCount: sql`${profiles.ratingCount} + 1`,
        })
        .where(eq(profiles.id, to.id));
      return rv;
    });
    await notify(to.userId, {
      type: 'star',
      title: `${from.name} به شما ${body.rating} ستاره داد`,
      body: body.text?.slice(0, 120),
      link: { screen: 'trust' },
    });
    res.status(201).json({ review });
  }),
);

export default r;
