import { and, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { adResponses, ads, profiles, users, type Role } from '../../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { normalizeFa } from '../../lib/text';
import { blockedIds, trustOf } from '../profiles/profiles.service';
import { notify } from '../notifications/notify';

type User = typeof users.$inferSelect;
type Profile = typeof profiles.$inferSelect;
type AdType = 'work' | 'job' | 'consult';

/** چه نقش‌هایی می‌توانند مخاطب هر نوع آگهی باشند (هم‌تراز با اپ) */
export const AUDIENCE: Record<AdType, Role[]> = {
  work: ['general', 'contractor', 'company'],
  job: ['worker', 'specialist', 'engineer', 'contractor', 'company'],
  consult: ['engineer', 'specialist', 'contractor'],
};

export type AdInput = {
  type: AdType;
  title: string;
  description?: string | null;
  province: string;
  city: string;
  wageType?: string | null;
  wageAmount?: number | null;
  startWhen?: string | null;
  range: 'city' | 'km50' | 'province' | 'country';
  audience: Role[];
  needCount?: number | null;
  skills: string[];
};

function checkAudience(type: AdType, audience: Role[]) {
  const bad = audience.filter((r) => !AUDIENCE[type].includes(r));
  if (bad.length) throw badRequest('مخاطب انتخاب‌شده برای این نوع آگهی مجاز نیست', 'BAD_AUDIENCE', { roles: bad });
}

function clean(input: Partial<AdInput>) {
  const out: Partial<AdInput> = { ...input };
  if (input.title !== undefined) out.title = normalizeFa(input.title);
  if (input.description) out.description = input.description.trim();
  if (input.skills) out.skills = [...new Set(input.skills.map(normalizeFa))];
  if (input.type === 'consult') {
    out.wageType = null;
    out.wageAmount = null;
    out.needCount = null;
  }
  if (input.wageType === 'توافقی') out.wageAmount = null;
  return out;
}

export async function createAd(profile: Profile, input: AdInput) {
  checkAudience(input.type, input.audience);
  // هر پروفایل حداکثر ۲۰ آگهی فعال
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ads)
    .where(and(eq(ads.profileId, profile.id), eq(ads.status, 'active')));
  if (n >= 20) throw badRequest('حداکثر ۲۰ آگهی فعال می‌توانید داشته باشید', 'AD_LIMIT');

  const c = clean(input) as AdInput;
  const [ad] = await db
    .insert(ads)
    .values({ ...c, profileId: profile.id, expiresAt: new Date(Date.now() + 30 * 86400_000) })
    .returning();
  return ad;
}

async function ownAd(profile: Profile, id: string) {
  const [ad] = await db.select().from(ads).where(eq(ads.id, id)).limit(1);
  if (!ad || ad.status === 'removed') throw notFound('آگهی پیدا نشد');
  if (ad.profileId !== profile.id) throw forbidden('این آگهی مال شما نیست');
  return ad;
}

export async function updateAd(profile: Profile, id: string, input: Partial<AdInput> & { status?: 'active' | 'paused' | 'closed' }) {
  const ad = await ownAd(profile, id);
  if (input.audience) checkAudience(ad.type, input.audience);
  const c = clean({ ...input, type: ad.type });
  delete c.type;
  const set: Record<string, unknown> = { ...c, updatedAt: new Date() };
  // فعال‌سازی دوباره = تمدید ۳۰ روزه
  if (input.status === 'active' && ad.status !== 'active') set.expiresAt = new Date(Date.now() + 30 * 86400_000);
  const [n] = await db.update(ads).set(set).where(eq(ads.id, id)).returning();
  return n;
}

export async function removeAd(profile: Profile, id: string) {
  await ownAd(profile, id);
  await db.update(ads).set({ status: 'removed', updatedAt: new Date() }).where(eq(ads.id, id));
}

const authorCols = {
  code: profiles.code,
  role: profiles.role,
  name: profiles.displayName,
  title: profiles.title,
  verified: profiles.verified,
  rating: profiles.ratingAvg,
  reviewsCount: profiles.ratingCount,
  doneCount: profiles.doneCount,
  week: profiles.week,
};

