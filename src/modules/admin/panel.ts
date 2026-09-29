/**
 * پنل ادمین (blookblu-admin): ورود مدیر، نقش‌ها و دسترسی‌ها، مدیران، و «تصویر لحظه‌ای» داده‌ها.
 * پنل همهٔ داده‌ها را در مرورگر نگه می‌دارد و خودش فیلتر می‌کند؛ پس /snapshot هر بخش را
 * فقط وقتی برمی‌گرداند که مدیر دسترسی مشاهدهٔ آن را داشته باشد، و با محدودهٔ استان او فیلتر می‌کند.
 * (برای چند ده هزار کاربر باید صفحه‌بندی سمت سرور بیاید؛ سقف هر فهرست پایین مشخص است.)
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  ADMIN_MODULES,
  adminActions,
  adminRoles,
  admins,
  ads,
  arbiters,
  arbitrationCases,
  contracts,
  conversations,
  disputes,
  documents,
  guarantees,
  kycRequests,
  profiles,
  projectPayments,
  projects,
  reports,
  users,
  type AdminModule,
  type AdminPerms,
} from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { normalizePhone } from '../../lib/text';
import { perm, requireAdmin, type AdminCtx } from '../../middlewares/auth';
import { fileUrl, publicFileUrl } from '../files/files.service';
import { notify } from '../notifications/notify';
import { trustOf } from '../profiles/profiles.service';
import { adminLog } from './admin.service';
import { ARB_FIELDS, type ArbField } from '../arbitration/fees';
import { arbiterBalances, moreSections } from './panel-more';

const r = Router();
r.use(requireAdmin);

const can = (a: AdminCtx, m: AdminModule, lvl = 1) => (a.perms[m] ?? 0) >= lvl;
/** شرط محدودهٔ استان روی یک ستون استان */
const scoped = (a: AdminCtx, col: Parameters<typeof inArray>[0]) => (a.provinces.length ? inArray(col, a.provinces) : undefined);
const signed = (id: string | null | undefined) => (id ? fileUrl({ id, isPublic: false }) : null);

/* ================= مدیر فعلی ================= */

r.get(
  '/me',
  ah(async (req, res) => {
    const a = req.admin!;
    const roles = await db.select().from(adminRoles);
    res.json({
      admin: { ...a, phone: req.user!.phone, userId: req.user!.id },
      modules: ADMIN_MODULES,
      roles,
    });
  }),
);

/* ================= تصویر لحظه‌ای ================= */

