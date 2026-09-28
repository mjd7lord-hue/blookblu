import { and, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db';
import {
  adminActions,
  ads,
  documents,
  files,
  kycRequests,
  profiles,
  refreshTokens,
  reports,
  users,
} from '../../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { toLatinDigits } from '../../lib/text';
import { fileUrl, purgeFiles } from '../files/files.service';
import { notify } from '../notifications/notify';
import { applyVerifiedName, duplicateIdentity } from '../kyc/kyc.service';

type User = typeof users.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;
type Page = { page: number; limit: number };

async function log(exec: Exec, admin: User, action: string, targetType: string, targetId: string, note?: string | null) {
  await exec.insert(adminActions).values({ adminUserId: admin.id, action, targetType, targetId, note: note ?? null });
}

const signed = (id: string | null) => (id ? fileUrl({ id, isPublic: false }) : null);

/* ---------- خلاصهٔ کاربر ---------- */

async function briefUsers(ids: string[]) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map<string, ReturnType<typeof brief>>();
  const [us, ps] = await Promise.all([
    db.select().from(users).where(inArray(users.id, list)),
    db
      .select({ userId: profiles.userId, code: profiles.code, role: profiles.role, name: profiles.displayName, verified: profiles.verified })
      .from(profiles)
      .where(inArray(profiles.userId, list)),
  ]);
  return new Map(us.map((u) => [u.id, brief(u, ps.filter((p) => p.userId === u.id))]));
}

function brief(u: User, ps: { code: string; role: string; name: string; verified: boolean }[]) {
  return {
    id: u.id,
    phone: u.phone,
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
    status: u.status,
    kycStatus: u.kycStatus,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
    profiles: ps.map(({ code, role, name, verified }) => ({ code, role, name, verified })),
  };
}

/* ---------- آمار ---------- */

export async function stats() {
  const [[kyc], [docs], [reps], [us]] = await Promise.all([
    db.select({ n: count() }).from(kycRequests).where(eq(kycRequests.status, 'pending')),
    db.select({ n: count() }).from(documents).where(eq(documents.status, 'pending')),
    db.select({ n: count() }).from(reports).where(inArray(reports.status, ['open', 'reviewing'])),
    db
      .select({
        total: sql<number>`count(*) filter (where ${users.status} <> 'deleted')::int`,
        suspended: sql<number>`count(*) filter (where ${users.status} = 'suspended')::int`,
        verified: sql<number>`count(*) filter (where ${users.kycStatus} = 'verified' and ${users.status} <> 'deleted')::int`,
        today: sql<number>`count(*) filter (where ${users.createdAt} > now() - interval '1 day')::int`,
      })
      .from(users),
  ]);
  return { pending: { kyc: kyc.n, documents: docs.n, reports: reps.n }, users: us };
}

/* ---------- احراز هویت ---------- */

export async function listKyc(q: Page & { status: 'pending' | 'approved' | 'rejected' }) {
  const rows = await db
    .select()
    .from(kycRequests)
    .where(eq(kycRequests.status, q.status))
    // در انتظار: قدیمی‌ترین اول (صف)؛ بقیه: تازه‌ترین اول
    .orderBy(q.status === 'pending' ? kycRequests.createdAt : desc(kycRequests.reviewedAt))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);
  const people = await briefUsers(rows.map((r) => r.userId));
  return Promise.all(
    rows.map(async (k) => ({
      id: k.id,
      status: k.status,
      firstName: k.firstName,
      lastName: k.lastName,
      idType: k.idType,
      idNumber: k.idNumber,
      cardUrl: signed(k.cardFileId),
      selfieUrl: signed(k.selfieFileId),
      rejectReason: k.rejectReason,
      createdAt: k.createdAt,
      reviewedAt: k.reviewedAt,
      user: people.get(k.userId) ?? null,
      // هشدار: همین کد ملی روی حساب تأییدشدهٔ دیگری
      duplicates: k.status === 'pending' ? await duplicateIdentity(k.userId, k.idNumber) : [],
    })),
  );
}

