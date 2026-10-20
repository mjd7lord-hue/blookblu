import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { ads, guarantees, profiles, projects, strikes, users } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { requireAuth } from '../../middlewares/auth';
import { notify } from '../notifications/notify';
import { logger } from '../../lib/logger';

/**
 * قانون بدقولی (دور ۳۶):
 * - طرف مقابل «سر کار نیامد/بدقولی» ثبت می‌کند ← متهم ۲۴ ساعت فرصت دارد قبول یا اعتراض کند؛ بی‌جواب = قبول.
 * - اعتراض ← مدیر بررسی می‌کند (یا حل اختلاف).
 * - لغو یک‌طرفه بعد از امضای قرارداد = اخطار فوری برای لغوکننده؛ لغو با توافق دوطرف = بدون اخطار.
 * - هر اخطار تأییدشده: −۱۰ امتیاز اعتبار به مدت ۶ ماه؛ قیم‌های او هر کدام −۵.
 * - ۲ اخطار در ۹۰ روز: «آماده به کار» و نیروی فوری ۷ روز بسته · ۳ اخطار فعال: حساب معلق تا بررسی مدیر.
 */
export const STRIKE = { penalty: 10, guarantorPenalty: 5, guarantorBonus: 5, replyHours: 24, months: 6, restrictDays: 7, restrictAfter: 2, suspendAfter: 3 };

export const KIND_FA: Record<string, string> = { no_show: 'سر کار نیامد', cancel: 'لغو یک‌طرفهٔ قرارداد', breach: 'عمل نکردن به قرارداد' };

/** اصلاح امتیاز اعتبار پروفایل‌ها (بدون ورودی = همهٔ پروفایل‌هایی که اثری دارند یا داشته‌اند) */
export async function recomputeTrust(profileIds?: string[]) {
  if (profileIds && !profileIds.length) return;
  const adj = sql`(
    (case when exists (select 1 from guarantees g where g.profile_id = "profiles"."id" and g.status = 'accepted') then ${STRIKE.guarantorBonus} else 0 end)
    - ${STRIKE.penalty} * (select count(*) from strikes s where s.profile_id = "profiles"."id" and s.status = 'confirmed' and s.expires_at > now())
    - ${STRIKE.guarantorPenalty} * (select count(*) from strikes s join guarantees g on g.profile_id = s.profile_id and g.status = 'accepted' and g.responded_at <= s.created_at
        where g.guarantor_user_id = "profiles"."user_id" and s.status = 'confirmed' and s.expires_at > now())
  )::smallint`;
  const where = profileIds
    ? inArray(profiles.id, profileIds)
    : sql`(${profiles.trustAdj} <> 0 or exists (select 1 from guarantees g where g.profile_id = "profiles"."id" and g.status = 'accepted'))`;
  await db.update(profiles).set({ trustAdj: adj }).where(where);
}

/** پروفایل‌های قیم‌های یک پروفایل (برای بازحساب بعد از اخطار) */
async function guarantorProfiles(profileId: string) {
  const rows = await db
    .select({ id: profiles.id, userId: profiles.userId })
    .from(guarantees)
    .innerJoin(profiles, eq(profiles.userId, guarantees.guarantorUserId))
    .where(and(eq(guarantees.profileId, profileId), eq(guarantees.status, 'accepted')));
  return rows;
}