async function usersSection(a: AdminCtx, withKyc: boolean) {
  const inScope = a.provinces.length
    ? sql`exists (select 1 from ${profiles} sp where sp.user_id = ${users.id} and sp.province in (${sql.join(a.provinces.map((p) => sql`${p}`), sql`, `)}))`
    : undefined;
  const us = await db
    .select()
    .from(users)
    .where(and(ne(users.status, 'deleted'), inScope))
    .orderBy(desc(users.createdAt))
    .limit(2000);
  if (!us.length) return [];
  const ids = us.map((u) => u.id);
  const [ps, reps, kyc, docs] = await Promise.all([
    db.select().from(profiles).where(inArray(profiles.userId, ids)),
    db
      .select({ userId: profiles.userId, n: sql<number>`count(*)::int` })
      .from(reports)
      .innerJoin(profiles, eq(profiles.id, reports.targetProfileId))
      .where(inArray(profiles.userId, ids))
      .groupBy(profiles.userId),
    withKyc
      ? db.selectDistinctOn([kycRequests.userId]).from(kycRequests).where(inArray(kycRequests.userId, ids)).orderBy(kycRequests.userId, desc(kycRequests.createdAt))
      : Promise.resolve([] as (typeof kycRequests.$inferSelect)[]),
    withKyc ? db.select().from(documents).where(inArray(documents.userId, ids)).orderBy(desc(documents.createdAt)) : Promise.resolve([] as (typeof documents.$inferSelect)[]),
  ]);
  return us.map((u) => {
    const mine = ps.filter((p) => p.userId === u.id);
    const main = mine.find((p) => p.role === u.activeRole) ?? mine[0];
    const d = (main?.data ?? {}) as Record<string, unknown>;
    const k = kyc.find((x) => x.userId === u.id);
    return {
      id: u.id,
      phone: u.phone,
      status: u.status,
      kycStatus: u.kycStatus,
      isAdmin: u.isAdmin,
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt,
      firstName: u.firstName,
      lastName: u.lastName,
      roles: mine.map((p) => p.role),
      profile: main
        ? {
            id: main.id,
            code: main.code,
            role: main.role,
            name: main.displayName,
            title: main.title,
            bio: main.bio,
            province: main.province,
            city: main.city,
            workRange: main.workRange,
            isPublic: main.isPublic,
            showPhone: main.showPhone,
            verified: main.verified,
            rating: main.ratingAvg,
            ratingCount: main.ratingCount,
            doneCount: main.doneCount,
            avatarUrl: publicFileUrl(main.avatarFileId),
            skills: (d.skills ?? d.services ?? d.kinds ?? d.areas ?? []) as string[],
            exp: (d.exp as string) ?? null,
            nat: (d.nat as string) ?? 'ایرانی',
            natc: (d.natc as string) ?? null,
            idType: withKyc ? ((d.idType as string) ?? null) : null,
            trust: trustOf(main, u.kycStatus === 'verified').total,
          }
        : null,
      reportsAgainst: reps.find((x) => x.userId === u.id)?.n ?? 0,
      kyc: k
        ? { id: k.id, status: k.status, idType: k.idType, idNumber: k.idNumber, firstName: k.firstName, lastName: k.lastName, cardUrl: signed(k.cardFileId), selfieUrl: signed(k.selfieFileId), rejectReason: k.rejectReason, createdAt: k.createdAt }
        : null,
      docs: docs
        .filter((x) => x.userId === u.id)
        .map((x) => ({ id: x.id, title: x.title, group: x.group, status: x.status, profileId: x.profileId, url: signed(x.fileId), rejectReason: x.rejectReason, expiresAt: x.expiresAt, createdAt: x.createdAt })),
    };
  });
}

async function adsSection(a: AdminCtx) {
  const rows = await db
    .select({ ad: ads, userId: profiles.userId, code: profiles.code, name: profiles.displayName, role: profiles.role })
    .from(ads)
    .innerJoin(profiles, eq(profiles.id, ads.profileId))
    .where(scoped(a, ads.province))
    .orderBy(desc(ads.createdAt))
    .limit(1500);
  return rows.map(({ ad, ...w }) => ({ ...ad, author: w }));
}

async function reportsSection(a: AdminCtx) {
  const rows = await db
    .select({ r: reports, targetUserId: profiles.userId, targetCode: profiles.code, targetProvince: profiles.province })
    .from(reports)
    .leftJoin(profiles, eq(profiles.id, reports.targetProfileId))
    .where(a.provinces.length ? inArray(profiles.province, a.provinces) : undefined)
    .orderBy(desc(reports.createdAt))
    .limit(500);
  return rows.map(({ r: x, ...t }) => ({ ...x, ...t }));
}

async function projectsSection(a: AdminCtx) {
  const rows = await db
    .select({ p: projects, clientUserId: profiles.userId, clientProvince: profiles.province })
    .from(projects)
    .innerJoin(profiles, eq(profiles.id, projects.clientProfileId))
    .where(scoped(a, profiles.province))
    .orderBy(desc(projects.createdAt))
    .limit(1000);
  if (!rows.length) return [];
  const ids = rows.map((x) => x.p.id);
  const [prov, ctr, pays] = await Promise.all([
    db.select({ id: profiles.id, userId: profiles.userId }).from(profiles).where(inArray(profiles.id, rows.map((x) => x.p.providerProfileId))),
    db.select({ projectId: contracts.projectId, status: contracts.status, number: contracts.number }).from(contracts).where(inArray(contracts.projectId, ids)),
    db
      .select({
        projectId: projectPayments.projectId,
        confirmed: sql<number>`coalesce(sum(${projectPayments.amount}) filter (where ${projectPayments.status} = 'confirmed'), 0)::bigint`,
        disputed: sql<number>`count(*) filter (where ${projectPayments.status} = 'disputed')::int`,
        n: sql<number>`count(*)::int`,
      })
      .from(projectPayments)
      .where(inArray(projectPayments.projectId, ids))
      .groupBy(projectPayments.projectId),
  ]);
  return rows.map(({ p, clientUserId }) => {
    const pay = pays.find((x) => x.projectId === p.id);
    return {
      ...p,
      clientUserId,
      providerUserId: prov.find((x) => x.id === p.providerProfileId)?.userId ?? null,
      contract: ctr.find((x) => x.projectId === p.id) ?? null,
      paid: Number(pay?.confirmed ?? 0),
      paymentsDisputed: pay?.disputed ?? 0,
      paymentsCount: pay?.n ?? 0,
    };
  });
}