async function pendingKyc(id: string) {
  const [k] = await db.select().from(kycRequests).where(eq(kycRequests.id, id)).limit(1);
  if (!k) throw notFound('درخواست پیدا نشد');
  if (k.status !== 'pending') throw conflict('این درخواست قبلاً بررسی شده است', 'NOT_PENDING');
  return k;
}

export async function approveKyc(admin: User, id: string, input: { firstName?: string; lastName?: string; force?: boolean }) {
  const k = await pendingKyc(id);
  const dups = await duplicateIdentity(k.userId, k.idNumber);
  if (dups.length && !input.force) {
    throw conflict('این کد ملی روی حساب تأییدشدهٔ دیگری هم هست؛ اگر مطمئنی، با force تأیید کن', 'KYC_DUPLICATE');
  }
  const firstName = input.firstName ?? k.firstName;
  const lastName = input.lastName ?? k.lastName;
  await db.transaction(async (tx) => {
    const upd = await tx
      .update(kycRequests)
      .set({ status: 'approved', firstName, lastName, reviewedBy: admin.id, reviewedAt: new Date() })
      .where(and(eq(kycRequests.id, id), eq(kycRequests.status, 'pending')))
      .returning({ id: kycRequests.id });
    if (!upd.length) throw conflict('این درخواست قبلاً بررسی شده است', 'NOT_PENDING');
    await applyVerifiedName(tx, k.userId, firstName, lastName);
    await log(tx, admin, 'kyc.approve', 'kyc', id, dups.length ? `تکراری: ${dups.map((d) => d.phone).join('، ')}` : null);
  });
  // وعدهٔ حریم خصوصی: تصویر کارت بعد از بررسی از دسترس خارج می‌شود
  await purgeFiles([k.cardFileId, k.selfieFileId]);
  await notify(k.userId, {
    type: 'id',
    title: 'هویت شما تأیید شد',
    body: 'مهر «هویت تأیید شد» روی شناسنامهٔ کاری‌ات خورد و ۱۰ امتیاز اعتبار گرفتی.',
    link: { screen: 'trust' },
  });
}

export async function rejectKyc(admin: User, id: string, reason: string) {
  const k = await pendingKyc(id);
  await db.transaction(async (tx) => {
    const upd = await tx
      .update(kycRequests)
      .set({ status: 'rejected', rejectReason: reason, reviewedBy: admin.id, reviewedAt: new Date() })
      .where(and(eq(kycRequests.id, id), eq(kycRequests.status, 'pending')))
      .returning({ id: kycRequests.id });
    if (!upd.length) throw conflict('این درخواست قبلاً بررسی شده است', 'NOT_PENDING');
    await tx
      .update(users)
      .set({ kycStatus: 'rejected', updatedAt: new Date() })
      .where(and(eq(users.id, k.userId), eq(users.kycStatus, 'pending')));
    await log(tx, admin, 'kyc.reject', 'kyc', id, reason);
  });
  await purgeFiles([k.cardFileId, k.selfieFileId]);
  await notify(k.userId, { type: 'id', title: 'تأیید هویت انجام نشد', body: `${reason} — می‌توانی دوباره بفرستی.`, link: { screen: 'kyc' } });
}

/* ---------- مدارک ---------- */

/** نشان «مدرک‌دار» = حداقل یک مدرک تأییدشدهٔ منقضی‌نشده برای همان نقش */
export async function recomputeVerified(profileIds?: string[]) {
  if (profileIds && !profileIds.length) return 0;
  const has = sql`exists (select 1 from ${documents} d where d.profile_id = ${profiles.id} and d.status = 'approved' and (d.expires_at is null or d.expires_at > now()))`;
  const rows = await db
    .update(profiles)
    .set({ verified: sql`${has}` })
    .where(and(sql`${profiles.verified} is distinct from ${has}`, profileIds ? inArray(profiles.id, profileIds) : undefined))
    .returning({ id: profiles.id });
  return rows.length;
}

