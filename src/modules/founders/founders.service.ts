/**
 * کمپین «۱۰۰ عضو بنیان‌گذار» (دور ۵۴)
 *   مرحله ۱: «فالو کردم» (بدون بررسی؛ زمان کلیک ذخیره می‌شود)
 *   مرحله ۲: احراز هویت (users.kyc_status = verified)
 *   مرحله ۳: دست‌کم یک دوست با لینک دعوت ثبت‌نام کامل کرده باشد (users.invited_by، فقط یک بار و نه از خود)
 * با هر ۳ مرحله ← کوچک‌ترین شمارهٔ آزاد ۱..ظرفیت در تراکنش با قفل (+ ایندکس یکتا) و ۲ سال معافیت از کمیسیون.
 * ظرفیت پر یا کمپین خاموش ← چک‌لیست پنهان. تنظیمات: cfg('founders') از پنل.
 */
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { founders, guarantees, profiles, users } from '../../db/schema';
import { cfg } from '../../lib/appConfig';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { SAMPLE_PREFIX } from '../../lib/samples';
import { notify } from '../notifications/notify';

type User = typeof users.$inferSelect;
const LOCK = 54_100; // کلید قفل تراکنشی اختصاص شماره
const FREE_YEARS = 2;

const conf = () => cfg('founders') as { on: boolean; cap: number; perks: string[]; igUrl: string };

/** تعداد دعوت‌شده‌هایی که ثبت‌نام کامل کرده‌اند (حساب فعال + دست‌کم یک نقش) */
const INVITES = (userId: string) => sql<number>`(select count(*) from users iu where iu.invited_by = ${userId} and iu.id <> ${userId} and iu.status = 'active'
  and exists (select 1 from profiles ip where ip.user_id = iu.id))::int`;

export async function taken() {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(founders).where(isNotNull(founders.number));
  return r.n;
}

async function stepsOf(userId: string) {
  const [u] = await db
    .select({ kyc: users.kycStatus, followedAt: founders.followedAt, number: founders.number, assignedAt: founders.assignedAt, until: founders.commissionFreeUntil, revokedAt: founders.revokedAt, invites: INVITES(userId) })
    .from(users)
    .leftJoin(founders, eq(founders.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw notFound('کاربر پیدا نشد');
  const s = { follow: !!u.followedAt, kyc: u.kyc === 'verified', invite: u.invites > 0 };
  return { ...u, steps: s, done: Number(s.follow) + Number(s.kyc) + Number(s.invite) };
}

/** کوچک‌ترین شمارهٔ آزاد (یا شمارهٔ انتخابی مدیر) را در تراکنش قفل‌دار می‌دهد؛ اگر پر است null */
async function assign(userId: string, manual: boolean, wanted?: number) {
  const cap = conf().cap;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    const [f] = await tx.select().from(founders).where(eq(founders.userId, userId)).limit(1);
    if (f?.number) return { number: f.number, fresh: false };
    let n: number | null | undefined;
    if (wanted) {
      // دور ۵۵: شمارهٔ انتخابی مدیر — داخل ظرفیت و هنوز به کسی داده نشده
      if (wanted < 1 || wanted > cap) throw badRequest(`شماره باید بین ۱ و ${cap} باشد`, 'FOUNDER_NUMBER_RANGE');
      const [used] = await tx.select({ id: founders.userId }).from(founders).where(eq(founders.number, wanted)).limit(1);
      if (used) throw conflict(`شمارهٔ #${wanted} قبلاً به کس دیگری داده شده`, 'FOUNDER_NUMBER_TAKEN');
      n = wanted;
    } else {
      const { rows } = await tx.execute<{ n: number | null }>(sql`select min(g)::int as n from generate_series(1, ${cap}) g where g not in (select number from founders where number is not null)`);
      n = rows[0]?.n;
    }
    if (!n) return null;
    const now = new Date(), until = new Date(now);
    until.setFullYear(until.getFullYear() + FREE_YEARS);
    await tx
      .insert(founders)
      .values({ userId, number: n, assignedAt: now, commissionFreeUntil: until, manual })
      .onConflictDoUpdate({ target: founders.userId, set: { number: n, assignedAt: now, commissionFreeUntil: until, manual, revokedAt: null, updatedAt: now } });
    return { number: n, fresh: true };
  });
}

/** اگر هر ۳ مرحله کامل است و جا هست، شماره بده (بی‌خطر برای صدا زدن چندباره) */
export async function checkFounder(userId: string) {
  try {
    if (!conf().on) return null;
    const s = await stepsOf(userId);
    if (s.number) return s.number;
    if (s.revokedAt || s.done < 3) return null; // لغو دستی مدیر ← خودکار دوباره داده نمی‌شود
    const r = await assign(userId, false);
    if (r?.fresh) {
      logger.info({ userId, number: r.number }, 'founder assigned');
      await notify(userId, { type: 'id', title: `تبریک! تو عضو بنیان‌گذار #${r.number} بلوک شدی`, body: 'نشان بنیان‌گذار روی پروفایلت نشست و ۲ سال از کمیسیون بلوک معافی.', link: { screen: 'home' } });
      await nudgeProfile(userId);
    }
    return r?.number ?? null;
  } catch (err) {
    logger.error({ err, userId }, 'founder check failed');
    return null;
  }
}