function shapeAuthor(a: {
  code: string;
  role: Role;
  name: string;
  title: string | null;
  verified: boolean;
  rating: number;
  reviewsCount: number;
  doneCount: number;
  week: unknown;
  kyc: string;
}) {
  const { kyc, ...rest } = a;
  return {
    ...rest,
    rating: Math.round(a.rating * 10) / 10,
    trust: trustOf({ ratingAvg: a.rating, ratingCount: a.reviewsCount, doneCount: a.doneCount }, kyc === 'verified').total,
  };
}

export type ExploreQuery = {
  type: AdType;
  authorRole?: Role;
  forRole?: Role;
  province?: string;
  city?: string;
  q?: string;
  skills?: string[];
  verified?: boolean;
  minRating?: number;
  sort: 'best' | 'new' | 'rating' | 'exp';
  page: number;
  limit: number;
};

export async function explore(q: ExploreQuery, viewer?: User) {
  const conds: SQL[] = [
    eq(ads.type, q.type),
    eq(ads.status, 'active'),
    eq(users.status, 'active'),
    or(sql`${ads.expiresAt} is null`, sql`${ads.expiresAt} > now()`)!,
  ];
  if (q.authorRole) conds.push(eq(profiles.role, q.authorRole));
  if (q.forRole) conds.push(sql`${q.forRole}::role = any(${ads.audience})`);
  if (q.province) conds.push(eq(ads.province, q.province));
  if (q.city) conds.push(eq(ads.city, q.city));
  if (q.verified) conds.push(eq(profiles.verified, true));
  if (q.minRating) conds.push(sql`${profiles.ratingAvg} >= ${q.minRating}`);
  if (q.skills?.length) {
    const arr = sql`array[${sql.join(q.skills.map((s) => sql`${normalizeFa(s)}`), sql`, `)}]::text[]`;
    conds.push(sql`${ads.skills} && ${arr}`);
  }
  if (q.q) {
    const term = `%${normalizeFa(q.q)}%`;
    conds.push(
      or(
        ilike(ads.title, term),
        ilike(ads.description, term),
        ilike(ads.city, term),
        ilike(profiles.displayName, term),
        ilike(profiles.code, term),
        sql`array_to_string(${ads.skills}, ' ') ilike ${term}`,
      )!,
    );
  }
  if (viewer) {
    const blocked = await blockedIds(viewer.id);
    if (blocked.length) conds.push(sql`${profiles.userId} not in (${sql.join(blocked.map((b) => sql`${b}`), sql`, `)})`);
  }

  // «بهترین»: اعتبار نویسنده (همان فرمول امتیاز) و بعد تازگی
  const trustExpr = sql`(round(${profiles.ratingAvg} / 5 * 55) + least(25, ${profiles.doneCount}) + least(10, round(${profiles.ratingCount} / 2.0)) + case when ${users.kycStatus} = 'verified' then 10 else 0 end)`;
  const order = {
    best: [desc(trustExpr), desc(ads.createdAt)],
    new: [desc(ads.createdAt)],
    rating: [desc(profiles.ratingAvg), desc(ads.createdAt)],
    exp: [desc(profiles.doneCount), desc(ads.createdAt)],
  }[q.sort];

  const rows = await db
    .select({ ad: ads, author: { ...authorCols, kyc: users.kycStatus } })
    .from(ads)
    .innerJoin(profiles, eq(profiles.id, ads.profileId))
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(...conds))
    .orderBy(...order)
    .limit(q.limit + 1)
    .offset((q.page - 1) * q.limit);

  const hasMore = rows.length > q.limit;
  return {
    items: rows.slice(0, q.limit).map((r) => ({ ...publicAd(r.ad), author: shapeAuthor(r.author) })),
    page: q.page,
    hasMore,
  };
}

function publicAd(a: typeof ads.$inferSelect) {
  const { profileId, ...rest } = a;
  return rest;
}