export async function listDocuments(q: Page & { status: 'pending' | 'approved' | 'rejected' }) {
  const rows = await db
    .select({ d: documents, f: files, code: profiles.code, role: profiles.role })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .leftJoin(profiles, eq(profiles.id, documents.profileId))
    .where(eq(documents.status, q.status))
    .orderBy(q.status === 'pending' ? documents.createdAt : desc(documents.reviewedAt))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);
  const people = await briefUsers(rows.map((r) => r.d.userId));
  return rows.map(({ d, f, code, role }) => ({
    id: d.id,
    title: d.title,
    group: d.group,
    status: d.status,
    rejectReason: d.rejectReason,
    expiresAt: d.expiresAt,
    profile: code ? { code, role } : null,
    file: { url: fileUrl(f), mime: f.mime, size: f.size, name: f.originalName },
    user: people.get(d.userId) ?? null,
    createdAt: d.createdAt,
    reviewedAt: d.reviewedAt,
  }));
}

async function getDocument(id: string) {
  const [d] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!d) throw notFound('مدرک پیدا نشد');
  return d;
}

export async function approveDocument(admin: User, id: string, input: { expiresAt?: Date | null }) {
  const d = await getDocument(id);
  if (d.status === 'approved') throw conflict('این مدرک قبلاً تأیید شده است', 'ALREADY_APPROVED');
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw badRequest('تاریخ انقضا گذشته است', 'EXPIRED');
  await db.transaction(async (tx) => {
    await tx
      .update(documents)
      .set({ status: 'approved', rejectReason: null, expiresAt: input.expiresAt ?? null, reviewedBy: admin.id, reviewedAt: new Date() })
      .where(eq(documents.id, id));
    await log(tx, admin, 'document.approve', 'document', id, input.expiresAt ? `انقضا: ${input.expiresAt.toISOString().slice(0, 10)}` : null);
  });
  if (d.profileId) await recomputeVerified([d.profileId]);
  await notify(d.userId, { type: 'id', title: `«${d.title}» تأیید شد`, body: 'نشان مدرک‌دار روی شناسنامهٔ کاری‌ات به‌روز شد.', link: { screen: 'docs' } });
}

/** رد مدرک در انتظار، یا لغو تأیید مدرکی که قبلاً تأیید شده */
export async function rejectDocument(admin: User, id: string, reason: string) {
  const d = await getDocument(id);
  if (d.status === 'rejected') throw conflict('این مدرک قبلاً رد شده است', 'ALREADY_REJECTED');
  await db.transaction(async (tx) => {
    await tx
      .update(documents)
      .set({ status: 'rejected', rejectReason: reason, reviewedBy: admin.id, reviewedAt: new Date() })
      .where(eq(documents.id, id));
    await log(tx, admin, d.status === 'approved' ? 'document.revoke' : 'document.reject', 'document', id, reason);
  });
  if (d.profileId) await recomputeVerified([d.profileId]);
  await notify(d.userId, { type: 'id', title: `«${d.title}» تأیید نشد`, body: reason, link: { screen: 'docs' } });
}

/* ---------- گزارش‌ها ---------- */

