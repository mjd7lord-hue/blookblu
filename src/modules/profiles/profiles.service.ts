import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  ads,
  blocks,
  kycRequests,
  guarantees,
  profiles,
  profileSkills,
  refreshTokens,
  reviews,
  users,
  type Role,
  type WeekState,
} from '../../db/schema';
import { workCode } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { normalizeFa, toLatinDigits } from '../../lib/text';
import { cfg, flag } from '../../lib/appConfig';
import { bumpView } from '../../lib/views';
import { privateKeys, RANGE_OPTS, ROLE_INFO } from '../roles/forms';
import { validateRoleData, type RoleData } from '../roles/validate';
import { publicFileUrl, purgeFiles } from '../files/files.service';
import { listPortfolio, profileFileIds, purgeUserFiles } from '../files/media.service';

type User = typeof users.$inferSelect;
type Profile = typeof profiles.$inferSelect;

/* ---------- امتیاز اعتبار (همان فرمول اپ) ---------- */
// رضایت (۵۵) + پروژهٔ انجام‌شده (۲۵) + تعداد نظر (۱۰) + احراز هویت (۱۰) = ۱۰۰
export function trustOf(p: Pick<Profile, 'ratingAvg' | 'ratingCount' | 'doneCount'>, kycVerified: boolean) {
  const satisfaction = Math.round((p.ratingAvg / 5) * 55);
  const projects = Math.min(25, p.doneCount);
  const reviewsPart = Math.min(10, Math.round(p.ratingCount / 2));
  const identity = kycVerified ? 10 : 0;
  return {
    satisfaction,
    projects,
    reviews: reviewsPart,
    identity,
    total: satisfaction + projects + reviewsPart + identity,
  };
}

/* ---------- ساخت پروفایل از دادهٔ فرم ---------- */

function weekFromDays(days: unknown, prev?: WeekState): WeekState {
  const set = new Set(Array.isArray(days) ? (days as number[]) : []);
  return Array.from({ length: 7 }, (_, i) => (prev?.[i] === 'b' ? 'b' : set.has(i) ? 'a' : 'o'));
}

function autoTitle(role: Role, d: RoleData): string {
  const list = (k: string) => ((d[k] as string[] | undefined) ?? []).slice(0, 2).join('، ');
  switch (role) {
    case 'worker':
      return `کارگر ساختمانی · ${list('skills')}`;
    case 'specialist':
      return `متخصص ${list('skills')}`;
    case 'engineer':
      return `مهندس ${d.field ?? ''} · ${list('services')}`;
    case 'contractor':
      return `پیمانکار · ${list('kinds')}`;
    case 'company':
      return `شرکت ساختمانی · ${list('areas')}`;
    case 'general':
      return `کارفرما · ${d.need ?? ''}`;
  }
}

function skillsFromData(role: Role, d: RoleData) {
  const arr = (k: string) => (d[k] as string[] | undefined) ?? [];
  const exp = (d.exp as string) ?? null;
  switch (role) {
    case 'worker':
      return arr('skills').map((title) => ({ title, experience: exp, rateType: 'روزانه', rateAmount: (d.wage as number) ?? null }));
    case 'specialist':
      return arr('skills').map((title) => ({
        title,
        experience: exp,
        rateType: (d.rateType as string) ?? 'توافقی',
        rateAmount: d.rateType === 'توافقی' ? null : ((d.rate as number) ?? null),
      }));
    case 'engineer':
      return arr('services').map((title) => ({ title, experience: null, rateType: 'توافقی', rateAmount: null }));
    case 'contractor':
      return arr('kinds').map((title) => ({ title, experience: exp, rateType: 'توافقی', rateAmount: null }));
    case 'company':
      return arr('areas').map((title) => ({ title, experience: null, rateType: 'توافقی', rateAmount: null }));
    case 'general':
      return [];
  }
}

async function uniqueCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const c = workCode();
    const [x] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.code, c)).limit(1);
    if (!x) return c;
  }
  throw new Error('could not allocate profile code');
}

