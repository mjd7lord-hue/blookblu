/**
 * /api/visits — رزرو بازدید حضوری مهندس:
 * کارفرما/پیمانکار روز (از روزهای آزاد هفتهٔ مهندس) و ساعت را انتخاب می‌کند ← مهندس تأیید یا رد می‌کند ←
 * بعد از بازدید، مهندس چک‌لیست و گزارش را ثبت می‌کند. هزینه بعد از بازدید مستقیم پرداخت می‌شود.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { db } from '../../db';
import { profiles, visits } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { cfg } from '../../lib/appConfig';
import { addDays, faDay, isDay, tehranDay, weekIndex } from '../../lib/dates';
import { normalizeFa } from '../../lib/text';
import { optionalAuth, requireAuth, requireProfile } from '../../middlewares/auth';
import { notify } from '../notifications/notify';
import { publicFileUrl } from '../files/files.service';

// ساعت‌های بازدید (هم‌تراز با VSLOT فرانت)
export const VISIT_SLOTS = ['۸:۰۰', '۱۰:۰۰', '۱۲:۰۰', '۱۶:۰۰'] as const;
const HORIZON_DAYS = 14;
const ACTIVE = ['requested', 'confirmed'] as const;

const r = Router();

async function engineerByCode(code: string) {
  const [p] = await db.select().from(profiles).where(eq(profiles.code, code.toUpperCase())).limit(1);
  if (!p || p.role !== 'engineer') throw notFound('مهندس پیدا نشد');
  return p;
}

/** روزهای پیش رو با وضعیت (آزاد طبق هفتهٔ مهندس) و ساعت‌های رزروشده */
r.get(
  '/slots/:code',
  optionalAuth,
  ah(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().max(12) }), req.params);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(HORIZON_DAYS).default(7) }), req.query);
    const eng = await engineerByCode(code);
    const from = tehranDay(1); // از فردا
    const to = addDays(from, days - 1);
    const taken = await db
      .select({ day: visits.day, slot: visits.slot })
      .from(visits)
      .where(and(eq(visits.engineerProfileId, eng.id), inArray(visits.status, [...ACTIVE]), gte(visits.day, from), lte(visits.day, to)));
    const out = Array.from({ length: days }, (_, i) => {
      const day = addDays(from, i);
      const w = weekIndex(day);
      return { day, label: faDay(day), weekday: w, open: eng.week[w] === 'a', taken: taken.filter((t) => t.day === day).map((t) => t.slot) };
    });
    res.json({ slots: VISIT_SLOTS, types: cfg('visitTypes'), days: out });
  }),
);

const shape = (v: typeof visits.$inferSelect, me: string[], ps: Map<string, typeof profiles.$inferSelect>) => {
  const client = ps.get(v.clientProfileId);
  const eng = ps.get(v.engineerProfileId);
  const card = (p?: typeof profiles.$inferSelect) =>
    p && { code: p.code, role: p.role, name: p.displayName, title: p.title, city: p.city, verified: p.verified, avatarUrl: publicFileUrl(p.avatarFileId) };
  return { ...v, dayLabel: faDay(v.day), as: me.includes(v.engineerProfileId) ? 'engineer' : 'client', client: card(client), engineer: card(eng) };
};

async function myProfileIds(userId: string) {
  return (await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId))).map((x) => x.id);
}

async function withProfiles(rows: (typeof visits.$inferSelect)[]) {
  const ids = [...new Set(rows.flatMap((v) => [v.clientProfileId, v.engineerProfileId]))];
  const ps = ids.length ? await db.select().from(profiles).where(inArray(profiles.id, ids)) : [];
  return new Map(ps.map((p) => [p.id, p]));
}

r.get(
  '/',
  requireAuth,
  ah(async (req, res) => {
    const mine = await myProfileIds(req.user!.id);
    if (!mine.length) return res.json({ items: [] });
    const rows = await db
      .select()
      .from(visits)
      .where(or(inArray(visits.clientProfileId, mine), inArray(visits.engineerProfileId, mine)))
      .orderBy(desc(visits.day), desc(visits.createdAt))
      .limit(200);
    const ps = await withProfiles(rows);
    res.json({ items: rows.map((v) => shape(v, mine, ps)) });
  }),
);

r.post(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const body = parse(
      z.object({
        engineerCode: z.string().max(12),
        type: z.number().int().min(0).max(19),
        day: z.string().refine(isDay, 'تاریخ معتبر نیست'),
        slot: z.enum(VISIT_SLOTS),
        address: z.string().trim().min(5).max(500),
        note: z.string().trim().max(500).optional(),
      }),
      req.body,
    );
    const me = req.profile!;
    const eng = await engineerByCode(body.engineerCode);
    if (eng.userId === me.userId) throw badRequest('برای خودت نمی‌توانی بازدید رزرو کنی', 'SELF');
    const ty = cfg('visitTypes')[body.type];
    if (!ty) throw badRequest('نوع بازدید معتبر نیست', 'BAD_TYPE');
    const first = tehranDay(1);
    if (body.day < first || body.day > addDays(first, HORIZON_DAYS - 1)) throw badRequest('روز بازدید باید از فردا تا دو هفتهٔ آینده باشد', 'BAD_DAY');
    if (eng.week[weekIndex(body.day)] !== 'a') throw conflict('مهندس این روز آزاد نیست', 'DAY_CLOSED');
    let v: typeof visits.$inferSelect;
    try {
      [v] = await db
        .insert(visits)
        .values({
          clientProfileId: me.id,
          engineerProfileId: eng.id,
          typeName: ty.n,
          duration: ty.d,
          price: ty.p,
          day: body.day,
          slot: body.slot,
          address: normalizeFa(body.address),
          note: body.note ? normalizeFa(body.note) : null,
        })
        .returning();
    } catch (e) {
      const pg = e as { code?: string; cause?: { code?: string } };
      if (pg.code === '23505' || pg.cause?.code === '23505') throw conflict('این ساعت همین حالا رزرو شد؛ ساعت دیگری انتخاب کن', 'SLOT_TAKEN');
      throw e;
    }
    await notify(eng.userId, { type: 'cal', title: 'درخواست بازدید تازه', body: `${me.displayName} · ${ty.n} · ${faDay(body.day)} ساعت ${body.slot}`, link: { screen: 'visits', id: v.id } });
    const ps = await withProfiles([v]);
    res.status(201).json({ visit: shape(v, [me.id], ps) });
  }),
);