async function disputesSection(a: AdminCtx) {
  const rows = await db
    .select({ d: disputes, openerUserId: profiles.userId })
    .from(disputes)
    .innerJoin(profiles, eq(profiles.id, disputes.openedByProfileId))
    .where(scoped(a, disputes.province))
    .orderBy(desc(disputes.createdAt))
    .limit(500);
  if (!rows.length) return [];
  const ids = rows.map((x) => x.d.id);
  const [against, cases, arbs] = await Promise.all([
    db.select({ id: profiles.id, userId: profiles.userId }).from(profiles).where(inArray(profiles.id, rows.map((x) => x.d.againstProfileId))),
    db.select().from(arbitrationCases).where(inArray(arbitrationCases.disputeId, ids)).orderBy(arbitrationCases.round, arbitrationCases.createdAt),
    db.select({ id: arbiters.id, userId: arbiters.userId }).from(arbiters),
  ]);
  return rows.map(({ d, openerUserId }) => ({
    ...d,
    openerUserId,
    againstUserId: against.find((x) => x.id === d.againstProfileId)?.userId ?? null,
    cases: cases
      .filter((c) => c.disputeId === d.id)
      .map((c) => ({ ...c, fieldName: ARB_FIELDS[c.field as ArbField]?.name ?? c.field, arbiterUserId: arbs.find((x) => x.id === c.arbiterId)?.userId ?? null, photos: c.photoFileIds.map((id) => signed(id)) })),
  }));
}

async function arbitersSection(a: AdminCtx) {
  const rows = await db
    .select({ a: arbiters, province: profiles.province, city: profiles.city, code: profiles.code, name: profiles.displayName, role: profiles.role })
    .from(arbiters)
    .innerJoin(profiles, eq(profiles.id, arbiters.profileId))
    .where(scoped(a, profiles.province))
    .orderBy(desc(arbiters.createdAt));
  const bal = await arbiterBalances();
  return rows.map(({ a: x, ...p }) => {
    const b = bal.get(x.id) ?? { released: 0, paidOut: 0, pending: 0 };
    return { ...x, ...p, docUrl: signed(x.docFileId), earned: b.released, paidOut: b.paidOut, pending: b.pending };
  });
}

async function guarSection(a: AdminCtx) {
  const rows = await db
    .select({ g: guarantees, userId: profiles.userId, code: profiles.code, province: profiles.province })
    .from(guarantees)
    .innerJoin(profiles, eq(profiles.id, guarantees.profileId))
    .where(scoped(a, profiles.province))
    .orderBy(desc(guarantees.createdAt))
    .limit(1000);
  return rows.map(({ g, ...p }) => ({ ...g, ...p }));
}

async function adminsSection() {
  const rows = await db
    .select({ a: admins, phone: users.phone })
    .from(admins)
    .innerJoin(users, eq(users.id, admins.userId))
    .orderBy(admins.createdAt);
  return rows.map(({ a, phone }) => ({ ...a, phone }));
}

async function auditSection() {
  const rows = await db
    .select({ x: adminActions, name: admins.name, phone: users.phone })
    .from(adminActions)
    .leftJoin(admins, eq(admins.userId, adminActions.adminUserId))
    .leftJoin(users, eq(users.id, adminActions.adminUserId))
    .orderBy(desc(adminActions.createdAt))
    .limit(300);
  return rows.map(({ x, name, phone }) => ({ ...x, adminName: name ?? phone }));
}