export async function getAd(id: string, viewer?: User) {
  const [row] = await db
    .select({ ad: ads, author: { ...authorCols, kyc: users.kycStatus }, ownerId: profiles.userId })
    .from(ads)
    .innerJoin(profiles, eq(profiles.id, ads.profileId))
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(ads.id, id))
    .limit(1);
  if (!row || row.ad.status === 'removed') throw notFound('آگهی پیدا نشد');
  const own = viewer?.id === row.ownerId;
  if (!own && row.ad.status !== 'active') throw notFound('این آگهی دیگر فعال نیست', 'AD_INACTIVE');
  if (!own && (await blockedIds(viewer?.id)).includes(row.ownerId)) throw notFound('آگهی پیدا نشد');

  if (!own) await db.update(ads).set({ views: sql`${ads.views} + 1` }).where(eq(ads.id, id));

  let myResponse = null;
  if (viewer && !own) {
    const [r] = await db
      .select({ id: adResponses.id, status: adResponses.status, createdAt: adResponses.createdAt })
      .from(adResponses)
      .innerJoin(profiles, eq(profiles.id, adResponses.profileId))
      .where(and(eq(adResponses.adId, id), eq(profiles.userId, viewer.id)))
      .limit(1);
    myResponse = r ?? null;
  }
  return { ad: { ...publicAd(row.ad), author: shapeAuthor(row.author) }, isOwn: own, myResponse };
}

export async function myAds(profile: Profile) {
  const rows = await db
    .select()
    .from(ads)
    .where(and(eq(ads.profileId, profile.id), ne(ads.status, 'removed')))
    .orderBy(desc(ads.createdAt));
  return rows.map(publicAd);
}

/* ---------- پاسخ به آگهی ---------- */

export async function respond(profile: Profile, adId: string, input: { message: string; offer?: string | null }) {
  const [row] = await db
    .select({ ad: ads, ownerId: profiles.userId })
    .from(ads)
    .innerJoin(profiles, eq(profiles.id, ads.profileId))
    .where(eq(ads.id, adId))
    .limit(1);
  if (!row || row.ad.status !== 'active') throw notFound('این آگهی فعال نیست', 'AD_INACTIVE');
  if (row.ownerId === profile.userId) throw badRequest('به آگهی خودتان نمی‌توانید پاسخ دهید', 'OWN_AD');
  if (!row.ad.audience.includes(profile.role)) {
    throw forbidden('این آگهی برای نقش فعال شما نیست؛ نقش را عوض کنید', 'NOT_AUDIENCE');
  }
  if ((await blockedIds(profile.userId)).includes(row.ownerId)) throw forbidden('امکان پاسخ به این آگهی نیست', 'BLOCKED');

  const [exists] = await db
    .select({ id: adResponses.id, status: adResponses.status })
    .from(adResponses)
    .where(and(eq(adResponses.adId, adId), eq(adResponses.profileId, profile.id)))
    .limit(1);
  if (exists && exists.status !== 'withdrawn') throw conflict('قبلاً به این آگهی پاسخ داده‌اید', 'ALREADY_RESPONDED');

  const values = { message: input.message.trim(), offer: input.offer?.trim() || null };
  const resp = await db.transaction(async (tx) => {
    const [r] = exists
      ? await tx
          .update(adResponses)
          .set({ ...values, status: 'pending', respondedAt: null, createdAt: new Date() })
          .where(eq(adResponses.id, exists.id))
          .returning()
      : await tx.insert(adResponses).values({ ...values, adId, profileId: profile.id }).returning();
    await tx.update(ads).set({ responsesCount: sql`${ads.responsesCount} + 1` }).where(eq(ads.id, adId));
    return r;
  });

  const title = { work: 'درخواست همکاری تازه', job: 'اعلام آمادگی تازه', consult: 'پاسخ تازه به پرسش شما' }[row.ad.type];
  await notify(row.ownerId, {
    type: 'req',
    title,
    body: `${profile.displayName} برای «${row.ad.title}»`,
    link: { screen: 'myads', id: adId },
  });
  return resp;
}

