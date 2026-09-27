import { Router } from 'express';
import { z } from 'zod';
import { AD_TYPES, ROLES, WORK_RANGES } from '../../db/schema';
import { ah, pageQuery, parse, uuidParam } from '../../lib/http';
import { toLatinDigits } from '../../lib/text';
import { optionalAuth, requireProfile } from '../../middlewares/auth';
import { PROVINCES } from '../roles/forms';
import * as svc from './ads.service';

const r = Router();

const money = z.preprocess(
  (v) => (typeof v === 'string' ? Number(toLatinDigits(v).replace(/[^\d]/g, '')) || null : v),
  z.number().int().min(0).max(1e13).nullable(),
);

const adBody = z.object({
  type: z.enum(AD_TYPES),
  title: z.string().trim().min(4, 'عنوان حداقل ۴ حرف').max(120),
  description: z.string().max(2000).nullish(),
  province: z.enum(PROVINCES as [string, ...string[]], { message: 'استان معتبر نیست' }),
  city: z.string().trim().min(2).max(60),
  wageType: z.string().max(30).nullish(),
  wageAmount: money.optional(),
  startWhen: z.string().max(40).nullish(),
  range: z.enum(WORK_RANGES).default('city'),
  audience: z.array(z.enum(ROLES)).min(1, 'حداقل یک گروه مخاطب').max(3, 'حداکثر ۳ گروه'),
  needCount: z.number().int().min(1).max(500).nullish(),
  skills: z.array(z.string().min(2).max(40)).max(5).default([]),
});

// «کاوش»: مهمان هم می‌بیند
const MODE_TYPE = { workers: 'work', jobs: 'job', consult: 'consult' } as const;
r.get(
  '/',
  optionalAuth,
  ah(async (req, res) => {
    const q = parse(
      pageQuery.extend({
        type: z.enum(AD_TYPES).optional(),
        mode: z.enum(['workers', 'jobs', 'consult']).optional(),
        authorRole: z.enum(ROLES).optional(),
        forMe: z.enum(['true', 'false']).optional(),
        province: z.string().max(60).optional(),
        city: z.string().max(60).optional(),
        q: z.string().max(80).optional(),
        skills: z
          .union([z.string(), z.array(z.string())])
          .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean).slice(0, 5))
          .optional(),
        verified: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
        minRating: z.coerce.number().min(0).max(5).optional(),
        sort: z.enum(['best', 'new', 'rating', 'exp']).default('best'),
      }),
      req.query,
    );
    const type = q.type ?? MODE_TYPE[q.mode ?? 'workers'];
    const forRole = q.forMe === 'true' && req.user?.activeRole ? req.user.activeRole : undefined;
    res.json(await svc.explore({ ...q, type, forRole }, req.user));
  }),
);

r.get(
  '/mine',
  requireProfile,
  ah(async (req, res) => {
    res.json({ items: await svc.myAds(req.profile!) });
  }),
);

r.get(
  '/:id',
  optionalAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json(await svc.getAd(id, req.user));
  }),
);

r.post(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const body = parse(adBody, req.body);
    res.status(201).json({ ad: await svc.createAd(req.profile!, body) });
  }),
);

r.patch(
  '/:id',
  requireProfile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      adBody
        .omit({ type: true })
        .partial()
        .extend({ status: z.enum(['active', 'paused', 'closed']).optional() }),
      req.body,
    );
    res.json({ ad: await svc.updateAd(req.profile!, id, body) });
  }),
);

r.delete(
  '/:id',
  requireProfile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.removeAd(req.profile!, id);
    res.json({ ok: true });
  }),
);

/* پاسخ به آگهی (اعلام آمادگی / درخواست همکاری / پاسخ به پرسش) */
r.post(
  '/:id/responses',
  requireProfile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({ message: z.string().trim().min(2, 'پیام را بنویسید').max(2000), offer: z.string().max(120).nullish() }),
      req.body,
    );
    res.status(201).json({ response: await svc.respond(req.profile!, id, body) });
  }),
);

r.get(
  '/:id/responses',
  requireProfile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json({ items: await svc.listResponses(req.profile!, id) });
  }),
);

export default r;

/* ---------- /api/responses ---------- */
export const responsesRouter = Router();

responsesRouter.get(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const { dir } = parse(z.object({ dir: z.enum(['in', 'out']).default('in') }), req.query);
    res.json({ items: await svc.myRequests(req.profile!, dir) });
  }),
);

responsesRouter.patch(
  '/:id',
  requireProfile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['accepted', 'rejected']) }), req.body);
    res.json({ response: await svc.answerResponse(req.profile!, id, status) });
  }),
);

responsesRouter.post(
  '/:id/withdraw',
  requireProfile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.withdrawResponse(req.user!.id, id);
    res.json({ ok: true });
  }),
);