/** پروفایل نقش فعال کامل است؟ (عکس، معرفی کوتاه) */
async function profileGaps(userId: string) {
  const [p] = await db
    .select({ avatar: profiles.avatarFileId, bio: profiles.bio })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(eq(profiles.userId, userId), sql`${profiles.role} = coalesce(${users.activeRole}, ${profiles.role})`))
    .limit(1);
  const photo = !!p?.avatar, bio = !!(p?.bio && p.bio.trim().length >= 10);
  return { photo, bio, complete: photo && bio };
}

/** دور ۵۷: پیام به بنیان‌گذار تازه برای تکمیل پروفایل و گذاشتن عکس */
export async function nudgeProfile(userId: string) {
  const g = await profileGaps(userId);
  if (g.complete) return;
  const need = [!g.photo && 'عکس پروفایل', !g.bio && 'معرفی کوتاه'].filter(Boolean).join(' و ');
  await notify(userId, {
    type: 'id',
    title: 'بنیان‌گذار عزیز، پروفایلت را کامل کن',
    body: `${need} را بگذار تا نشان بنیان‌گذار کنار یک پروفایل کامل دیده شود و کارفرماها راحت‌تر به تو اعتماد کنند.`,
    link: { screen: 'edit' },
  });
}

/** وضعیت کمپین (و اگر کاربر وارد شده، مرحله‌های خودش) */
export async function status(user?: User) {
  const c = conf();
  const t = await taken();
  const out: Record<string, unknown> = { on: c.on, open: c.on && t < c.cap, cap: c.cap, taken: t, left: Math.max(0, c.cap - t), perks: c.perks, igUrl: c.igUrl };
  if (!user) return out;
  await checkFounder(user.id);
  const s = await stepsOf(user.id);
  const [p] = await db.select({ code: profiles.code }).from(profiles).where(eq(profiles.userId, user.id)).orderBy(profiles.createdAt).limit(1);
  const pr = s.number ? await profileGaps(user.id) : null;
  out.me = {
    steps: s.steps, done: s.done, followedAt: s.followedAt, invites: s.invites, kycStatus: s.kyc,
    number: s.number, assignedAt: s.assignedAt, commissionFreeUntil: s.until, revoked: !!s.revokedAt,
    inviteCode: p?.code ?? null,
    // دور ۵۷: بنیان‌گذار باید پروفایلش کامل باشد (عکس و معرفی)
    profile: pr,
  };
  return out;
}

export async function follow(user: User) {
  await db
    .insert(founders)
    .values({ userId: user.id, followedAt: new Date() })
    .onConflictDoUpdate({ target: founders.userId, set: { followedAt: sql`coalesce(${founders.followedAt}, now())`, updatedAt: new Date() } });
  return status(user);
}

/**
 * ثبت‌نام اول کاربر با کد دعوت (فیلد «معرف»): دعوت‌کننده یک بار ثبت می‌شود،
 * دعوت‌کننده به‌عنوان قیم پیشنهاد می‌شود (خودش با کد پیامکی تأیید می‌کند) و مرحلهٔ ۳ او بررسی می‌شود.
 */
export async function onFirstProfile(user: User, profile: { id: string; displayName: string }, inviterUserId: string) {
  if (inviterUserId === user.id) return;
  const set = await db
    .update(users)
    .set({ invitedBy: inviterUserId, invitedAt: new Date() })
    .where(and(eq(users.id, user.id), sql`${users.invitedBy} is null`))
    .returning({ id: users.id });
  if (!set.length) return; // قبلاً با دعوت کس دیگری آمده
  const [inv] = await db.select({ phone: users.phone, name: profiles.displayName }).from(users).leftJoin(profiles, eq(profiles.userId, users.id)).where(eq(users.id, inviterUserId)).limit(1);
  if (inv && inv.phone !== user.phone) {
    const [g] = await db
      .insert(guarantees)
      .values({ profileId: profile.id, guarantorUserId: inviterUserId, guarantorPhone: inv.phone, guarantorName: inv.name || 'دعوت‌کننده', relation: 'دعوت‌کننده به بلوک' })
      .onConflictDoNothing()
      .returning({ id: guarantees.id });
    if (g) await notify(inviterUserId, { type: 'id', title: `${profile.displayName} با دعوت تو عضو بلوک شد`, body: 'قیم او شو تا اعتبار هر دو بیشتر شود؛ در «قیم و معرف» تأیید کن.', link: { screen: 'guar' } });
  }
  await checkFounder(inviterUserId);
}

/* ---------- پنل ادمین ---------- */

