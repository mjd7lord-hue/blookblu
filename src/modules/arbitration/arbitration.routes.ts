import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { profiles } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { toLatinDigits } from '../../lib/text';
import { perm, requireAdmin, requireAuth, requireProfile } from '../../middlewares/auth';
import { photosUpload, singleFile, uploadLimiter } from '../files/upload';
import { ARB_AMOUNT_TIERS, ARB_BASE, ARB_FIELD_KEYS, ARB_FIELDS, ARB_TRAVEL, type ArbField } from './fees';
import * as svc from './arbitration.service';

const fieldEnum = z.enum(ARB_FIELD_KEYS as [ArbField, ...ArbField[]], { errorMap: () => ({ message: 'حوزهٔ مشکل را انتخاب کن' }) });
const amountMillion = z.preprocess((v) => (typeof v === 'string' ? Number(toLatinDigits(v).replace(/[^\d]/g, '')) : v), z.number().int().min(1).max(100_000));
const boolish = z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 1, z.boolean());
const quoteInput = z.object({ field: fieldEnum, amountMillion, multi: boolish.default(false) });

/* ================= /api/projects/:id/disputes — ثبت اختلاف ================= */

export const projectDisputesRouter = Router({ mergeParams: true });
projectDisputesRouter.use(requireAuth);

projectDisputesRouter.post(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        reason: z.enum(svc.DISPUTE_REASONS),
        ask: z.enum(svc.DISPUTE_ASKS),
        description: z.string().trim().min(10, 'شرح ماجرا را کمی کامل‌تر بنویس').max(3000),
        city: z.string().trim().min(2).max(60).optional(),
      }),
      req.body,
    );
    res.status(201).json({ dispute: await svc.openDispute(req.user!.id, id, body) });
  }),
);

/* ================= /api/disputes — طرفین پرونده ================= */

export const disputesRouter = Router();

/** داده‌های ثابت فرم‌ها (موضوع، درخواست، حوزه‌ها و فرمول هزینه) — مهمان هم می‌بیند */
disputesRouter.get('/meta', (_req, res) => {
  res.json({
    reasons: svc.DISPUTE_REASONS,
    asks: svc.DISPUTE_ASKS,
    stages: svc.STAGES,
    fields: ARB_FIELD_KEYS.map((k) => ({ key: k, ...ARB_FIELDS[k] })),
    base: ARB_BASE,
    travel: ARB_TRAVEL,
    amountTiers: ARB_AMOUNT_TIERS.map(([max, factor, label]) => ({ maxMillion: Number.isFinite(max) ? max : null, factor, label })),
    commission: { simplePct: 15, complexPct: 20 },
    talkHours: 48,
    appealHours: 72,
  });
});

disputesRouter.use(requireAuth);

disputesRouter.get(
  '/',
  ah(async (req, res) => {
    res.json({ items: await svc.listDisputes(req.user!.id) });
  }),
);

disputesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json({ dispute: await svc.getDispute(req.user!.id, id) });
  }),
);

disputesRouter.post(
  '/:id/settle',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json({ dispute: await svc.settleDispute(req.user!.id, id) });
  }),
);

/** پیش‌نمایش هزینه: ?field=struct&amountMillion=120&multi=false */
disputesRouter.get(
  '/:id/quote',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json({ quote: await svc.quote(req.user!.id, id, parse(quoteInput, req.query)) });
  }),
);

disputesRouter.post(
  '/:id/arbitration',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      quoteInput.extend({
        agree: z.literal(true, { errorMap: () => ({ message: 'اول بپذیر که رأی پس از مهلت اعتراض لازم‌الاجراست' }) }),
      }),
      req.body,
    );
    res.status(201).json(await svc.requestArbitration(req.user!.id, id, body));
  }),
);

disputesRouter.post(
  '/:id/reject-arbiter',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json({ dispute: await svc.rejectArbiter(req.user!.id, id) });
  }),
);

disputesRouter.post(
  '/:id/appeal',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(10, 'دلیل اعتراض را کامل‌تر بنویس').max(2000) }), req.body);
    res.status(201).json(await svc.appeal(req.user!.id, id, reason));
  }),
);

disputesRouter.post(
  '/:id/accept',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json({ dispute: await svc.acceptVerdict(req.user!.id, id) });
  }),
);

disputesRouter.post(
  '/:id/rate',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ rating: z.number().int().min(1).max(5), impartial: z.boolean() }), req.body);
    res.status(201).json({ dispute: await svc.rateArbiter(req.user!.id, id, body) });
  }),
);

/* ================= /api/arbitration — حل‌کنندهٔ حضوری (مهندس/متخصص) ================= */

export const arbiterRouter = Router();
arbiterRouter.use(requireAuth);

arbiterRouter.get(
  '/me',
  ah(async (req, res) => {
    const u = req.user!;
    const [p] = u.activeRole
      ? await db.select().from(profiles).where(and(eq(profiles.userId, u.id), eq(profiles.role, u.activeRole))).limit(1)
      : [];
    res.json(await svc.arbiterHome(u, p));
  }),
);