async function statsSection(a: AdminCtx) {
  const since = new Date(Date.now() - 29 * 86400_000);
  const series = async (table: 'users' | 'ads' | 'contracts') => {
    const { rows } = await db.execute<{ d: string; n: number }>(sql`
      select to_char(g.d, 'YYYY-MM-DD') as d, coalesce(x.n, 0)::int as n
      from generate_series(date_trunc('day', ${since}::timestamptz), date_trunc('day', now()), interval '1 day') g(d)
      left join (
        select date_trunc('day', ${sql.raw(table === 'contracts' ? 'activated_at' : 'created_at')}) d, count(*) n
        from ${sql.raw(table)} where ${sql.raw(table === 'contracts' ? 'activated_at' : 'created_at')} >= ${since}
        group by 1
      ) x on x.d = g.d order by g.d`);
    return rows.map((r) => r.n);
  };
  const scope = a.provinces.length ? inArray(profiles.province, a.provinces) : undefined;
  const [signups, adsDaily, dealsDaily, byRole, byProv, byType, [online], [convToday], [pend], [escrow]] = await Promise.all([
    series('users'),
    series('ads'),
    series('contracts'),
    db.select({ role: profiles.role, n: sql<number>`count(*)::int` }).from(profiles).where(scope).groupBy(profiles.role),
    db.select({ province: profiles.province, n: sql<number>`count(*)::int` }).from(profiles).where(scope).groupBy(profiles.province),
    db.select({ type: ads.type, status: ads.status, n: sql<number>`count(*)::int` }).from(ads).groupBy(ads.type, ads.status),
    db.select({ n: sql<number>`count(*)::int` }).from(users).where(gte(users.lastSeenAt, new Date(Date.now() - 10 * 60_000))),
    db.select({ n: sql<number>`count(*)::int` }).from(conversations).where(gte(conversations.lastMessageAt, new Date(Date.now() - 86400_000))),
    db
      .select({
        kyc: sql<number>`(select count(*) from ${kycRequests} where status = 'pending')::int`,
        docs: sql<number>`(select count(*) from ${documents} where status = 'pending')::int`,
        reports: sql<number>`(select count(*) from ${reports} where status in ('open', 'reviewing'))::int`,
        disputes: sql<number>`(select count(*) from ${disputes} where status in ('open', 'arbitration'))::int`,
        unpaid: sql<number>`(select count(*) from ${arbitrationCases} where status = 'awaiting_payment')::int`,
        arbiters: sql<number>`(select count(*) from ${arbiters} where status = 'pending')::int`,
        flagged: sql<number>`(select count(*) from messages where flagged = true and created_at > now() - interval '7 days')::int`,
        activeProjects: sql<number>`(select count(*) from ${projects} where status = 'active' and stage = 2)::int`,
      })
      .from(sql`(select 1) one`),
    db
      .select({ sum: sql<number>`coalesce(sum(${arbitrationCases.total}), 0)::bigint` })
      .from(arbitrationCases)
      .where(eq(arbitrationCases.paymentStatus, 'paid')),
  ]);
  return {
    signups,
    adsDaily,
    dealsDaily,
    byRole,
    byProvince: byProv,
    adsByType: byType,
    onlineNow: online.n,
    conversationsToday: convToday.n,
    pending: pend,
    escrowHeld: Number(escrow.sum),
  };
}

r.get(
  '/snapshot',
  ah(async (req, res) => {
    const a = req.admin!;
    const out: Record<string, unknown> = { at: new Date() };
    const jobs: Promise<void>[] = [];
    const add = (key: string, m: AdminModule | null, fn: () => Promise<unknown>) => {
      if (!m || can(a, m)) jobs.push(fn().then((v) => void (out[key] = v)));
    };
    // کاربران برای نام‌ها در همهٔ بخش‌ها لازم است؛ مدارک و کد ملی فقط با دسترسی احراز
    if (can(a, 'users') || can(a, 'kyc')) jobs.push(usersSection(a, can(a, 'kyc')).then((v) => void (out.users = v)));
    add('ads', 'ads', () => adsSection(a));
    add('reports', 'reports', () => reportsSection(a));
    add('projects', 'projects', () => projectsSection(a));
    add('disputes', 'disputes', () => disputesSection(a));
    add('arbiters', 'arbiters', () => arbitersSection(a));
    add('guarantees', 'guar', () => guarSection(a));
    add('admins', 'admins', () => adminsSection());
    add('audit', 'audit', () => auditSection());
    add('stats', 'dash', () => statsSection(a));
    moreSections(a, add);
    await Promise.all(jobs);
    res.json(out);
  }),
);