export async function listReports(q: Page & { status: 'open' | 'reviewing' | 'resolved' | 'dismissed' | 'active' }) {
  const target = alias(profiles, 'target_p');
  const rows = await db
    .select({ r: reports, t: target, ad: { id: ads.id, title: ads.title, status: ads.status, type: ads.type } })
    .from(reports)
    .leftJoin(target, eq(target.id, reports.targetProfileId))
    .leftJoin(ads, eq(ads.id, reports.targetAdId))
    .where(q.status === 'active' ? inArray(reports.status, ['open', 'reviewing']) : eq(reports.status, q.status))
    .orderBy(q.status === 'active' || q.status === 'open' ? reports.createdAt : desc(reports.handledAt))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  const targetIds = [...new Set(rows.map((x) => x.t?.id).filter((x): x is string => !!x))];
  const counts = targetIds.length
    ? await db
        .select({ id: reports.targetProfileId, n: count() })
        .from(reports)
        .where(inArray(reports.targetProfileId, targetIds))
        .groupBy(reports.targetProfileId)
    : [];
  const people = await briefUsers([...rows.map((x) => x.r.reporterUserId), ...rows.map((x) => x.t?.userId ?? '')]);

  return rows.map(({ r, t, ad }) => ({
    id: r.id,
    reason: r.reason,
    details: r.details,
    status: r.status,
    adminNote: r.adminNote,
    createdAt: r.createdAt,
    handledAt: r.handledAt,
    reporter: people.get(r.reporterUserId) ?? null,
    target: t
      ? {
          code: t.code,
          role: t.role,
          name: t.displayName,
          user: people.get(t.userId) ?? null,
          // تعداد کل گزارش‌ها علیه این پروفایل
          reportsCount: counts.find((c) => c.id === t.id)?.n ?? 0,
        }
      : null,
    ad: ad?.id ? ad : null,
  }));
}

export async function updateReport(admin: User, id: string, input: { status: 'reviewing' | 'resolved' | 'dismissed'; note?: string }) {
  const [rep] = await db
    .update(reports)
    .set({ status: input.status, adminNote: input.note ?? null, handledBy: admin.id, handledAt: new Date() })
    .where(eq(reports.id, id))
    .returning();
  if (!rep) throw notFound('گزارش پیدا نشد');
  await log(db, admin, `report.${input.status}`, 'report', id, input.note);
  if (input.status === 'resolved' || input.status === 'dismissed') {
    await notify(rep.reporterUserId, {
      type: 'id',
      title: 'گزارش شما بررسی شد',
      body: input.status === 'resolved' ? 'از گزارشت ممنونیم؛ اقدام لازم انجام شد.' : 'موردی خلاف قوانین پیدا نشد.',
    });
  }
  return rep;
}

/* ---------- کاربران ---------- */

export async function searchUsers(q: Page & { q?: string; status?: 'active' | 'suspended' | 'deleted'; kyc?: 'none' | 'pending' | 'verified' | 'rejected' }) {
  const conds: SQL[] = [];
  if (q.status) conds.push(eq(users.status, q.status));
  if (q.kyc) conds.push(eq(users.kycStatus, q.kyc));
  if (q.q) {
    const t = q.q.trim();
    const digits = toLatinDigits(t).replace(/\D/g, '');
    const or_: SQL[] = [ilike(sql`coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, '')`, `%${t}%`)];
    if (digits.length >= 4) or_.push(ilike(users.phone, `%${digits.slice(-10)}%`));
    if (/^B-[A-Z0-9]{4}$/i.test(t)) {
      or_.push(sql`exists (select 1 from ${profiles} p where p.user_id = ${users.id} and p.code = ${t.toUpperCase()})`);
    }
    or_.push(sql`exists (select 1 from ${profiles} p where p.user_id = ${users.id} and p.display_name ilike ${`%${t}%`})`);
    conds.push(or(...or_)!);
  }
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(users.createdAt))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);
  const people = await briefUsers(rows.map((r) => r.id));
  return rows.map((r) => people.get(r.id)!);
}

