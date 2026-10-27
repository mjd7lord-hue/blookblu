/**
 * پنل ادمین — دور ۳۴:
 *   درخواست تغییر/افزودن نقش (دسترسی «کاربران»): فهرست، تأیید (باز کردن نقش برای کاربر)، رد، و تغییر مستقیم نقش یک کاربر
 *   نیروی فوری (دسترسی «آگهی‌ها»): فهرست درخواست‌ها با شمارش پیشنهادها و لغو
 * تأیید = users.role_unlock؛ کاربر در اپ فرم همان نقش را پر می‌کند ← نقش تازه فعال و (اگر «تغییر» بود) نقش قبلی پنهان.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { documents, profiles, projects, roleRequests, ROLES, strikes, urgentOffers, urgentRequests, users } from '../../db/schema';
import { alias } from 'drizzle-orm/pg-core';
import { confirmStrike, recomputeTrust } from '../trust/strikes';
import { ah, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { emitTo } from '../../lib/events';
import { perm, type AdminCtx } from '../../middlewares/auth';
import { notify } from '../notifications/notify';
import { checkFounder } from '../founders/founders.service';
import { adminLog } from './admin.service';

const ROLE_FA: Record<string, string> = { worker: 'کارگر', specialist: 'متخصص', engineer: 'مهندس', contractor: 'پیمانکار', company: 'شرکت ساختمانی', general: 'کارفرما' };

/** بخش snapshot: درخواست‌های نقش (همه، تازه‌ها اول) */
export async function roleRequestsSection() {
  const rows = await db
    .select({ r: roleRequests, phone: users.phone, firstName: users.firstName, lastName: users.lastName, activeRole: users.activeRole, roleUnlock: users.roleUnlock })
    .from(roleRequests)
    .innerJoin(users, eq(users.id, roleRequests.userId))
    .orderBy(sql`case ${roleRequests.status} when 'pending' then 0 when 'approved' then 1 else 2 end`, desc(roleRequests.createdAt))
    .limit(500);
  return rows.map(({ r, ...u }) => ({ ...r, user: { ...u, name: [u.firstName, u.lastName].filter(Boolean).join(' ') } }));
}

/** بخش snapshot: اخطارهای بدقولی (اعتراض‌ها اول) — دور ۳۶ */
export async function strikesSection(a: AdminCtx) {
  const by = alias(profiles, 'by_p');
  const rows = await db
    .select({ s: strikes, code: profiles.code, name: profiles.displayName, role: profiles.role, userId: profiles.userId, province: profiles.province, byName: by.displayName, byCode: by.code, project: projects.title })
    .from(strikes)
    .innerJoin(profiles, eq(profiles.id, strikes.profileId))
    .leftJoin(by, eq(by.id, strikes.byProfileId))
    .leftJoin(projects, eq(projects.id, strikes.projectId))
    .where(a.provinces.length ? inArray(profiles.province, a.provinces) : undefined)
    .orderBy(sql`case ${strikes.status} when 'disputed' then 0 when 'pending' then 1 else 2 end`, desc(strikes.createdAt))
    .limit(500);
  return rows.map(({ s, ...x }) => ({ ...s, ...x }));
}

/** بخش snapshot: نیروی فوری با شمارش پیشنهادها */
export async function urgentSection(a: AdminCtx) {
  const rows = await db
    .select({ q: urgentRequests, code: profiles.code, name: profiles.displayName, role: profiles.role, userId: profiles.userId })
    .from(urgentRequests)
    .innerJoin(profiles, eq(profiles.id, urgentRequests.clientProfileId))
    .where(a.provinces.length ? inArray(urgentRequests.province, a.provinces) : undefined)
    .orderBy(desc(urgentRequests.createdAt))
    .limit(500);
  if (!rows.length) return [];
  const counts = await db
    .select({ id: urgentOffers.requestId, status: urgentOffers.status, n: sql<number>`count(*)::int` })
    .from(urgentOffers)
    .where(inArray(urgentOffers.requestId, rows.map((x) => x.q.id)))
    .groupBy(urgentOffers.requestId, urgentOffers.status);
  return rows.map(({ q, ...c }) => {
    const n = (s: string) => counts.find((x) => x.id === q.id && x.status === s)?.n ?? 0;
    return { ...q, total: q.dailyWage * q.days, client: c, counts: { sent: q.sentCount, accepted: n('accepted'), declined: n('declined'), waiting: n('sent'), missed: n('missed') } };
  });
}