/* ================= نقش‌ها ================= */

const permsSchema = z.record(z.enum(ADMIN_MODULES), z.union([z.literal(0), z.literal(1), z.literal(2)]));

r.patch(
  '/roles/:key',
  perm('admins', 2),
  ah(async (req, res) => {
    const { key } = parse(z.object({ key: z.string().max(20) }), req.params);
    const body = parse(z.object({ perms: permsSchema.optional(), name: z.string().trim().min(2).max(40).optional(), color: z.string().max(12).optional() }), req.body);
    const [role] = await db.select().from(adminRoles).where(eq(adminRoles.key, key)).limit(1);
    if (!role) throw notFound('نقش پیدا نشد');
    if (role.fixed) throw forbidden('دسترسی «مدیر ارشد» قابل تغییر نیست', 'ROLE_FIXED');
    const perms: AdminPerms = { ...role.perms, ...(body.perms ?? {}) };
    const [nr] = await db
      .update(adminRoles)
      .set({ perms, name: body.name ?? role.name, color: body.color ?? role.color, updatedAt: new Date() })
      .where(eq(adminRoles.key, key))
      .returning();
    await adminLog(db, req.user!, 'role.update', 'admin_role', '00000000-0000-0000-0000-000000000000', `${role.name}: ${JSON.stringify(body.perms ?? {})}`);
    res.json({ role: nr });
  }),
);

r.post(
  '/roles',
  perm('admins', 2),
  ah(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(2).max(40), color: z.string().max(12).default('#34D399') }), req.body);
    const perms = Object.fromEntries(ADMIN_MODULES.map((m) => [m, m === 'dash' ? 1 : 0])) as AdminPerms;
    const key = 'r' + Date.now().toString(36);
    const [role] = await db.insert(adminRoles).values({ key, name: body.name, color: body.color, perms }).returning();
    await adminLog(db, req.user!, 'role.create', 'admin_role', '00000000-0000-0000-0000-000000000000', body.name);
    res.status(201).json({ role });
  }),
);

/* ================= مدیران ================= */

const adminInput = z.object({
  roleKey: z.string().max(20),
  name: z.string().trim().min(2).max(80),
  provinces: z.array(z.string().trim().min(2).max(60)).max(31).default([]),
});

