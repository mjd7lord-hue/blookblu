/**
 * /api/urgent — «نیروی فوری» (مثل درخواست اسنپ):
 * کارفرما یک درخواست می‌فرستد ← به نیروهای «آماده به کار» (آگهی work فعال) همان استان و مهارت می‌رسد (اعلان + رویداد لحظه‌ای)
 * ← اولین‌ها که قبول کنند برنده‌اند: گفت‌وگو + توافق با همان شرایط + پروژه خودکار ساخته می‌شود و آگهی آمادگی‌شان خاموش می‌شود.
 * وقتی تعداد لازم پر شد بقیه «دیر رسیدی» می‌گیرند. درخواست بعد از limits.urgentHours ساعت منقضی می‌شود.
 */
import { assertNotRestricted } from '../trust/strikes';
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { ads, profiles, profileSkills, urgentOffers, urgentRequests, users, type Role } from '../../db/schema';
import { ah, moneyInput, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { emitTo } from '../../lib/events';
import { cfg } from '../../lib/appConfig';
import { faMoney, normalizeFa } from '../../lib/text';
import { requireAuth, requireProfile } from '../../middlewares/auth';
import { notify } from '../notifications/notify';
import { answerProposal, ensureConversation, postMessage, proposeDeal } from '../chat/chat.service';
import { blockedIds } from '../profiles/profiles.service';
import { authorCols, shapeAuthor } from '../ads/ads.service';

const r = Router();
r.use(requireAuth);

const CLIENT_ROLES: Role[] = ['general', 'contractor', 'company', 'engineer'];
const TARGET_ROLES = ['worker', 'specialist'] as const;
const faDigits = (n: number) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
const lim = () => {
  const l = cfg('limits') as { urgentHours?: number; urgentMaxSend?: number; urgentOpen?: number };
  return { hours: l.urgentHours ?? 3, maxSend: l.urgentMaxSend ?? 30, open: l.urgentOpen ?? 3 };
};

/** درخواست‌های بازِ تاریخ‌گذشته ← expired؛ پیشنهادهای بی‌جواب ← missed */
async function sweep() {
  const old = await db
    .update(urgentRequests)
    .set({ status: 'expired' })
    .where(and(eq(urgentRequests.status, 'open'), lt(urgentRequests.expiresAt, new Date())))
    .returning({ id: urgentRequests.id });
  if (old.length) await closeOffers(old.map((x) => x.id));
}
/** پیشنهادهای بی‌جواب یک درخواستِ بسته‌شده ← missed و خبر لحظه‌ای به گیرنده‌ها */
async function closeOffers(requestIds: string[]) {
  const rows = await db
    .update(urgentOffers)
    .set({ status: 'missed', respondedAt: new Date() })
    .where(and(inArray(urgentOffers.requestId, requestIds), eq(urgentOffers.status, 'sent')))
    .returning({ profileId: urgentOffers.profileId, requestId: urgentOffers.requestId });
  if (!rows.length) return;
  const us = await db.select({ userId: profiles.userId }).from(profiles).where(inArray(profiles.id, rows.map((x) => x.profileId)));
  emitTo(us.map((x) => x.userId), { type: 'urgent', data: { closed: requestIds } });
}

const reqBody = z.object({
  title: z.string().trim().min(3, 'بنویس چه کاری است').max(120),
  skill: z.string().trim().max(60).nullish(),
  roles: z.array(z.enum(TARGET_ROLES)).min(1).max(2).default(['worker']),
  needCount: z.number().int().min(1).max(10).default(1),
  startWhen: z.string().trim().min(2).max(60),
  dailyWage: moneyInput.refine((n) => n !== null && n >= 100000, 'دستمزد روزانه را بنویس'),
  days: z.number().int().min(1).max(60).default(1),
  note: z.string().trim().max(500).nullish(),
  province: z.string().trim().max(60).nullish(),
  city: z.string().trim().max(60).nullish(),
});

/** نیروهای آماده به کار که این درخواست به آن‌ها می‌رسد (هر نفر یک بار، هم‌شهری‌ها اول) */
async function matches(me: { id: string; userId: string }, q: { roles: readonly string[]; province: string; city: string; skill?: string | null }, limit: number) {
  const blocked = await blockedIds(me.userId);
  const conds = [
    eq(ads.type, 'work'),
    eq(ads.status, 'active'),
    eq(ads.province, q.province),
    inArray(profiles.role, q.roles as Role[]),
    eq(users.status, 'active'),
    ne(profiles.userId, me.userId),
    // حساب‌های نمونه نیروی فوری نمی‌گیرند
    sql`${users.phone} not like '0900000%'`,
    // اخطار بدقولی: ۷ روز بدون نیروی فوری
    sql`(${profiles.restrictedUntil} is null or ${profiles.restrictedUntil} < now())`,
  ];
  if (blocked.length) conds.push(notInArray(profiles.userId, blocked));
  if (q.skill) {
    const s = normalizeFa(q.skill);
    conds.push(
      or(
        sql`${s} = any(${ads.skills})`,
        ilike(ads.title, `%${s}%`),
        sql`exists (select 1 from ${profileSkills} ps where ps.profile_id = ${profiles.id} and ps.title ilike ${'%' + s + '%'})`,
      )!,
    );
  }
  const rows = await db
    .selectDistinctOn([profiles.id], { profileId: profiles.id, userId: profiles.userId, adId: ads.id, sameCity: sql<boolean>`${ads.city} = ${q.city}`, rating: profiles.ratingAvg })
    .from(ads)
    .innerJoin(profiles, eq(profiles.id, ads.profileId))
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(...conds))
    .orderBy(profiles.id, desc(ads.updatedAt));
  // یک کاربر با چند نقش فقط یک پیشنهاد می‌گیرد
  const seen = new Set<string>();
  return rows
    .sort((a, b) => Number(b.sameCity) - Number(a.sameCity) || b.rating - a.rating)
    .filter((x) => (seen.has(x.userId) ? false : (seen.add(x.userId), true)))
    .slice(0, limit);
}
const placeOf = (me: { province: string; city: string }, b: { province?: string | null; city?: string | null }) => ({
  province: normalizeFa(b.province || me.province),
  city: normalizeFa(b.city || me.city),
});

