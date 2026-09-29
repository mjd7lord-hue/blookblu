/**
 * /api/me/team — تیم و حضور و غیاب: نیروهای خود پیمانکار/شرکت/متخصص (نقش فعال)،
 * حضور روزانه (حاضر/غایب/مرخصی) و جمع دستمزد روزهای حضور.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../../db';
import { attendance, crewMembers, profiles } from '../../db/schema';
import { ah, moneyInput, parse, uuidParam } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { addDays, isDay, tehranDay } from '../../lib/dates';
import { requireProfile } from '../../middlewares/auth';

const r = Router();
r.use(requireProfile);

const memberInput = z.object({
  name: z.string().trim().min(2).max(80),
  skill: z.string().trim().min(2).max(60),
  dailyWage: moneyInput.default(0),
  // اگر نیرو در بلوک پروفایل دارد (کد B-XXXX)
  profileCode: z.string().trim().max(12).optional(),
});

async function mine(profileId: string, id: string) {
  const [m] = await db.select().from(crewMembers).where(and(eq(crewMembers.id, id), eq(crewMembers.ownerProfileId, profileId))).limit(1);
  if (!m) throw notFound('این نیرو در تیم تو نیست');
  return m;
}

async function linkProfile(code?: string) {
  if (!code) return null;
  const [p] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.code, code.toUpperCase())).limit(1);
  if (!p) throw badRequest('کاربری با این کد پیدا نشد', 'BAD_CODE');
  return p.id;
}

r.get(
  '/',
  ah(async (req, res) => {
    const q = parse(z.object({ from: z.string().refine(isDay).optional(), days: z.coerce.number().int().min(1).max(62).default(7) }), req.query);
    const today = tehranDay();
    const to = q.from ? addDays(q.from, q.days - 1) : today;
    const from = q.from ?? addDays(today, -(q.days - 1));
    const members = await db.select().from(crewMembers).where(eq(crewMembers.ownerProfileId, req.profile!.id)).orderBy(asc(crewMembers.createdAt));
    const rows = members.length
      ? await db
          .select()
          .from(attendance)
          .where(and(inArray(attendance.memberId, members.map((m) => m.id)), gte(attendance.day, from), lte(attendance.day, to)))
      : [];
    const items = members.map((m) => {
      const days = Object.fromEntries(rows.filter((x) => x.memberId === m.id).map((x) => [x.day, x.status]));
      const present = Object.values(days).filter((s) => s === 'p').length;
      return { ...m, days, present, pay: present * m.dailyWage };
    });
    res.json({
      today,
      from,
      to,
      items,
      totals: {
        members: members.filter((m) => m.active).length,
        presentToday: items.filter((m) => m.days[today] === 'p').length,
        pay: items.reduce((s, m) => s + m.pay, 0),
      },
    });
  }),
);

r.post(
  '/',
  ah(async (req, res) => {
    const body = parse(memberInput, req.body);
    const n = await db.select({ id: crewMembers.id }).from(crewMembers).where(eq(crewMembers.ownerProfileId, req.profile!.id));
    if (n.length >= 200) throw badRequest('حداکثر ۲۰۰ نیرو', 'TEAM_FULL');
    const [m] = await db
      .insert(crewMembers)
      .values({ ownerProfileId: req.profile!.id, name: body.name, skill: body.skill, dailyWage: body.dailyWage ?? 0, memberProfileId: await linkProfile(body.profileCode) })
      .returning();
    res.status(201).json({ member: m });
  }),
);

r.patch(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await mine(req.profile!.id, id);
    const body = parse(memberInput.partial().extend({ active: z.boolean().optional() }), req.body);
    const { profileCode, dailyWage, ...rest } = body;
    const [m] = await db
      .update(crewMembers)
      .set({ ...rest, ...(dailyWage != null ? { dailyWage } : {}), ...(profileCode !== undefined ? { memberProfileId: await linkProfile(profileCode || undefined) } : {}) })
      .where(eq(crewMembers.id, id))
      .returning();
    res.json({ member: m });
  }),
);

r.delete(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await mine(req.profile!.id, id);
    await db.delete(crewMembers).where(eq(crewMembers.id, id));
    res.json({ ok: true });
  }),
);

/** حضور یک روز (پیش‌فرض امروز)؛ status: p حاضر، a غایب، l مرخصی، null = پاک کردن */
r.put(
  '/:id/attendance',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ day: z.string().refine(isDay).optional(), status: z.enum(['p', 'a', 'l']).nullable() }), req.body);
    await mine(req.profile!.id, id);
    const day = body.day ?? tehranDay();
    if (day > tehranDay()) throw badRequest('حضور روزهای آینده ثبت نمی‌شود', 'FUTURE_DAY');
    if (body.status === null) await db.delete(attendance).where(and(eq(attendance.memberId, id), eq(attendance.day, day)));
    else
      await db
        .insert(attendance)
        .values({ memberId: id, day, status: body.status })
        .onConflictDoUpdate({ target: [attendance.memberId, attendance.day], set: { status: body.status, updatedAt: new Date() } });
    res.json({ memberId: id, day, status: body.status });
  }),
);

/** همه را برای امروز حاضر بزن */
r.post(
  '/attendance/all-present',
  ah(async (req, res) => {
    const day = tehranDay();
    const ms = await db.select({ id: crewMembers.id }).from(crewMembers).where(and(eq(crewMembers.ownerProfileId, req.profile!.id), eq(crewMembers.active, true)));
    if (ms.length)
      await db
        .insert(attendance)
        .values(ms.map((m) => ({ memberId: m.id, day, status: 'p' as const })))
        .onConflictDoUpdate({ target: [attendance.memberId, attendance.day], set: { status: 'p', updatedAt: new Date() } });
    res.json({ day, count: ms.length });
  }),
);

export default r;
