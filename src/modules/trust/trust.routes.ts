import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { guarantees, profiles, strikes, users } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { cfg } from '../../lib/appConfig';
import { normalizePhone, maskPhone, toLatinDigits } from '../../lib/text';
import { requireAuth, requireProfile } from '../../middlewares/auth';
import { notify } from '../notifications/notify';
import { consumeCode, sendOtp } from '../auth/auth.service';
import { trustOf } from '../profiles/profiles.service';
import { recomputeTrust, STRIKE } from './strikes';

/*
 * قیم (ضامن) — دور ۳۶:
 * قیم کسی است که خودش در بلوک خوش‌سابقه است و با کد پیامکی تضمین می‌کند «این فرد را می‌شناسم و خوش‌قول است».
 * شرط‌ها (قابل تغییر در پنل: limits): هویت تأییدشده، حداقل ۳ پروژهٔ تمام‌شده، اعتبار ۷۰+، ۳۰ روز سابقهٔ حساب،
 * بدون اخطار بدقولی فعال، حداکثر ۵ ضمانت.
 * اثر: فرد +۵ امتیاز اعتبار و نشان قیم؛ اگر فرد بدقولی کند، قیم ۵ امتیاز از دست می‌دهد.
 */
export const guaranteesRouter = Router();

export type GuarantorCheck = { ok: boolean; reasons: string[]; stats: { done: number; trust: number; days: number; active: number; max: number; kyc: boolean; strikes: number } };

/** آیا این کاربر می‌تواند قیم باشد؟ (دلیل‌ها به فارسی برای نمایش) */
export async function guarantorCheck(userId: string): Promise<GuarantorCheck> {
  const L = cfg('limits');
  const [u] = await db.select({ kyc: users.kycStatus, createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1);
  const ps = await db.select().from(profiles).where(eq(profiles.userId, userId));
  const kyc = u?.kyc === 'verified';
  const done = ps.reduce((n, p) => n + p.doneCount, 0);
  const trust = ps.reduce((m, p) => Math.max(m, trustOf(p, kyc).total), 0);
  const days = u ? Math.floor((Date.now() - u.createdAt.getTime()) / 86400_000) : 0;
  const [{ active }] = await db
    .select({ active: sql<number>`count(*)::int` })
    .from(guarantees)
    .where(and(eq(guarantees.guarantorUserId, userId), eq(guarantees.status, 'accepted')));
  const ids = ps.map((p) => p.id);
  const [{ st }] = ids.length
    ? await db
        .select({ st: sql<number>`count(*)::int` })
        .from(strikes)
        .where(and(inArray(strikes.profileId, ids), eq(strikes.status, 'confirmed'), gt(strikes.expiresAt, new Date())))
    : [{ st: 0 }];
  const reasons: string[] = [];
  if (!kyc) reasons.push('هویتش تأیید نشده');
  if (done < L.guarMinDone) reasons.push(`کمتر از ${L.guarMinDone} پروژهٔ تمام‌شده دارد`);
  if (trust < L.guarMinTrust) reasons.push(`امتیاز اعتبارش کمتر از ${L.guarMinTrust} است`);
  if (days < L.guarMinDays) reasons.push(`کمتر از ${L.guarMinDays} روز در بلوک است`);
  if (st > 0) reasons.push('اخطار بدقولی فعال دارد');
  if (active >= L.guarMax) reasons.push(`ظرفیت ضمانتش (${L.guarMax} نفر) پر است`);
  return { ok: !reasons.length, reasons, stats: { done, trust, days, active, max: L.guarMax, kyc, strikes: st } };
}

const guarCtx = (id: string) => `guar:${id}`;

guaranteesRouter.get(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const mine = await db
      .select({
        id: guarantees.id,
        name: guarantees.guarantorName,
        relation: guarantees.relation,
        phone: guarantees.guarantorPhone,
        status: guarantees.status,
        createdAt: guarantees.createdAt,
      })
      .from(guarantees)
      .where(eq(guarantees.profileId, req.profile!.id))
      .orderBy(desc(guarantees.createdAt));
    // درخواست‌هایی که دیگران از من برای ضمانت کرده‌اند
    const incoming = await db
      .select({
        id: guarantees.id,
        relation: guarantees.relation,
        status: guarantees.status,
        createdAt: guarantees.createdAt,
        from: { code: profiles.code, name: profiles.displayName, role: profiles.role, title: profiles.title },
      })
      .from(guarantees)
      .innerJoin(profiles, eq(profiles.id, guarantees.profileId))
      .where(eq(guarantees.guarantorPhone, req.user!.phone))
      .orderBy(desc(guarantees.createdAt));
    const L = cfg('limits');
    res.json({
      mine: mine.map((g) => ({ ...g, phone: maskPhone(g.phone) })),
      incoming,
      // من می‌توانم قیم دیگران باشم؟
      eligibility: await guarantorCheck(req.user!.id),
      rules: { minDone: L.guarMinDone, minTrust: L.guarMinTrust, minDays: L.guarMinDays, max: L.guarMax, bonus: STRIKE.guarantorBonus, penalty: STRIKE.guarantorPenalty },
    });
  }),
);