export async function createRoleProfile(user: User, role: Role, input: RoleData) {
  const [exists] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.userId, user.id), eq(profiles.role, role)))
    .limit(1);
  if (exists) throw conflict('این نقش را قبلاً ثبت کرده‌اید', 'ROLE_EXISTS');
  // نقش فقط یک بار، هنگام ثبت‌نام (مگر مدیر «چند نقش» را روشن کند)
  if (!flag('multiRole')) {
    const [other] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, user.id)).limit(1);
    if (other) throw forbidden('نقش هنگام ثبت‌نام انتخاب می‌شود؛ برای تغییر نقش از پشتیبانی بخواه', 'ROLE_LOCKED');
  }
  // مدیر می‌تواند ثبت‌نام یک نقش یا اتباع خارجی را موقتاً ببندد (پنل ← فهرست‌ها / تنظیمات)
  if (cfg('catalog').roles?.[role]?.on === false) throw forbidden('ثبت‌نام این نقش فعلاً بسته است', 'ROLE_DISABLED');

  const d = validateRoleData(role, input);
  if (!flag('foreign') && d.nat && d.nat !== 'ایرانی') throw forbidden('ثبت‌نام اتباع خارجی فعلاً بسته است', 'FOREIGN_DISABLED');

  // نام واقعی: بار اول از فرم گرفته می‌شود؛ بعد از احراز هویت قفل است
  let firstName = user.firstName;
  let lastName = user.lastName;
  if (role !== 'company' && (!firstName || user.kycStatus !== 'verified')) {
    firstName = d.fn as string;
    lastName = d.ln as string;
  }
  if (!firstName && role === 'company') {
    const parts = String(d.fn).split(' ');
    firstName = parts[0];
    lastName = parts.slice(1).join(' ') || null;
  }

  let referredBy: string | null = null;
  if (typeof d.ref === 'string') {
    const [ref] = await db
      .select({ id: profiles.id, userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.code, d.ref.toUpperCase()))
      .limit(1);
    if (ref && ref.userId !== user.id) referredBy = ref.id;
  }

  const displayName = role === 'company' ? (d.cname as string) : `${firstName} ${lastName ?? ''}`.trim();

  return db.transaction(async (tx) => {
    const [p] = await tx
      .insert(profiles)
      .values({
        userId: user.id,
        role,
        code: await uniqueCode(),
        displayName,
        title: autoTitle(role, d).slice(0, 160),
        bio: (d.bio as string) ?? null,
        province: d.prov as string,
        city: d.city as string,
        workRange: role === 'general' || role === 'company' ? 'province' : RANGE_OPTS[d.range as string],
        isPublic: d.pub !== false,
        showPhone: d.showPhone === true,
        data: d,
        week: weekFromDays(d.days),
        referredBy,
      })
      .returning();

    const sk = skillsFromData(role, d);
    if (sk.length) await tx.insert(profileSkills).values(sk.map((s, i) => ({ ...s, profileId: p.id, sort: i })));

    await tx
      .update(users)
      .set({ firstName, lastName, activeRole: role, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    return p;
  });
}

export async function updateRoleProfile(user: User, role: Role, input: RoleData, extra: { title?: string; bio?: string }) {
  const p = await getOwnProfile(user.id, role);

  // نام و شهر بعد از احراز هویت فقط از طریق پشتیبانی عوض می‌شود
  if (user.kycStatus === 'verified') {
    for (const k of ['fn', 'ln', 'cname', 'nid']) {
      if (k in input && input[k] !== p.data[k]) throw forbidden('بعد از احراز هویت، نام فقط با پشتیبانی عوض می‌شود', 'KYC_LOCKED');
    }
  }

  const d = validateRoleData(role, input, p.data, true);
  const set: Partial<Profile> = { data: d, updatedAt: new Date() };
  if ('prov' in input) set.province = d.prov as string;
  if ('city' in input) set.city = d.city as string;
  if ('range' in input && RANGE_OPTS[d.range as string]) set.workRange = RANGE_OPTS[d.range as string];
  if ('pub' in input) set.isPublic = d.pub !== false;
  if ('showPhone' in input) set.showPhone = d.showPhone === true;
  if ('days' in input) set.week = weekFromDays(d.days, p.week);
  if (role === 'company' && 'cname' in input) set.displayName = d.cname as string;
  if (extra.title !== undefined) set.title = normalizeFa(extra.title).slice(0, 160);
  else if (['skills', 'services', 'kinds', 'areas', 'need', 'field'].some((k) => k in input)) set.title = autoTitle(role, d).slice(0, 160);
  if (extra.bio !== undefined) set.bio = extra.bio.trim().slice(0, 1000) || null;

  return db.transaction(async (tx) => {
    const [np] = await tx.update(profiles).set(set).where(eq(profiles.id, p.id)).returning();
    if (['skills', 'services', 'kinds', 'areas', 'wage', 'rate', 'rateType', 'exp'].some((k) => k in input)) {
      await tx.delete(profileSkills).where(eq(profileSkills.profileId, p.id));
      const sk = skillsFromData(role, d);
      if (sk.length) await tx.insert(profileSkills).values(sk.map((s, i) => ({ ...s, profileId: p.id, sort: i })));
    }
    if (role !== 'company' && ('fn' in input || 'ln' in input)) {
      await tx.update(users).set({ firstName: d.fn as string, lastName: d.ln as string }).where(eq(users.id, user.id));
      await tx
        .update(profiles)
        .set({ displayName: `${d.fn} ${d.ln}` })
        .where(and(eq(profiles.userId, user.id), sql`${profiles.role} <> 'company'`));
    }
    return np;
  });
}

export async function getOwnProfile(userId: string, role: Role) {
  const [p] = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.userId, userId), eq(profiles.role, role)))
    .limit(1);
  if (!p) throw notFound('این نقش را هنوز ثبت نکرده‌اید', 'ROLE_NOT_FOUND');
  return p;
}