/** پیش‌نمایش: چند نیروی آماده این درخواست را می‌بینند */
r.get(
  '/preview',
  requireProfile,
  ah(async (req, res) => {
    const q = parse(
      z.object({ roles: z.string().default('worker'), skill: z.string().max(60).optional(), province: z.string().max(60).optional(), city: z.string().max(60).optional() }),
      req.query,
    );
    const roles = q.roles.split(',').filter((x): x is (typeof TARGET_ROLES)[number] => (TARGET_ROLES as readonly string[]).includes(x));
    const m = await matches(req.profile!, { roles: roles.length ? roles : ['worker'], ...placeOf(req.profile!, q), skill: q.skill }, 500);
    res.json({ count: m.length, sameCity: m.filter((x) => x.sameCity).length });
  }),
);

r.post(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const me = req.profile!;
    if (!CLIENT_ROLES.includes(me.role)) throw forbidden('نیروی فوری برای کارفرما، پیمانکار، شرکت و مهندس است', 'NOT_CLIENT');
    const b = parse(reqBody, req.body);
    await sweep();
    const L = lim();
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(urgentRequests)
      .where(and(eq(urgentRequests.clientProfileId, me.id), eq(urgentRequests.status, 'open')));
    if (n >= L.open) throw conflict(`${faDigits(L.open)} درخواست فوری باز داری؛ صبر کن جواب بیاید یا یکی را لغو کن`, 'URGENT_LIMIT');
    const place = placeOf(me, b);
    const targets = await matches(me, { roles: b.roles, ...place, skill: b.skill }, L.maxSend);
    if (!targets.length) throw conflict('الان نیروی «آماده به کار» با این مهارت در استانت نیست. آگهی ثبت کن تا نیروها پیدایت کنند.', 'NO_READY');
    const [rq] = await db
      .insert(urgentRequests)
      .values({
        clientProfileId: me.id,
        title: normalizeFa(b.title),
        skill: b.skill ? normalizeFa(b.skill) : null,
        roles: b.roles,
        needCount: b.needCount,
        ...place,
        startWhen: b.startWhen,
        dailyWage: b.dailyWage!,
        days: b.days,
        note: b.note || null,
        sentCount: targets.length,
        expiresAt: new Date(Date.now() + L.hours * 3600e3),
      })
      .returning();
    await db.insert(urgentOffers).values(targets.map((t) => ({ requestId: rq.id, profileId: t.profileId, adId: t.adId })));
    const total = rq.dailyWage * rq.days;
    for (const t of targets) {
      await notify(t.userId, {
        type: 'req',
        title: `⚡ کار فوری: ${rq.title}`,
        body: `${rq.city}، ${rq.startWhen}، ${faMoney(rq.dailyWage)} تومان روزانه × ${faDigits(rq.days)} روز = ${faMoney(total)} تومان`,
        link: { screen: 'urgent', id: rq.id },
      });
    }
    emitTo(targets.map((t) => t.userId), { type: 'urgent', data: { offer: rq.id } });
    res.status(201).json({ request: { ...rq, total }, sentCount: targets.length });
  }),
);