async function unlockRole(adminUser: { id: string }, userId: string, toRole: string, note?: string | null) {
  const own = await db.select({ role: profiles.role }).from(profiles).where(eq(profiles.userId, userId));
  if (own.some((p) => p.role === toRole)) throw conflict('کاربر این نقش را از قبل دارد', 'ROLE_EXISTS');
  await db.update(users).set({ roleUnlock: toRole as (typeof ROLES)[number], updatedAt: new Date() }).where(eq(users.id, userId));
  await notify(userId, {
    type: 'id',
    title: `نقش «${ROLE_FA[toRole]}» برایت باز شد`,
    body: note || 'از «من ← نقش‌های من» فرم همین نقش را پر کن؛ بعد از ثبت، نقش تازه فعال می‌شود.',
    link: { screen: 'roles' },
  });
  emitTo(userId, { type: 'notification', data: { roleUnlock: toRole } });
  void adminUser;
}

export function registerRoleRoutes(r: Router) {
  /**
   * تأیید دستی هویت (دور ۴۰): کاربری که به‌جای «تأیید هویت» (کارت + سلفی) فقط «کارت ملی» را در «مدارک من» فرستاده.
   * فقط اگر مدرک گروه «هویت» (در انتظار یا تأییدشده) دارد؛ مدارک هویتِ در انتظار هم تأیید می‌شوند.
   */
  r.post(
    '/users/:id/verify-identity',
    perm('kyc', 2),
    ah(async (req, res) => {
      const { id } = parse(uuidParam, req.params);
      const b = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body ?? {});
      const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (!u) throw notFound('کاربر پیدا نشد');
      if (u.kycStatus === 'verified') throw conflict('هویت این کاربر از قبل تأیید شده', 'ALREADY_VERIFIED');
      const ids = await db
        .select({ id: documents.id, status: documents.status })
        .from(documents)
        .where(and(eq(documents.userId, id), eq(documents.group, 'هویت'), inArray(documents.status, ['pending', 'approved'])));
      if (!ids.length) throw badRequest('این کاربر مدرک هویتی (کارت ملی) نفرستاده؛ اول باید در اپ «تأیید هویت» را انجام دهد', 'NO_ID_DOCUMENT');
      await db.transaction(async (tx) => {
        await tx.update(users).set({ kycStatus: 'verified', updatedAt: new Date() }).where(eq(users.id, id));
        const pend = ids.filter((x) => x.status === 'pending').map((x) => x.id);
        if (pend.length) await tx.update(documents).set({ status: 'approved', reviewedBy: req.user!.id, reviewedAt: new Date() }).where(inArray(documents.id, pend));
        await adminLog(tx, req.user!, 'kyc.manual', 'user', id, b.note || 'تأیید دستی بر اساس مدرک «کارت ملی»');
      });
      await notify(id, { type: 'id', title: 'هویت شما تأیید شد', body: 'مهر «هویت تأیید شد» روی شناسنامهٔ کاری‌ات خورد و ۱۰ امتیاز اعتبار گرفتی.', link: { screen: 'trust' } });
      await checkFounder(id);
      res.json({ ok: true });
    }),
  );

  /** تصمیم مدیر دربارهٔ اخطار بدقولی: تأیید (اثر کامل) یا رد (پاک از امتیاز) */
  r.post(
    '/strikes/:id/decide',
    perm('reports', 2),
    ah(async (req, res) => {
      const { id } = parse(uuidParam, req.params);
      const b = parse(z.object({ confirm: z.boolean(), note: z.string().trim().max(500).optional() }), req.body);
      const [s0] = await db.select().from(strikes).where(eq(strikes.id, id)).limit(1);
      if (!s0) throw notFound('پیدا نشد');
      const [who] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.id, s0.profileId)).limit(1);
      let s;
      if (b.confirm) {
        if (s0.status === 'confirmed') throw conflict('این اخطار از قبل ثبت شده', 'ALREADY_DECIDED');
        s = await confirmStrike(id, req.user!.id);
      } else {
        if (s0.status === 'dismissed') throw conflict('این اخطار از قبل رد شده', 'ALREADY_DECIDED');
        [s] = await db.update(strikes).set({ status: 'dismissed', decidedAt: new Date(), decidedBy: req.user!.id }).where(eq(strikes.id, id)).returning();
        // اخطار ثبت‌شده‌ای که مدیر لغو کرد: امتیاز خودش و قیم‌هایش برمی‌گردد
        await recomputeTrust();
        if (who) await notify(who.userId, { type: 'id', title: 'اخطار بدقولی شما لغو شد', body: b.note || 'مدیر بلوک بررسی کرد و اخطار را رد کرد.', link: { screen: 'strikes' } });
      }
      if (s0.byProfileId) {
        const [by] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.id, s0.byProfileId)).limit(1);
        if (by) await notify(by.userId, { type: 'id', title: b.confirm ? 'بدقولی ثبت‌شده تأیید شد' : 'بدقولی ثبت‌شده رد شد', body: b.note, link: { screen: 'strikes' } });
      }
      await adminLog(db, req.user!, b.confirm ? 'strike.confirm' : 'strike.dismiss', 'strike', id, b.note);
      res.json({ strike: s });
    }),
  );

  r.post(
    '/role-requests/:id/approve',
    perm('users', 2),
    ah(async (req, res) => {
      const { id } = parse(uuidParam, req.params);
      const b = parse(z.object({ mode: z.enum(['add', 'switch']).optional(), note: z.string().trim().max(500).optional() }), req.body);
      const [rq] = await db.select().from(roleRequests).where(eq(roleRequests.id, id)).limit(1);
      if (!rq) throw notFound('درخواست پیدا نشد');
      if (rq.status !== 'pending') throw conflict('این درخواست قبلاً بررسی شده است', 'NOT_PENDING');
      await unlockRole(req.user!, rq.userId, rq.toRole, b.note);
      const [nr] = await db
        .update(roleRequests)
        .set({ status: 'approved', mode: b.mode ?? rq.mode, adminNote: b.note || null, decidedBy: req.user!.id, decidedAt: new Date() })
        .where(eq(roleRequests.id, id))
        .returning();
      await adminLog(db, req.user!, 'role_request_approve', 'user', rq.userId, `${rq.fromRole ?? '—'} → ${rq.toRole} (${nr.mode})`);
      res.json({ request: nr });
    }),
  );
  r.post(
    '/role-requests/:id/reject',
    perm('users', 2),
    ah(async (req, res) => {
      const { id } = parse(uuidParam, req.params);
      const b = parse(z.object({ reason: z.string().trim().min(3, 'دلیل را بنویس').max(500) }), req.body);
      const [rq] = await db.select().from(roleRequests).where(eq(roleRequests.id, id)).limit(1);
      if (!rq) throw notFound('درخواست پیدا نشد');
      if (rq.status !== 'pending') throw conflict('این درخواست قبلاً بررسی شده است', 'NOT_PENDING');
      const [nr] = await db
        .update(roleRequests)
        .set({ status: 'rejected', adminNote: b.reason, decidedBy: req.user!.id, decidedAt: new Date() })
        .where(eq(roleRequests.id, id))
        .returning();
      await notify(rq.userId, { type: 'id', title: `درخواست نقش «${ROLE_FA[rq.toRole]}» رد شد`, body: b.reason, link: { screen: 'roles' } });
      await adminLog(db, req.user!, 'role_request_reject', 'user', rq.userId, b.reason);
      res.json({ request: nr });
    }),
  );
  /** تغییر مستقیم نقش یک کاربر از پنل (بدون درخواست): نقش باز می‌شود و یک ردیف «تأییدشده» ثبت می‌شود */
  r.post(
    '/users/:id/role-unlock',
    perm('users', 2),
    ah(async (req, res) => {
      const { id } = parse(uuidParam, req.params);
      const b = parse(z.object({ role: z.enum(ROLES), mode: z.enum(['add', 'switch']).default('switch'), note: z.string().trim().max(500).optional() }), req.body);
      const [u] = await db.select({ id: users.id, activeRole: users.activeRole }).from(users).where(eq(users.id, id)).limit(1);
      if (!u) throw notFound('کاربر پیدا نشد');
      await db.update(roleRequests).set({ status: 'cancelled' }).where(and(eq(roleRequests.userId, id), eq(roleRequests.status, 'pending')));
      await unlockRole(req.user!, id, b.role, b.note);
      const [nr] = await db
        .insert(roleRequests)
        .values({ userId: id, fromRole: u.activeRole, toRole: b.role, mode: b.mode, note: 'از پنل مدیریت', status: 'approved', adminNote: b.note || null, decidedBy: req.user!.id, decidedAt: new Date() })
        .returning();
      await adminLog(db, req.user!, 'role_unlock', 'user', id, `${u.activeRole ?? '—'} → ${b.role} (${b.mode})`);
      res.status(201).json({ request: nr });
    }),
  );
  /** لغو درخواست نیروی فوری از پنل */
  r.post(
    '/urgent/:id/cancel',
    perm('ads', 2),
    ah(async (req, res) => {
      const { id } = parse(uuidParam, req.params);
      const b = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body);
      const [q] = await db.update(urgentRequests).set({ status: 'cancelled' }).where(and(eq(urgentRequests.id, id), eq(urgentRequests.status, 'open'))).returning();
      if (!q) throw badRequest('درخواست باز پیدا نشد', 'NOT_OPEN');
      await db.update(urgentOffers).set({ status: 'missed', respondedAt: new Date() }).where(and(eq(urgentOffers.requestId, id), eq(urgentOffers.status, 'sent')));
      const [c] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.id, q.clientProfileId)).limit(1);
      if (c) await notify(c.userId, { type: 'req', title: 'درخواست نیروی فوری‌ات را پشتیبانی بست', body: b.reason || q.title, link: { screen: 'urgent', id } });
      await adminLog(db, req.user!, 'urgent_cancel', 'urgent', id, b.reason);
      res.json({ request: q });
    }),
  );
}