export async function setActiveRole(user: User, role: Role) {
  await getOwnProfile(user.id, role);
  await db.update(users).set({ activeRole: role, updatedAt: new Date() }).where(eq(users.id, user.id));
}

export async function deleteRoleProfile(user: User, role: Role) {
  const all = await db.select({ role: profiles.role }).from(profiles).where(eq(profiles.userId, user.id));
  if (!all.some((x) => x.role === role)) throw notFound('این نقش ثبت نشده', 'ROLE_NOT_FOUND');
  if (all.length === 1) throw badRequest('حداقل یک نقش باید بماند؛ برای حذف کامل، حساب را حذف کنید', 'LAST_ROLE');
  const p = await getOwnProfile(user.id, role);
  const fileIds = await profileFileIds(p.id);
  await db.delete(profiles).where(eq(profiles.id, p.id));
  await purgeFiles(fileIds);
  if (user.activeRole === role) {
    const next = all.find((x) => x.role !== role)!.role;
    await db.update(users).set({ activeRole: next }).where(eq(users.id, user.id));
  }
}

export async function setWeek(user: User, role: Role, week: ('a' | 'o')[]) {
  const p = await getOwnProfile(user.id, role);
  // روزهای رزرو‌شده (b) با تغییر دستی عوض نمی‌شوند
  const next: WeekState = week.map((w, i) => (p.week[i] === 'b' ? 'b' : w));
  const [np] = await db.update(profiles).set({ week: next, updatedAt: new Date() }).where(eq(profiles.id, p.id)).returning();
  return np.week;
}

export async function replaceSkills(
  user: User,
  role: Role,
  items: { title: string; experience?: string | null; rateType?: string | null; rateAmount?: number | null }[],
) {
  const p = await getOwnProfile(user.id, role);
  await db.transaction(async (tx) => {
    await tx.delete(profileSkills).where(eq(profileSkills.profileId, p.id));
    if (items.length)
      await tx.insert(profileSkills).values(
        items.map((s, i) => ({
          profileId: p.id,
          title: normalizeFa(s.title),
          experience: s.experience ?? null,
          rateType: s.rateType ?? null,
          rateAmount: s.rateAmount ?? null,
          sort: i,
        })),
      );
  });
  return db.select().from(profileSkills).where(eq(profileSkills.profileId, p.id)).orderBy(profileSkills.sort);
}