/** درخواست‌های فوری من (کارفرما) با نفرهایی که قبول کرده‌اند */
r.get(
  '/mine',
  ah(async (req, res) => {
    await sweep();
    const mine = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, req.user!.id));
    const reqs = await db
      .select()
      .from(urgentRequests)
      .where(inArray(urgentRequests.clientProfileId, mine))
      .orderBy(desc(urgentRequests.createdAt))
      .limit(20);
    const ids = reqs.map((x) => x.id);
    const offers = ids.length
      ? await db
          .select({ o: urgentOffers, who: { ...authorCols, kyc: users.kycStatus } })
          .from(urgentOffers)
          .innerJoin(profiles, eq(profiles.id, urgentOffers.profileId))
          .innerJoin(users, eq(users.id, profiles.userId))
          .where(inArray(urgentOffers.requestId, ids))
      : [];
    res.json({
      items: reqs.map((rq) => {
        const L = offers.filter((x) => x.o.requestId === rq.id);
        const cnt = (s: string) => L.filter((x) => x.o.status === s).length;
        return {
          ...rq,
          total: rq.dailyWage * rq.days,
          counts: { sent: rq.sentCount, accepted: cnt('accepted'), declined: cnt('declined'), waiting: cnt('sent') },
          accepted: L.filter((x) => x.o.status === 'accepted').map((x) => ({ person: shapeAuthor(x.who), conversationId: x.o.conversationId, projectId: x.o.projectId, at: x.o.respondedAt })),
        };
      }),
    });
  }),
);

/** پیشنهادهای فوریِ باز برای من (نیروی آماده به کار) */
r.get(
  '/inbox',
  ah(async (req, res) => {
    await sweep();
    const mine = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, req.user!.id));
    const rows = await db
      .select({ o: urgentOffers, rq: urgentRequests, who: { ...authorCols, kyc: users.kycStatus } })
      .from(urgentOffers)
      .innerJoin(urgentRequests, eq(urgentRequests.id, urgentOffers.requestId))
      .innerJoin(profiles, eq(profiles.id, urgentRequests.clientProfileId))
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(and(inArray(urgentOffers.profileId, mine), eq(urgentOffers.status, 'sent'), eq(urgentRequests.status, 'open')))
      .orderBy(desc(urgentRequests.createdAt))
      .limit(20);
    res.json({
      items: rows.map((x) => ({
        id: x.rq.id,
        title: x.rq.title,
        skill: x.rq.skill,
        city: x.rq.city,
        province: x.rq.province,
        startWhen: x.rq.startWhen,
        dailyWage: x.rq.dailyWage,
        days: x.rq.days,
        total: x.rq.dailyWage * x.rq.days,
        needCount: x.rq.needCount,
        note: x.rq.note,
        expiresAt: x.rq.expiresAt,
        client: shapeAuthor(x.who),
      })),
    });
  }),
);