/** multipart: file (پروانهٔ نظام مهندسی / گواهی مهارت)، fields (struct,qty یا JSON)، range، pledge=true — با نقش فعال */
arbiterRouter.post(
  '/apply',
  requireProfile,
  uploadLimiter,
  singleFile,
  ah(async (req, res) => {
    const body = parse(
      z.object({
        fields: z.preprocess(
          (v) => (typeof v === 'string' ? (v.trim().startsWith('[') ? JSON.parse(v) : v.split(',').map((s) => s.trim()).filter(Boolean)) : v),
          z.array(fieldEnum).min(1, 'حداقل یک حوزه').max(7),
        ),
        range: z.enum(['city', 'province', 'neighbors']).default('province'),
        pledge: z.preprocess((v) => v === true || v === 'true', z.literal(true, { errorMap: () => ({ message: 'تعهدنامهٔ بی‌طرفی را بپذیر' }) })),
      }),
      req.body,
    );
    await svc.applyArbiter(req.user!, req.profile!, req.file!, body);
    res.status(201).json(await svc.arbiterHome(req.user!, req.profile!));
  }),
);

arbiterRouter.get(
  '/jobs',
  ah(async (req, res) => {
    res.json({ items: await svc.myJobs(req.user!.id) });
  }),
);

arbiterRouter.post(
  '/jobs/:id/accept',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        visitAt: z.string().trim().min(4, 'زمان بازدید را بنویس').max(80),
        impartial: z.literal(true, { errorMap: () => ({ message: 'اول بی‌طرفی را تأیید کن' }) }),
      }),
      req.body,
    );
    res.json({ job: await svc.acceptJob(req.user!.id, id, body.visitAt) });
  }),
);

arbiterRouter.post(
  '/jobs/:id/decline',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json(await svc.declineJob(req.user!.id, id));
  }),
);

/** multipart: حداقل ۳ عکس در «photos» + measure، compare، verdict، remedy (+ upholds در بازبینی) */
arbiterRouter.post(
  '/jobs/:id/report',
  uploadLimiter,
  photosUpload(8),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        measure: z.string().trim().min(8, 'اندازه‌گیری و مشاهده را کامل بنویس').max(3000),
        compare: z.enum(['مطابق', 'مغایرت جزئی', 'مغایرت اساسی']),
        verdict: z.enum(['حق با کارفرما', 'حق با مجری', 'تقسیم مسئولیت']),
        remedy: z.string().trim().min(8, 'کار اصلاحی یا مبلغ را کامل بنویس').max(3000),
        upholds: z.preprocess((v) => (v === undefined || v === '' ? undefined : v === true || v === 'true'), z.boolean().optional()),
      }),
      req.body,
    );
    const photos = (req.files as Express.Multer.File[] | undefined) ?? [];
    res.status(201).json({ job: await svc.submitReport(req.user!.id, id, photos, body) });
  }),
);

/* ================= /api/admin/arbitration ================= */

export const adminArbitrationRouter = Router();
adminArbitrationRouter.use(requireAdmin);

adminArbitrationRouter.get(
  '/stats',
  perm('disputes'),
  ah(async (_req, res) => {
    res.json(await svc.arbitrationStats());
  }),
);

adminArbitrationRouter.get(
  '/arbiters',
  perm('arbiters'),
  ah(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'suspended']).default('pending') }), req.query);
    res.json({ items: await svc.adminListArbiters(status) });
  }),
);

adminArbitrationRouter.post(
  '/arbiters/:id/:action(approve|reject|suspend)',
  perm('arbiters', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const action = req.params.action as 'approve' | 'reject' | 'suspend';
    const { reason } = parse(
      z.object({ reason: action === 'approve' ? z.string().optional() : z.string().trim().min(3, 'دلیل را بنویس').max(500) }),
      req.body ?? {},
    );
    await svc.adminReviewArbiter(req.user!, id, action, reason);
    res.json({ ok: true });
  }),
);

adminArbitrationRouter.get(
  '/cases',
  perm('disputes'),
  ah(async (req, res) => {
    const { status } = parse(
      z.object({ status: z.enum(['awaiting_payment', 'matching', 'offered', 'assigned', 'reported', 'appealed', 'final', 'refunded', 'cancelled']).optional() }),
      req.query,
    );
    res.json({ items: await svc.adminListCases(status) });
  }),
);

adminArbitrationRouter.post(
  '/cases/:id/confirm-payment',
  perm('pay', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { ref } = parse(z.object({ ref: z.string().trim().min(3, 'شمارهٔ پیگیری پرداخت را بنویس').max(80) }), req.body);
    res.json(await svc.adminConfirmPayment(req.user!, id, ref));
  }),
);

adminArbitrationRouter.post(
  '/cases/:id/assign',
  perm('disputes', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { arbiterId } = parse(z.object({ arbiterId: z.string().uuid() }), req.body);
    res.json(await svc.adminAssign(req.user!, id, arbiterId));
  }),
);

adminArbitrationRouter.post(
  '/cases/:id/refund',
  perm('pay', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'دلیل را بنویس').max(500) }), req.body);
    res.json(await svc.adminRefund(req.user!, id, reason));
  }),
);