guaranteesRouter.post(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        relation: z.string().trim().max(120).default('آشنا'),
        phone: z.string(),
      }),
      req.body,
    );
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('شمارهٔ موبایل قیم معتبر نیست', 'BAD_PHONE');
    if (phone === req.user!.phone) throw badRequest('خودتان نمی‌توانید قیم خودتان باشید', 'SELF_GUARANTEE');
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(guarantees)
      .where(eq(guarantees.profileId, req.profile!.id));
    if (n >= 5) throw badRequest('حداکثر ۵ قیم می‌توانید داشته باشید', 'GUARANTEE_LIMIT');

    const [gu] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).limit(1);
    if (!gu) throw badRequest('قیم باید خودش عضو بلوک باشد. اول از او بخواه در بلوک ثبت‌نام کند.', 'GUARANTOR_NOT_MEMBER');
    const chk = await guarantorCheck(gu.id);
    if (!chk.ok) throw badRequest(`این شخص هنوز نمی‌تواند قیم باشد: ${chk.reasons.join('، ')}`, 'GUARANTOR_NOT_ELIGIBLE', { reasons: chk.reasons });

    const [g] = await db
      .insert(guarantees)
      .values({
        profileId: req.profile!.id,
        guarantorPhone: phone,
        guarantorUserId: gu.id,
        guarantorName: body.name,
        relation: body.relation || 'آشنا',
      })
      .onConflictDoNothing()
      .returning();
    if (!g) throw conflict('از این شماره قبلاً درخواست ضمانت کرده‌اید', 'GUARANTEE_EXISTS');
    await notify(gu.id, {
      type: 'id',
      title: 'درخواست قیم شدن',
      body: `${req.profile!.displayName} از شما خواسته ضامن خوش‌قولی‌اش باشید`,
      link: { screen: 'guar' },
    });
    res.status(201).json({ guarantee: { ...g, guarantorPhone: maskPhone(g.guarantorPhone) }, invited: false });
  }),
);

async function incomingFor(id: string, phone: string) {
  const [g] = await db.select().from(guarantees).where(eq(guarantees.id, id)).limit(1);
  if (!g || g.guarantorPhone !== phone) throw notFound('درخواست پیدا نشد');
  return g;
}

/** کد پیامکی تأیید ضمانت به موبایل قیم */
guaranteesRouter.post(
  '/:id/code',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const g = await incomingFor(id, req.user!.phone);
    if (g.status !== 'pending') throw conflict('به این درخواست قبلاً جواب داده‌اید', 'ALREADY_ANSWERED');
    const chk = await guarantorCheck(req.user!.id);
    if (!chk.ok) throw badRequest(`هنوز نمی‌توانی قیم باشی: ${chk.reasons.join('، ')}`, 'GUARANTOR_NOT_ELIGIBLE', { reasons: chk.reasons });
    const r = await sendOtp(req.user!.phone, req.ip, { kind: 'sign', ctx: guarCtx(id) });
    res.json({ sent: true, expiresIn: r.expiresIn, resendIn: r.resendIn, ...(r.devCode ? { devCode: r.devCode } : {}) });
  }),
);

/** جواب قیم: قبول (با کد پیامکی) یا رد */
guaranteesRouter.patch(
  '/:id',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        status: z.enum(['accepted', 'rejected']),
        code: z
          .string()
          .transform((v) => toLatinDigits(v).trim())
          .optional(),
      }),
      req.body,
    );
    const g = await incomingFor(id, req.user!.phone);
    if (g.status !== 'pending') throw conflict('به این درخواست قبلاً جواب داده‌اید', 'ALREADY_ANSWERED');
    if (body.status === 'accepted') {
      const chk = await guarantorCheck(req.user!.id);
      if (!chk.ok) throw badRequest(`هنوز نمی‌توانی قیم باشی: ${chk.reasons.join('، ')}`, 'GUARANTOR_NOT_ELIGIBLE', { reasons: chk.reasons });
      if (!body.code) throw badRequest('کد پیامکی تأیید ضمانت را بزن', 'CODE_REQUIRED');
      await consumeCode(req.user!.phone, body.code, { kind: 'sign', ctx: guarCtx(id) });
    }
    const [ng] = await db
      .update(guarantees)
      .set({ status: body.status, respondedAt: new Date(), guarantorUserId: req.user!.id })
      .where(and(eq(guarantees.id, id), eq(guarantees.status, 'pending')))
      .returning();
    if (!ng) throw conflict('به این درخواست قبلاً جواب داده‌اید', 'ALREADY_ANSWERED');
    const [owner] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.id, g.profileId)).limit(1);
    if (owner && body.status === 'accepted') {
      await recomputeTrust([g.profileId]);
      await notify(owner.userId, { type: 'id', title: `${g.guarantorName} قیم شما شد`, body: `${STRIKE.guarantorBonus} امتیاز به اعتبارت اضافه شد.`, link: { screen: 'guar' } });
    }
    res.json({ guarantee: { ...ng, guarantorPhone: maskPhone(ng.guarantorPhone) } });
  }),
);

/** قیم ضمانتش را پس می‌گیرد */
guaranteesRouter.post(
  '/:id/revoke',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const g = await incomingFor(id, req.user!.phone);
    if (g.status !== 'accepted') throw conflict('این ضمانت فعال نیست', 'NOT_ACTIVE');
    await db.update(guarantees).set({ status: 'rejected', respondedAt: new Date() }).where(eq(guarantees.id, id));
    await recomputeTrust([g.profileId]);
    const [owner] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.id, g.profileId)).limit(1);
    if (owner) await notify(owner.userId, { type: 'id', title: `${g.guarantorName} ضمانتش را پس گرفت`, link: { screen: 'guar' } });
    res.json({ ok: true });
  }),
);

guaranteesRouter.delete(
  '/:id',
  requireProfile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const del = await db
      .delete(guarantees)
      .where(and(eq(guarantees.id, id), eq(guarantees.profileId, req.profile!.id)))
      .returning({ id: guarantees.id });
    if (!del.length) throw notFound('پیدا نشد');
    await recomputeTrust([req.profile!.id]);
    res.json({ ok: true });
  }),
);