r.post(
  '/admins',
  perm('admins', 2),
  ah(async (req, res) => {
    const body = parse(adminInput.extend({ phone: z.string() }), req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('شمارهٔ موبایل معتبر نیست', 'BAD_PHONE');
    const [role] = await db.select().from(adminRoles).where(eq(adminRoles.key, body.roleKey)).limit(1);
    if (!role) throw badRequest('نقش معتبر نیست', 'BAD_ROLE');
    if (role.key === 'owner' && req.admin!.roleKey !== 'owner') throw forbidden('فقط مدیر ارشد می‌تواند مدیر ارشد تازه بسازد', 'OWNER_ONLY');
    // کاربر اگر نبود ساخته می‌شود؛ بعداً با همین شماره و کد پیامکی وارد پنل می‌شود
    let [u] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
    if (!u) [u] = await db.insert(users).values({ phone }).returning();
    if (u.status === 'deleted') throw conflict('این حساب حذف شده است', 'USER_DELETED');
    const [exists] = await db.select({ id: admins.id }).from(admins).where(eq(admins.userId, u.id)).limit(1);
    if (exists) throw conflict('این شماره از قبل مدیر است', 'ADMIN_EXISTS');
    const [a] = await db.transaction(async (tx) => {
      const row = await tx.insert(admins).values({ userId: u.id, roleKey: role.key, name: body.name, provinces: body.provinces, createdBy: req.user!.id }).returning();
      await tx.update(users).set({ isAdmin: true, updatedAt: new Date() }).where(eq(users.id, u.id));
      await adminLog(tx, req.user!, 'admin.create', 'admin', row[0].id, `${body.name} · ${role.name}${body.provinces.length ? ' · ' + body.provinces.join('، ') : ''}`);
      return row;
    });
    res.status(201).json({ admin: { ...a, phone } });
  }),
);

r.patch(
  '/admins/:id',
  perm('admins', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(adminInput.partial().extend({ status: z.enum(['active', 'disabled']).optional() }), req.body);
    const [cur] = await db.select().from(admins).where(eq(admins.id, id)).limit(1);
    if (!cur) throw notFound('مدیر پیدا نشد');
    if (cur.id === req.admin!.id && (body.roleKey || body.status)) throw forbidden('نقش یا وضعیت خودت را نمی‌توانی عوض کنی', 'SELF');
    if (cur.roleKey === 'owner' && req.admin!.roleKey !== 'owner') throw forbidden('فقط مدیر ارشد می‌تواند مدیر ارشد را تغییر دهد', 'OWNER_ONLY');
    if (body.roleKey) {
      const [role] = await db.select().from(adminRoles).where(eq(adminRoles.key, body.roleKey)).limit(1);
      if (!role) throw badRequest('نقش معتبر نیست', 'BAD_ROLE');
    }
    // همیشه حداقل یک مدیر ارشد فعال بماند
    if (cur.roleKey === 'owner' && ((body.roleKey && body.roleKey !== 'owner') || body.status === 'disabled')) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(admins).where(and(eq(admins.roleKey, 'owner'), eq(admins.status, 'active')));
      if (n <= 1) throw conflict('حداقل یک مدیر ارشد فعال لازم است', 'LAST_OWNER');
    }
    const [a] = await db.transaction(async (tx) => {
      const row = await tx.update(admins).set({ ...body, updatedAt: new Date() }).where(eq(admins.id, id)).returning();
      if (body.status) await tx.update(users).set({ isAdmin: body.status === 'active' }).where(eq(users.id, cur.userId));
      await adminLog(tx, req.user!, 'admin.update', 'admin', id, JSON.stringify(body));
      return row;
    });
    res.json({ admin: a });
  }),
);

/* ================= آگهی‌ها و قیم‌ها ================= */

r.patch(
  '/ads/:id/status',
  perm('ads', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ status: z.enum(['active', 'paused', 'closed', 'removed']), reason: z.string().trim().max(500).optional() }), req.body);
    const [row] = await db.select({ ad: ads, userId: profiles.userId, province: profiles.province }).from(ads).innerJoin(profiles, eq(profiles.id, ads.profileId)).where(eq(ads.id, id)).limit(1);
    if (!row) throw notFound('آگهی پیدا نشد');
    const a = req.admin!;
    if (a.provinces.length && !a.provinces.includes(row.ad.province)) throw forbidden('این آگهی خارج از محدودهٔ استان توست', 'OUT_OF_SCOPE');
    const [nad] = await db.update(ads).set({ status: body.status, updatedAt: new Date() }).where(eq(ads.id, id)).returning();
    await adminLog(db, req.user!, 'ad.' + body.status, 'ad', id, body.reason);
    if (body.status === 'removed' || body.status === 'paused') {
      await notify(row.userId, { type: 'id', title: `آگهی «${row.ad.title}» ${body.status === 'removed' ? 'حذف' : 'متوقف'} شد`, body: body.reason });
    }
    res.json({ ad: nad });
  }),
);

r.patch(
  '/guarantees/:id',
  perm('guar', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['accepted', 'rejected']) }), req.body);
    const [g] = await db.update(guarantees).set({ status, respondedAt: new Date() }).where(eq(guarantees.id, id)).returning();
    if (!g) throw notFound('پیدا نشد');
    await adminLog(db, req.user!, 'guarantee.' + status, 'guarantee', id);
    res.json({ guarantee: g });
  }),
);

r.delete(
  '/guarantees/:id',
  perm('guar', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const [g] = await db.delete(guarantees).where(eq(guarantees.id, id)).returning();
    if (!g) throw notFound('پیدا نشد');
    await adminLog(db, req.user!, 'guarantee.delete', 'guarantee', id, `${g.guarantorName} · ${g.relation}`);
    res.json({ ok: true });
  }),
);

export default r;