/** ثبت قطعی اخطار + پیامدها */
export async function confirmStrike(id: string, decidedBy?: string) {
  const [s] = await db
    .update(strikes)
    .set({ status: 'confirmed', decidedAt: new Date(), decidedBy: decidedBy ?? null, expiresAt: new Date(Date.now() + STRIKE.months * 30 * 86400_000) })
    .where(and(eq(strikes.id, id), inArray(strikes.status, ['pending', 'disputed'])))
    .returning();
  if (!s) return null;
  const [p] = await db.select({ id: profiles.id, userId: profiles.userId, name: profiles.displayName }).from(profiles).where(eq(profiles.id, s.profileId)).limit(1);
  if (!p) return s;
  const gs = await guarantorProfiles(p.id);
  await recomputeTrust([p.id, ...gs.map((g) => g.id)]);

  const [{ recent, active }] = await db
    .select({
      recent: sql<number>`count(*) filter (where ${strikes.createdAt} > now() - interval '90 days')::int`,
      active: sql<number>`count(*)::int`,
    })
    .from(strikes)
    .where(and(eq(strikes.profileId, p.id), eq(strikes.status, 'confirmed'), gt(strikes.expiresAt, new Date())));

  let extra = `${STRIKE.penalty} امتیاز از اعتبارت کم شد (تا ${STRIKE.months} ماه).`;
  if (active >= STRIKE.suspendAfter) {
    await db.update(users).set({ status: 'suspended', updatedAt: new Date() }).where(eq(users.id, p.userId));
    extra += ' به‌خاطر ۳ اخطار، حساب تا بررسی مدیر معلق شد.';
  } else if (recent >= STRIKE.restrictAfter) {
    await db.update(profiles).set({ restrictedUntil: new Date(Date.now() + STRIKE.restrictDays * 86400_000) }).where(eq(profiles.id, p.id));
    await db.update(ads).set({ status: 'closed', updatedAt: new Date() }).where(and(eq(ads.profileId, p.id), eq(ads.type, 'work'), eq(ads.status, 'active')));
    extra += ` به‌خاطر ۲ اخطار در ۹۰ روز، «آماده به کار» و نیروی فوری ${STRIKE.restrictDays} روز بسته شد.`;
  }
  await notify(p.userId, { type: 'id', title: `اخطار بدقولی ثبت شد: ${KIND_FA[s.kind]}`, body: extra, link: { screen: 'trust' } });
  for (const g of new Map(gs.map((x) => [x.userId, x])).values()) {
    await notify(g.userId, {
      type: 'id',
      title: `${p.name} که قیمش هستی اخطار بدقولی گرفت`,
      body: `${STRIKE.guarantorPenalty} امتیاز از اعتبار تو هم کم شد. اگر دیگر ضمانتش نمی‌کنی، در «قیم‌ها» ضمانت را پس بگیر.`,
      link: { screen: 'guar' },
    });
  }
  return s;
}

/** اخطارهای بی‌جواب بعد از ۲۴ ساعت قطعی می‌شوند؛ اخطارهای منقضی از امتیاز برمی‌گردند */
export async function sweepStrikes() {
  const due = await db
    .select({ id: strikes.id })
    .from(strikes)
    .where(and(eq(strikes.status, 'pending'), lt(strikes.respondBy, new Date())));
  for (const d of due) await confirmStrike(d.id);
  await recomputeTrust();
}

let timer: NodeJS.Timeout | undefined;
export function startStrikeSweeper() {
  if (timer) return;
  timer = setInterval(() => sweepStrikes().catch((e) => logger.warn({ e }, 'strike sweep failed')), 15 * 60_000);
  timer.unref();
}

/** ثبت اخطار تازه (از پروژه) */
export async function openStrike(input: { profileId: string; userId: string; byProfileId: string | null; projectId: string; kind: 'no_show' | 'cancel' | 'breach'; note?: string | null; immediate?: boolean }) {
  const [dup] = await db
    .select({ id: strikes.id })
    .from(strikes)
    .where(and(eq(strikes.projectId, input.projectId), eq(strikes.profileId, input.profileId), inArray(strikes.status, ['pending', 'disputed', 'confirmed'])))
    .limit(1);
  if (dup) throw conflict('برای این پروژه قبلاً بدقولی این طرف ثبت شده', 'STRIKE_EXISTS');
  const [s] = await db
    .insert(strikes)
    .values({
      profileId: input.profileId,
      byProfileId: input.byProfileId,
      projectId: input.projectId,
      kind: input.kind,
      note: input.note ?? null,
      respondBy: new Date(Date.now() + STRIKE.replyHours * 3600_000),
    })
    .returning();
  if (input.immediate) return (await confirmStrike(s.id)) ?? s;
  await notify(input.userId, {
    type: 'id',
    title: `بدقولی برایت ثبت شد: ${KIND_FA[input.kind]}`,
    body: `۲۴ ساعت فرصت داری قبول یا اعتراض کنی؛ بی‌جواب بماند، اخطار ثبت می‌شود و ${STRIKE.penalty} امتیاز از اعتبارت کم می‌شود.`,
    link: { screen: 'strikes' },
  });
  return s;
}