export async function userDetail(id: string) {
  const people = await briefUsers([id]);
  const u = people.get(id);
  if (!u) throw notFound('کاربر پیدا نشد');
  const [kyc, docs, reps, actions] = await Promise.all([
    db.select().from(kycRequests).where(eq(kycRequests.userId, id)).orderBy(desc(kycRequests.createdAt)).limit(10),
    db.select().from(documents).where(eq(documents.userId, id)).orderBy(desc(documents.createdAt)),
    db
      .select({ id: reports.id, reason: reports.reason, status: reports.status, createdAt: reports.createdAt })
      .from(reports)
      .innerJoin(profiles, eq(profiles.id, reports.targetProfileId))
      .where(eq(profiles.userId, id))
      .orderBy(desc(reports.createdAt))
      .limit(50),
    db
      .select()
      .from(adminActions)
      .where(and(eq(adminActions.targetType, 'user'), eq(adminActions.targetId, id)))
      .orderBy(desc(adminActions.createdAt))
      .limit(20),
  ]);
  return {
    user: u,
    kyc: kyc.map(({ cardFileId, selfieFileId, ...k }) => ({ ...k, cardUrl: signed(cardFileId), selfieUrl: signed(selfieFileId) })),
    documents: docs.map(({ fileId, ...d }) => ({ ...d, fileUrl: signed(fileId) })),
    reportsAgainst: reps,
    actions,
  };
}

async function targetUser(admin: User, id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!u || u.status === 'deleted') throw notFound('کاربر پیدا نشد');
  if (u.id === admin.id) throw forbidden('روی حساب خودت نمی‌توانی این کار را بکنی', 'SELF');
  if (u.isAdmin) throw forbidden('حساب ادمین را از این‌جا نمی‌شود مسدود کرد', 'TARGET_ADMIN');
  return u;
}

export async function suspendUser(admin: User, id: string, reason: string) {
  const u = await targetUser(admin, id);
  if (u.status === 'suspended') throw conflict('این حساب از قبل مسدود است', 'ALREADY_SUSPENDED');
  await db.transaction(async (tx) => {
    await tx.update(users).set({ status: 'suspended', updatedAt: new Date() }).where(eq(users.id, id));
    // همهٔ نشست‌ها بسته می‌شوند
    await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, id), sql`${refreshTokens.revokedAt} is null`));
    await log(tx, admin, 'user.suspend', 'user', id, reason);
  });
}

export async function unsuspendUser(admin: User, id: string, note?: string) {
  const u = await targetUser(admin, id);
  if (u.status !== 'suspended') throw conflict('این حساب مسدود نیست', 'NOT_SUSPENDED');
  await db.transaction(async (tx) => {
    await tx.update(users).set({ status: 'active', updatedAt: new Date() }).where(eq(users.id, id));
    await log(tx, admin, 'user.unsuspend', 'user', id, note);
  });
  await notify(id, { type: 'id', title: 'حساب شما دوباره فعال شد' });
}

/* ---------- آگهی ---------- */

export async function removeAd(admin: User, id: string, reason: string) {
  const [row] = await db
    .select({ ad: ads, userId: profiles.userId })
    .from(ads)
    .innerJoin(profiles, eq(profiles.id, ads.profileId))
    .where(eq(ads.id, id))
    .limit(1);
  if (!row) throw notFound('آگهی پیدا نشد');
  if (row.ad.status === 'removed') throw conflict('این آگهی قبلاً حذف شده است', 'ALREADY_REMOVED');
  await db.transaction(async (tx) => {
    await tx.update(ads).set({ status: 'removed', updatedAt: new Date() }).where(eq(ads.id, id));
    await log(tx, admin, 'ad.remove', 'ad', id, reason);
  });
  await notify(row.userId, { type: 'id', title: `آگهی «${row.ad.title}» حذف شد`, body: reason });
}

/* ---------- ردپای کارها ---------- */

export async function listActions(q: Page & { targetId?: string }) {
  const rows = await db
    .select({ a: adminActions, adminPhone: users.phone })
    .from(adminActions)
    .leftJoin(users, eq(users.id, adminActions.adminUserId))
    .where(q.targetId ? eq(adminActions.targetId, q.targetId) : undefined)
    .orderBy(desc(adminActions.createdAt))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);
  return rows.map(({ a, adminPhone }) => ({ ...a, adminPhone }));
}
