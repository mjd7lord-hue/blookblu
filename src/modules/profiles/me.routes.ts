import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { profiles, users, ROLES } from '../../db/schema';
import { ah, parse } from '../../lib/http';
import { requireAuth } from '../../middlewares/auth';
import { forbidden } from '../../lib/errors';
import { trustOf } from './profiles.service';
import { publicFileUrl } from '../files/files.service';
import * as svc from './profiles.service';

const r = Router();
r.use(requireAuth);

const roleParam = z.object({ role: z.enum(ROLES) });

/** اطلاعات حساب + همهٔ نقش‌های کاربر */
r.get(
  '/',
  ah(async (req, res) => {
    const u = req.user!;
    const ps = await db.select().from(profiles).where(eq(profiles.userId, u.id));
    const kyc = u.kycStatus === 'verified';
    res.json({
      user: {
        id: u.id,
        phone: u.phone,
        firstName: u.firstName,
        lastName: u.lastName,
        activeRole: u.activeRole,
        kycStatus: u.kycStatus,
        prefs: u.prefs,
        createdAt: u.createdAt,
      },
      profiles: ps.map((p) => ({ ...p, avatarUrl: publicFileUrl(p.avatarFileId), trust: trustOf(p, kyc) })),
      needsRegistration: ps.length === 0,
    });
  }),
);

/** ترجیحات اعلان و زبان */
r.patch(
  '/',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        prefs: z
          .object({
            notif: z
              .object({ requests: z.boolean(), messages: z.boolean(), ads: z.boolean(), reviews: z.boolean() })
              .partial()
              .optional(),
            lang: z.enum(['fa', 'en', 'ps']).optional(),
          })
          .strict(),
      }),
      req.body,
    );
    const prefs = { ...req.user!.prefs, ...body.prefs, notif: { ...req.user!.prefs.notif, ...body.prefs.notif } };
    const [u] = await db.update(users).set({ prefs, updatedAt: new Date() }).where(eq(users.id, req.user!.id)).returning();
    res.json({ prefs: u.prefs });
  }),
);

r.delete(
  '/',
  ah(async (req, res) => {
    const { confirm } = parse(z.object({ confirm: z.literal('DELETE') }), req.body);
    if (confirm !== 'DELETE') throw forbidden();
    await svc.deleteAccount(req.user!);
    res.json({ ok: true });
  }),
);

/** ثبت نقش تازه (ثبت‌نام اولیه یا افزودن نقش دوم) */
r.post(
  '/roles',
  ah(async (req, res) => {
    const { role, data } = parse(z.object({ role: z.enum(ROLES), data: z.record(z.unknown()) }), req.body);
    const p = await svc.createRoleProfile(req.user!, role, data);
    res.status(201).json({ profile: p });
  }),
);

r.patch(
  '/roles/:role',
  ah(async (req, res) => {
    const { role } = parse(roleParam, req.params);
    const body = parse(
      z.object({
        data: z.record(z.unknown()).default({}),
        title: z.string().max(160).optional(),
        bio: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const p = await svc.updateRoleProfile(req.user!, role, body.data, { title: body.title, bio: body.bio });
    res.json({ profile: p });
  }),
);

r.delete(
  '/roles/:role',
  ah(async (req, res) => {
    const { role } = parse(roleParam, req.params);
    await svc.deleteRoleProfile(req.user!, role);
    res.json({ ok: true });
  }),
);

r.post(
  '/active-role',
  ah(async (req, res) => {
    const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body);
    await svc.setActiveRole(req.user!, role);
    res.json({ activeRole: role });
  }),
);

/** روزهای آزاد هفته (از شنبه): a=آزاد، o=تعطیل */
r.put(
  '/roles/:role/week',
  ah(async (req, res) => {
    const { role } = parse(roleParam, req.params);
    const { week } = parse(z.object({ week: z.array(z.enum(['a', 'o'])).length(7) }), req.body);
    res.json({ week: await svc.setWeek(req.user!, role, week) });
  }),
);

/** مهارت‌ها و تعرفه‌ها (ویرایش درجا) */
r.put(
  '/roles/:role/skills',
  ah(async (req, res) => {
    const { role } = parse(roleParam, req.params);
    const { skills } = parse(
      z.object({
        skills: z
          .array(
            z.object({
              title: z.string().min(2).max(80),
              experience: z.string().max(40).nullish(),
              rateType: z.string().max(30).nullish(),
              rateAmount: z.number().int().min(0).nullish(),
            }),
          )
          .max(12),
      }),
      req.body,
    );
    res.json({ skills: await svc.replaceSkills(req.user!, role, skills) });
  }),
);

/** نمای پروفایل خودم، همان‌طور که دیگران می‌بینند */
r.get(
  '/profile',
  ah(async (req, res) => {
    const u = req.user!;
    if (!u.activeRole) return res.json({ profile: null });
    const p = await svc.getOwnProfile(u.id, u.activeRole);
    res.json({ profile: await svc.publicProfile(p.code, u) });
  }),
);

export default r;