export async function listResponses(profile: Profile, adId: string) {
  await ownAd(profile, adId);
  const rows = await db
    .select({
      id: adResponses.id,
      message: adResponses.message,
      offer: adResponses.offer,
      status: adResponses.status,
      createdAt: adResponses.createdAt,
      from: { ...authorCols, kyc: users.kycStatus },
    })
    .from(adResponses)
    .innerJoin(profiles, eq(profiles.id, adResponses.profileId))
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(eq(adResponses.adId, adId), ne(adResponses.status, 'withdrawn')))
    .orderBy(desc(adResponses.createdAt));
  return rows.map((r) => ({ ...r, from: shapeAuthor(r.from) }));
}

export async function answerResponse(profile: Profile, responseId: string, status: 'accepted' | 'rejected') {
  const [row] = await db
    .select({ r: adResponses, ad: ads, responderUserId: profiles.userId })
    .from(adResponses)
    .innerJoin(ads, eq(ads.id, adResponses.adId))
    .innerJoin(profiles, eq(profiles.id, adResponses.profileId))
    .where(eq(adResponses.id, responseId))
    .limit(1);
  if (!row) throw notFound('درخواست پیدا نشد');
  if (row.ad.profileId !== profile.id) throw forbidden('این درخواست مربوط به آگهی شما نیست');
  if (row.r.status !== 'pending') throw conflict('به این درخواست قبلاً جواب داده شده', 'ALREADY_ANSWERED');

  const [r] = await db
    .update(adResponses)
    .set({ status, respondedAt: new Date() })
    .where(eq(adResponses.id, responseId))
    .returning();

  await notify(row.responderUserId, {
    type: 'req',
    title: status === 'accepted' ? 'درخواست شما پذیرفته شد' : 'درخواست شما رد شد',
    body: `آگهی «${row.ad.title}»`,
    link: { screen: 'req', id: responseId },
  });
  return r;
}

export async function withdrawResponse(userId: string, responseId: string) {
  const [row] = await db
    .select({ r: adResponses, ownerUserId: profiles.userId })
    .from(adResponses)
    .innerJoin(profiles, eq(profiles.id, adResponses.profileId))
    .where(eq(adResponses.id, responseId))
    .limit(1);
  if (!row || row.ownerUserId !== userId) throw notFound('درخواست پیدا نشد');
  if (row.r.status !== 'pending') throw conflict('فقط درخواست در انتظار را می‌توان پس گرفت', 'NOT_PENDING');
  await db.transaction(async (tx) => {
    await tx.update(adResponses).set({ status: 'withdrawn' }).where(eq(adResponses.id, responseId));
    await tx
      .update(ads)
      .set({ responsesCount: sql`greatest(0, ${ads.responsesCount} - 1)` })
      .where(eq(ads.id, row.r.adId));
  });
}

/** درخواست‌های ورودی (به آگهی‌های من) و خروجی (پاسخ‌های من) برای صفحهٔ «درخواست‌ها» */
export async function myRequests(profile: Profile, dir: 'in' | 'out') {
  if (dir === 'out') {
    return db
      .select({
        id: adResponses.id,
        status: adResponses.status,
        message: adResponses.message,
        offer: adResponses.offer,
        createdAt: adResponses.createdAt,
        ad: { id: ads.id, title: ads.title, type: ads.type, city: ads.city, status: ads.status },
      })
      .from(adResponses)
      .innerJoin(ads, eq(ads.id, adResponses.adId))
      .where(and(eq(adResponses.profileId, profile.id), ne(adResponses.status, 'withdrawn')))
      .orderBy(desc(adResponses.createdAt));
  }
  const myAdIds = db.select({ id: ads.id }).from(ads).where(eq(ads.profileId, profile.id));
  const rows = await db
    .select({
      id: adResponses.id,
      status: adResponses.status,
      message: adResponses.message,
      offer: adResponses.offer,
      createdAt: adResponses.createdAt,
      ad: { id: ads.id, title: ads.title, type: ads.type },
      from: { ...authorCols, kyc: users.kycStatus },
    })
    .from(adResponses)
    .innerJoin(ads, eq(ads.id, adResponses.adId))
    .innerJoin(profiles, eq(profiles.id, adResponses.profileId))
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(inArray(adResponses.adId, myAdIds), ne(adResponses.status, 'withdrawn')))
    .orderBy(desc(adResponses.createdAt));
  return rows.map((r) => ({ ...r, from: shapeAuthor(r.from) }));
}