/** خلاصهٔ بدقولی برای پروفایل عمومی */
export async function strikeCount(profileId: string) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(strikes)
    .where(and(eq(strikes.profileId, profileId), eq(strikes.status, 'confirmed'), gt(strikes.expiresAt, new Date())));
  return n;
}

/** مسدود بودن «آماده به کار» و نیروی فوری */
export function assertNotRestricted(p: { restrictedUntil: Date | null }) {
  if (p.restrictedUntil && p.restrictedUntil > new Date()) {
    throw forbidden(
      `به‌خاطر اخطار بدقولی، «آماده به کار» تا ${p.restrictedUntil.toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })} بسته است`,
      'RESTRICTED',
    );
  }
}

/* ---------- /api/strikes ---------- */
export const strikesRouter = Router();
strikesRouter.use(requireAuth);

/** اخطارهای من (همهٔ نقش‌ها) و آنچه من برای دیگران ثبت کرده‌ام */
strikesRouter.get(
  '/',
  ah(async (req, res) => {
    const mine = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, req.user!.id));
    const ids = mine.map((p) => p.id);
    if (!ids.length) return res.json({ against: [], byMe: [], rules: STRIKE });
    const cols = {
      id: strikes.id,
      kind: strikes.kind,
      status: strikes.status,
      note: strikes.note,
      reply: strikes.reply,
      respondBy: strikes.respondBy,
      expiresAt: strikes.expiresAt,
      createdAt: strikes.createdAt,
      projectId: strikes.projectId,
      project: projects.title,
    };
    const against = await db
      .select({ ...cols, by: profiles.displayName })
      .from(strikes)
      .leftJoin(projects, eq(projects.id, strikes.projectId))
      .leftJoin(profiles, eq(profiles.id, strikes.byProfileId))
      .where(inArray(strikes.profileId, ids))
      .orderBy(desc(strikes.createdAt))
      .limit(50);
    const byMe = await db
      .select({ ...cols, to: profiles.displayName })
      .from(strikes)
      .leftJoin(projects, eq(projects.id, strikes.projectId))
      .leftJoin(profiles, eq(profiles.id, strikes.profileId))
      .where(inArray(strikes.byProfileId, ids))
      .orderBy(desc(strikes.createdAt))
      .limit(50);
    res.json({ against, byMe, rules: STRIKE });
  }),
);

/** جواب متهم: قبول (اخطار ثبت می‌شود) یا اعتراض (مدیر بررسی می‌کند) */
strikesRouter.post(
  '/:id/respond',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ accept: z.boolean(), reply: z.string().trim().max(600).optional() }), req.body);
    const [row] = await db
      .select({ s: strikes, userId: profiles.userId })
      .from(strikes)
      .innerJoin(profiles, eq(profiles.id, strikes.profileId))
      .where(eq(strikes.id, id))
      .limit(1);
    if (!row || row.userId !== req.user!.id) throw notFound('پیدا نشد');
    if (row.s.status !== 'pending') throw conflict('به این مورد قبلاً جواب داده شده', 'ALREADY_ANSWERED');
    if (!body.accept && (!body.reply || body.reply.length < 5)) throw conflict('برای اعتراض توضیح بنویس چه شد', 'REPLY_REQUIRED');
    if (body.accept) {
      await db.update(strikes).set({ reply: body.reply ?? null }).where(eq(strikes.id, id));
      const s = await confirmStrike(id);
      return res.json({ strike: s });
    }
    const [s] = await db.update(strikes).set({ status: 'disputed', reply: body.reply! }).where(and(eq(strikes.id, id), eq(strikes.status, 'pending'))).returning();
    if (!s) throw conflict('به این مورد قبلاً جواب داده شده', 'ALREADY_ANSWERED');
    if (s.byProfileId) {
      const [by] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.id, s.byProfileId)).limit(1);
      if (by) await notify(by.userId, { type: 'id', title: 'به بدقولی ثبت‌شده اعتراض شد', body: 'مدیر بلوک بررسی می‌کند و نتیجه را خبر می‌دهیم.', link: { screen: 'strikes' } });
    }
    res.json({ strike: s });
  }),
);