async function visitFor(userId: string, id: string) {
  const [v] = await db.select().from(visits).where(eq(visits.id, id)).limit(1);
  if (!v) throw notFound('بازدید پیدا نشد');
  const mine = await myProfileIds(userId);
  const as = mine.includes(v.engineerProfileId) ? 'engineer' : mine.includes(v.clientProfileId) ? 'client' : null;
  if (!as) throw notFound('بازدید پیدا نشد');
  const ps = await withProfiles([v]);
  return { v, as, mine, ps, client: ps.get(v.clientProfileId)!, eng: ps.get(v.engineerProfileId)! };
}

async function setStatus(id: string, set: Partial<typeof visits.$inferInsert>) {
  const [nv] = await db.update(visits).set({ ...set, updatedAt: new Date() }).where(eq(visits.id, id)).returning();
  return nv;
}

r.post(
  '/:id/confirm',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const x = await visitFor(req.user!.id, id);
    if (x.as !== 'engineer') throw forbidden('فقط مهندس بازدید را تأیید می‌کند', 'NOT_ENGINEER');
    if (x.v.status !== 'requested') throw conflict('این درخواست در انتظار تأیید نیست', 'BAD_STATE');
    const nv = await setStatus(id, { status: 'confirmed' });
    await notify(x.client.userId, { type: 'cal', title: 'بازدید تأیید شد', body: `${x.eng.displayName} · ${faDay(x.v.day)} ساعت ${x.v.slot}`, link: { screen: 'visits', id } });
    res.json({ visit: shape(nv, x.mine, x.ps) });
  }),
);

r.post(
  '/:id/decline',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body);
    const x = await visitFor(req.user!.id, id);
    if (x.as !== 'engineer') throw forbidden('فقط مهندس درخواست را رد می‌کند', 'NOT_ENGINEER');
    if (!(ACTIVE as readonly string[]).includes(x.v.status)) throw conflict('این بازدید باز نیست', 'BAD_STATE');
    const nv = await setStatus(id, { status: 'declined', declineReason: reason ?? null });
    await notify(x.client.userId, { type: 'cal', title: 'مهندس نمی‌تواند بیاید', body: `${x.eng.displayName} · ${faDay(x.v.day)}${reason ? ' · ' + reason : ''} — روز دیگری انتخاب کن`, link: { screen: 'visits', id } });
    res.json({ visit: shape(nv, x.mine, x.ps) });
  }),
);

r.post(
  '/:id/cancel',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const x = await visitFor(req.user!.id, id);
    if (x.as !== 'client') throw forbidden('لغو با درخواست‌دهنده است؛ مهندس «رد» می‌کند', 'NOT_CLIENT');
    if (!(ACTIVE as readonly string[]).includes(x.v.status)) throw conflict('این بازدید باز نیست', 'BAD_STATE');
    // تا ۱۲ ساعت پیش از بازدید تأییدشده لغو رایگان است (هم‌تراز با متن اپ)
    if (x.v.status === 'confirmed') {
      const h = Number(x.v.slot.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).split(':')[0]);
      const at = new Date(`${x.v.day}T${String(h).padStart(2, '0')}:00:00+03:30`).getTime();
      if (at - Date.now() < 12 * 3600_000) throw conflict('کمتر از ۱۲ ساعت به بازدید مانده؛ با مهندس در چت هماهنگ کن', 'LATE_CANCEL');
    }
    const nv = await setStatus(id, { status: 'cancelled' });
    await notify(x.eng.userId, { type: 'cal', title: 'بازدید لغو شد', body: `${x.client.displayName} · ${faDay(x.v.day)} ساعت ${x.v.slot}`, link: { screen: 'visits', id } });
    res.json({ visit: shape(nv, x.mine, x.ps) });
  }),
);

r.post(
  '/:id/done',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({ checklist: z.array(z.object({ item: z.string().trim().min(1).max(200), ok: z.boolean() })).max(40).default([]), report: z.string().trim().min(5).max(3000) }),
      req.body,
    );
    const x = await visitFor(req.user!.id, id);
    if (x.as !== 'engineer') throw forbidden('گزارش را مهندس ثبت می‌کند', 'NOT_ENGINEER');
    if (x.v.status !== 'confirmed') throw conflict('فقط بازدید تأییدشده گزارش دارد', 'BAD_STATE');
    if (x.v.day > tehranDay()) throw conflict('گزارش بعد از روز بازدید ثبت می‌شود', 'TOO_EARLY');
    const nv = await setStatus(id, { status: 'done', checklist: body.checklist, report: normalizeFa(body.report), doneAt: new Date() });
    await notify(x.client.userId, {
      type: 'cal',
      title: 'گزارش بازدید رسید',
      body: `${x.eng.displayName} · ${body.checklist.filter((c) => c.ok).length} از ${body.checklist.length} مورد تأیید شد`,
      link: { screen: 'visits', id },
    });
    res.json({ visit: shape(nv, x.mine, x.ps) });
  }),
);

export default r;