/** حذف حساب: داده‌های شخصی پاک، آگهی‌ها حذف، نشست‌ها بسته */
export async function deleteAccount(user: User) {
  await db.transaction(async (tx) => {
    const ps = await tx.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, user.id));
    if (ps.length)
      await tx
        .update(ads)
        .set({ status: 'removed' })
        .where(inArray(ads.profileId, ps.map((x) => x.id)));
    await tx.delete(profiles).where(eq(profiles.userId, user.id));
    // کد ملی و سابقهٔ احراز هویت هم پاک می‌شود
    await tx.delete(kycRequests).where(eq(kycRequests.userId, user.id));
    await tx.update(refreshTokens).set({ revokedAt: new Date(), replacedAt: null }).where(eq(refreshTokens.userId, user.id));
    await tx
      .update(users)
      .set({ status: 'deleted', firstName: null, lastName: null, activeRole: null, kycStatus: 'none', isAdmin: false, prefs: {}, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  });
  // عکس‌ها، نمونه‌کارها، مدارک و پیوست‌های چت از ذخیره‌ساز پاک می‌شوند
  await purgeUserFiles(user.id);
}

/* ---------- نمای عمومی و جست‌وجو ---------- */

export async function blockedIds(viewerId?: string): Promise<string[]> {
  if (!viewerId) return [];
  const rows = await db
    .select({ a: blocks.blockerUserId, b: blocks.blockedUserId })
    .from(blocks)
    .where(or(eq(blocks.blockerUserId, viewerId), eq(blocks.blockedUserId, viewerId)));
  return rows.map((r) => (r.a === viewerId ? r.b : r.a));
}

function publicData(p: Profile) {
  const hidden = privateKeys(p.role);
  hidden.add('ref');
  hidden.add('nid');
  return Object.fromEntries(Object.entries(p.data).filter(([k]) => !hidden.has(k)));
}

export async function publicProfile(code: string, viewer?: User) {
  const [row] = await db
    .select({ p: profiles, phone: users.phone, kyc: users.kycStatus, status: users.status })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.code, code.toUpperCase()))
    .limit(1);
  if (!row || row.status !== 'active') throw notFound('پروفایل پیدا نشد');
  const own = viewer?.id === row.p.userId;
  if (!row.p.isPublic && !own) throw notFound('این پروفایل خصوصی است', 'PROFILE_PRIVATE');
  if (!own && (await blockedIds(viewer?.id)).includes(row.p.userId)) throw notFound('پروفایل پیدا نشد');
  // آمار عملکرد: بازدید دیگران
  if (!own) {
    await db.update(profiles).set({ views: sql`${profiles.views} + 1` }).where(eq(profiles.id, row.p.id));
    await bumpView('profile', row.p.id);
  }

  const p = row.p;
  const [skills, revs, guars, stars, portfolio] = await Promise.all([
    db.select().from(profileSkills).where(eq(profileSkills.profileId, p.id)).orderBy(profileSkills.sort),
    db
      .select({
        rating: reviews.rating,
        text: reviews.text,
        createdAt: reviews.createdAt,
        fromName: profiles.displayName,
        fromRole: profiles.role,
        fromCode: profiles.code,
      })
      .from(reviews)
      .innerJoin(profiles, eq(profiles.id, reviews.fromProfileId))
      .where(eq(reviews.toProfileId, p.id))
      .orderBy(desc(reviews.createdAt))
      .limit(10),
    db
      .select({ name: guarantees.guarantorName, relation: guarantees.relation })
      .from(guarantees)
      .where(and(eq(guarantees.profileId, p.id), eq(guarantees.status, 'accepted'))),
    db
      .select({ rating: reviews.rating, n: sql<number>`count(*)::int` })
      .from(reviews)
      .where(eq(reviews.toProfileId, p.id))
      .groupBy(reviews.rating),
    listPortfolio(p.id),
  ]);

  const kycVerified = row.kyc === 'verified';
  return {
    id: p.id,
    code: p.code,
    role: p.role,
    roleName: ROLE_INFO[p.role].name,
    name: p.displayName,
    avatarUrl: publicFileUrl(p.avatarFileId),
    title: p.title,
    bio: p.bio,
    province: p.province,
    city: p.city,
    workRange: p.workRange,
    verified: p.verified,
    identityVerified: kycVerified,
    rating: Math.round(p.ratingAvg * 10) / 10,
    reviewsCount: p.ratingCount,
    doneCount: p.doneCount,
    trust: trustOf(p, kycVerified),
    // ۵ ستاره تا ۱ ستاره
    stars: [5, 4, 3, 2, 1].map((s) => stars.find((x) => x.rating === s)?.n ?? 0),
    week: p.week,
    since: p.createdAt,
    // شماره فقط برای کاربر واردشده و با اجازهٔ صاحب پروفایل
    phone: p.showPhone && viewer ? row.phone : null,
    data: own ? p.data : publicData(p),
    skills: skills.map(({ profileId, ...s }) => s),
    portfolio: portfolio.map(({ sort, ...x }) => x),
    reviews: revs,
    guarantors: guars,
    isOwn: own,
  };
}