export async function adminList() {
  const { rows } = await db.execute<{
    id: string; phone: string; created_at: Date; kyc_status: string; name: string | null; role: string | null; city: string | null; province: string | null; code: string | null;
    followed_at: Date | null; number: number | null; assigned_at: Date | null; commission_free_until: Date | null; manual: boolean | null; revoked_at: Date | null;
    invites: number; inviter_id: string | null; inviter_name: string | null; inviter_code: string | null; inviter_phone: string | null;
  }>(sql`
    select u.id, u.phone, u.created_at, u.kyc_status, p.display_name as name, p.role, p.city, p.province, p.code,
      f.followed_at, f.number, f.assigned_at, f.commission_free_until, f.manual, f.revoked_at,
      (select count(*) from users iu where iu.invited_by = u.id and iu.status = 'active' and exists (select 1 from profiles ip where ip.user_id = iu.id))::int as invites,
      iv.id as inviter_id, ip2.display_name as inviter_name, ip2.code as inviter_code, iv.phone as inviter_phone
    from users u
    left join lateral (select * from profiles x where x.user_id = u.id order by (x.role = u.active_role) desc, x.created_at limit 1) p on true
    left join founders f on f.user_id = u.id
    left join users iv on iv.id = u.invited_by
    left join lateral (select * from profiles y where y.user_id = iv.id order by y.created_at limit 1) ip2 on true
    where u.status = 'active' and u.phone not like ${SAMPLE_PREFIX + '%'}
    order by f.number asc nulls last, u.created_at desc
    limit 5000`);
  return rows.map((r) => ({
    id: r.id, phone: r.phone, createdAt: r.created_at, name: r.name, role: r.role, city: r.city, province: r.province, code: r.code,
    steps: { follow: !!r.followed_at, kyc: r.kyc_status === 'verified', invite: r.invites > 0 }, followedAt: r.followed_at, kycStatus: r.kyc_status, invites: r.invites,
    number: r.number, assignedAt: r.assigned_at, commissionFreeUntil: r.commission_free_until, manual: !!r.manual, revokedAt: r.revoked_at,
    inviter: r.inviter_id ? { id: r.inviter_id, name: r.inviter_name, code: r.inviter_code, phone: r.inviter_phone } : null,
  }));
}

export async function adminStats() {
  const c = conf();
  const [r] = (
    await db.execute<{ users: number; follow: number; kyc: number; invite: number; done: number; all3: number }>(sql`
      select count(*)::int as users,
        count(*) filter (where f.followed_at is not null)::int as follow,
        count(*) filter (where u.kyc_status = 'verified')::int as kyc,
        count(*) filter (where exists (select 1 from users iu where iu.invited_by = u.id and iu.status = 'active' and exists (select 1 from profiles ip where ip.user_id = iu.id)))::int as invite,
        count(*) filter (where f.number is not null)::int as done,
        count(*) filter (where f.followed_at is not null and u.kyc_status = 'verified' and exists (select 1 from users iu where iu.invited_by = u.id and iu.status = 'active' and exists (select 1 from profiles ip where ip.user_id = iu.id)))::int as all3
      from users u left join founders f on f.user_id = u.id
      where u.status = 'active' and u.phone not like ${SAMPLE_PREFIX + '%'} and exists (select 1 from profiles p where p.user_id = u.id)`)
  ).rows;
  return { ...r, cap: c.cap, on: c.on, left: Math.max(0, c.cap - r.done), conversion: r.users ? Math.round((r.done / r.users) * 1000) / 10 : 0 };
}

export async function adminGrant(userId: string, wanted?: number) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw notFound('کاربر پیدا نشد');
  const [cur] = await db.select({ n: founders.number }).from(founders).where(eq(founders.userId, userId)).limit(1);
  if (cur?.n) throw conflict(`این کاربر از قبل بنیان‌گذار #${cur.n} است؛ برای شمارهٔ دیگر اول لغو کن`, 'ALREADY_FOUNDER');
  const r = await assign(userId, true, wanted);
  if (!r) throw conflict('ظرفیت بنیان‌گذاران پر است؛ اول ظرفیت را در تنظیمات بیشتر کن', 'FOUNDERS_FULL');
  if (r.fresh) {
    await notify(userId, { type: 'id', title: `تبریک! تو عضو بنیان‌گذار #${r.number} بلوک شدی`, body: 'نشان بنیان‌گذار روی پروفایلت نشست.', link: { screen: 'home' } });
    await nudgeProfile(userId);
  }
  return r.number;
}

export async function adminRevoke(userId: string) {
  const r = await db
    .update(founders)
    .set({ number: null, assignedAt: null, commissionFreeUntil: null, revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(founders.userId, userId), isNotNull(founders.number)))
    .returning({ id: founders.userId });
  if (!r.length) throw conflict('این کاربر بنیان‌گذار نیست', 'NOT_FOUNDER');
}

/** شمارهٔ بنیان‌گذار برای نمایش نشان روی پروفایل‌ها */
export async function founderNumbers(userIds: string[]) {
  if (!userIds.length) return new Map<string, number>();
  const rows = await db.select({ userId: founders.userId, n: founders.number }).from(founders).where(and(inArray(founders.userId, userIds), isNotNull(founders.number))).orderBy(desc(founders.number));
  return new Map(rows.map((r) => [r.userId, r.n!]));
}