/** قبول: اگر هنوز جا هست ← گفت‌وگو + توافق (از طرف کارفرما با همان شرایط) + پذیرش ← پروژه */
r.post(
  '/:id/accept',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await sweep();
    const mine = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, req.user!.id));
    // رزرو جا در تراکنش با قفل ردیف درخواست (دو قبول همزمان از ظرفیت رد نمی‌شوند)
    const won = await db.transaction(async (tx) => {
      const [rq] = await tx.select().from(urgentRequests).where(eq(urgentRequests.id, id)).for('update').limit(1);
      if (!rq) throw notFound('درخواست پیدا نشد');
      const [of] = await tx
        .select()
        .from(urgentOffers)
        .where(and(eq(urgentOffers.requestId, id), inArray(urgentOffers.profileId, mine)))
        .limit(1);
      if (!of) throw notFound('این درخواست برای تو نیست');
      const [pf] = await tx.select({ restrictedUntil: profiles.restrictedUntil }).from(profiles).where(eq(profiles.id, of.profileId)).limit(1);
      if (pf) assertNotRestricted(pf);
      if (of.status === 'missed') throw conflict('دیر رسیدی؛ نفر دیگری زودتر قبول کرد یا درخواست بسته شد', 'URGENT_CLOSED');
      if (of.status !== 'sent') throw conflict('قبلاً جواب داده‌ای', 'ALREADY_ANSWERED');
      if (rq.status !== 'open') throw conflict('دیر رسیدی؛ نفر دیگری زودتر قبول کرد یا درخواست بسته شد', 'URGENT_CLOSED');
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(urgentOffers)
        .where(and(eq(urgentOffers.requestId, id), eq(urgentOffers.status, 'accepted')));
      if (n >= rq.needCount) throw conflict('دیر رسیدی؛ نفر دیگری زودتر قبول کرد', 'URGENT_CLOSED');
      await tx
        .update(urgentOffers)
        .set({ status: 'accepted', respondedAt: new Date() })
        .where(and(eq(urgentOffers.requestId, id), eq(urgentOffers.profileId, of.profileId)));
      const filled = n + 1 >= rq.needCount;
      if (filled) await tx.update(urgentRequests).set({ status: 'filled' }).where(eq(urgentRequests.id, id));
      return { rq, of, filled };
    });

    const { rq, of } = won;
    try {
      const [[client], [prov]] = await Promise.all([
        db.select().from(profiles).where(eq(profiles.id, rq.clientProfileId)).limit(1),
        db.select().from(profiles).where(eq(profiles.id, of.profileId)).limit(1),
      ]);
      const { conv, created } = await ensureConversation(client, prov, { adId: of.adId, title: rq.title });
      if (created) await postMessage(conv, null, { kind: 'sys', body: `این گفت‌وگو از «نیروی فوری» شروع شد: ${rq.title}` });
      const total = rq.dailyWage * rq.days;
      const deal = await proposeDeal(client.userId, conv.id, {
        job: rq.title,
        qty: `${faDigits(rq.days)} روز`,
        price: `${faMoney(rq.dailyWage)} تومان روزانه`,
        amount: total,
        start: rq.startWhen,
        durationDays: rq.days,
        plan: [{ title: 'پایان کار', pct: 100 }],
        retentionPct: 0,
        steps: rq.days <= 30 ? Array.from({ length: rq.days }, (_, i) => `روز ${faDigits(i + 1)}`) : [],
      });
      const { project } = await answerProposal(prov.userId, deal.id, 'accepted');
      await db
        .update(urgentOffers)
        .set({ conversationId: conv.id, projectId: project?.id ?? null })
        .where(and(eq(urgentOffers.requestId, id), eq(urgentOffers.profileId, of.profileId)));
      await notify(client.userId, {
        type: 'req',
        title: `⚡ ${prov.displayName} کار فوری را قبول کرد`,
        body: `${rq.title}؛ پروژه ساخته شد؛ قرارداد را امضا کنید`,
        link: project ? { screen: 'pdet', id: project.id } : { screen: 'chat', id: conv.id },
      });
      emitTo(client.userId, { type: 'urgent', data: { request: id } });
      if (won.filled) await closeOffers([id]);
      res.json({ ok: true, conversationId: conv.id, projectId: project?.id ?? null, filled: won.filled });
    } catch (e) {
      // ساخت گفت‌وگو/پروژه نشد ← جا آزاد می‌شود
      await db
        .update(urgentOffers)
        .set({ status: 'sent', respondedAt: null })
        .where(and(eq(urgentOffers.requestId, id), eq(urgentOffers.profileId, of.profileId)));
      if (won.filled) await db.update(urgentRequests).set({ status: 'open' }).where(eq(urgentRequests.id, id));
      throw e;
    }
  }),
);

r.post(
  '/:id/decline',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const mine = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, req.user!.id));
    const rows = await db
      .update(urgentOffers)
      .set({ status: 'declined', respondedAt: new Date() })
      .where(and(eq(urgentOffers.requestId, id), inArray(urgentOffers.profileId, mine), eq(urgentOffers.status, 'sent')))
      .returning({ requestId: urgentOffers.requestId });
    if (!rows.length) throw notFound('پیشنهاد بازی پیدا نشد');
    const [rq] = await db
      .select({ userId: profiles.userId })
      .from(urgentRequests)
      .innerJoin(profiles, eq(profiles.id, urgentRequests.clientProfileId))
      .where(eq(urgentRequests.id, id))
      .limit(1);
    if (rq) emitTo(rq.userId, { type: 'urgent', data: { request: id } });
    res.json({ ok: true });
  }),
);

r.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const mine = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, req.user!.id));
    const [rq] = await db
      .update(urgentRequests)
      .set({ status: 'cancelled' })
      .where(and(eq(urgentRequests.id, id), inArray(urgentRequests.clientProfileId, mine), eq(urgentRequests.status, 'open')))
      .returning();
    if (!rq) throw badRequest('درخواست باز پیدا نشد', 'NOT_OPEN');
    await closeOffers([id]);
    res.json({ request: rq });
  }),
);

export default r;