export async function searchProfiles(
  q: {
    role?: Role;
    q?: string;
    province?: string;
    city?: string;
    verified?: boolean;
    available?: boolean;
    page: number;
    limit: number;
  },
  viewer?: User,
) {
  const conds: SQL[] = [eq(profiles.isPublic, true), eq(users.status, 'active')];
  if (q.role) conds.push(eq(profiles.role, q.role));
  if (q.province) conds.push(eq(profiles.province, q.province));
  if (q.city) conds.push(eq(profiles.city, q.city));
  if (q.verified) conds.push(eq(profiles.verified, true));
  if (q.available) conds.push(sql`${profiles.week} @> '["a"]'::jsonb`);
  if (q.q) {
    const term = `%${normalizeFa(q.q)}%`;
    // کد کاربری بدون حساسیت به حروف و خط تیره: «b4x92»، «B-4X92»، «۴X92»
    const raw = toLatinDigits(q.q).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const code = /^B?[A-Z0-9]{4}$/.test(raw) ? 'B-' + raw.slice(-4) : null;
    conds.push(
      or(
        ...(code ? [eq(profiles.code, code)] : []),
        ilike(profiles.displayName, term),
        ilike(profiles.title, term),
        sql`exists (select 1 from ${profileSkills} s where s.profile_id = ${profiles.id} and s.title ilike ${term})`,
      )!,
    );
  }
  const blocked = await blockedIds(viewer?.id);
  if (blocked.length) conds.push(sql`${profiles.userId} not in (${sql.join(blocked.map((b) => sql`${b}`), sql`, `)})`);

  // ترتیب: احراز‌شده و در دسترس اول، بعد امتیاز
  const rows = await db
    .select({
      code: profiles.code,
      role: profiles.role,
      name: profiles.displayName,
      title: profiles.title,
      city: profiles.city,
      province: profiles.province,
      verified: profiles.verified,
      rating: profiles.ratingAvg,
      reviewsCount: profiles.ratingCount,
      doneCount: profiles.doneCount,
      week: profiles.week,
      avatarFileId: profiles.avatarFileId,
      kyc: users.kycStatus,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(...conds))
    .orderBy(
      desc(profiles.verified),
      desc(sql`(${profiles.week} @> '["a"]'::jsonb)`),
      desc(profiles.ratingAvg),
      desc(profiles.doneCount),
    )
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return rows.map(({ kyc, avatarFileId, ...r }) => ({
    ...r,
    avatarUrl: publicFileUrl(avatarFileId),
    trust: trustOf({ ratingAvg: r.rating, ratingCount: r.reviewsCount, doneCount: r.doneCount }, kyc === 'verified').total,
  }));
}
