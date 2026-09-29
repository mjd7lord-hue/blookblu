import { Router } from 'express';
import { z } from 'zod';
import { ah, pageQuery, parse, uuidParam } from '../../lib/http';
import { perm, requireAdmin } from '../../middlewares/auth';
import * as svc from './admin.service';

/** /api/admin — فقط کارشناسان بلوک (users.is_admin) */
const r = Router();
r.use(requireAdmin);

const reason = z.string({ required_error: 'دلیل را بنویس' }).trim().min(3, 'دلیل خیلی کوتاه است').max(500);
const reviewStatus = z.enum(['pending', 'approved', 'rejected']).default('pending');

r.get(
  '/stats',
  perm('dash'),
  ah(async (_req, res) => {
    res.json(await svc.stats());
  }),
);

/* ---------- احراز هویت ---------- */

r.get(
  '/kyc',
  perm('kyc'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ status: reviewStatus }), req.query);
    res.json({ items: await svc.listKyc(q) });
  }),
);

r.post(
  '/kyc/:id/approve',
  perm('kyc', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        // اصلاح نام مطابق کارت (اختیاری)
        firstName: z.string().trim().min(2).max(60).optional(),
        lastName: z.string().trim().min(2).max(60).optional(),
        force: z.boolean().optional(),
      }),
      req.body ?? {},
    );
    await svc.approveKyc(req.user!, id, body);
    res.json({ ok: true });
  }),
);

r.post(
  '/kyc/:id/reject',
  perm('kyc', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ reason }), req.body);
    await svc.rejectKyc(req.user!, id, body.reason);
    res.json({ ok: true });
  }),
);

/* ---------- مدارک ---------- */

r.get(
  '/documents',
  perm('kyc'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ status: reviewStatus }), req.query);
    res.json({ items: await svc.listDocuments(q) });
  }),
);

r.post(
  '/documents/:id/approve',
  perm('kyc', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ expiresAt: z.coerce.date().nullish() }), req.body ?? {});
    await svc.approveDocument(req.user!, id, body);
    res.json({ ok: true });
  }),
);

r.post(
  '/documents/:id/reject',
  perm('kyc', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ reason }), req.body);
    await svc.rejectDocument(req.user!, id, body.reason);
    res.json({ ok: true });
  }),
);

/* ---------- گزارش‌ها ---------- */

r.get(
  '/reports',
  perm('reports'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ status: z.enum(['active', 'open', 'reviewing', 'resolved', 'dismissed']).default('active') }), req.query);
    res.json({ items: await svc.listReports(q) });
  }),
);

r.patch(
  '/reports/:id',
  perm('reports', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ status: z.enum(['reviewing', 'resolved', 'dismissed']), note: z.string().trim().max(1000).optional() }), req.body);
    res.json({ report: await svc.updateReport(req.user!, id, body) });
  }),
);

/* ---------- کاربران و آگهی‌ها ---------- */

r.get(
  '/users',
  perm('users'),
  ah(async (req, res) => {
    const q = parse(
      pageQuery.extend({
        q: z.string().trim().max(60).optional(),
        status: z.enum(['active', 'suspended', 'deleted']).optional(),
        kyc: z.enum(['none', 'pending', 'verified', 'rejected']).optional(),
      }),
      req.query,
    );
    res.json({ items: await svc.searchUsers(q) });
  }),
);

r.get(
  '/users/:id',
  perm('users'),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json(await svc.userDetail(id));
  }),
);

r.post(
  '/users/:id/suspend',
  perm('users', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ reason }), req.body);
    await svc.suspendUser(req.user!, id, body.reason);
    res.json({ ok: true });
  }),
);

r.post(
  '/users/:id/unsuspend',
  perm('users', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    await svc.unsuspendUser(req.user!, id, body.note);
    res.json({ ok: true });
  }),
);

r.post(
  '/ads/:id/remove',
  perm('ads', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ reason }), req.body);
    await svc.removeAd(req.user!, id, body.reason);
    res.json({ ok: true });
  }),
);

r.get(
  '/actions',
  perm('audit'),
  ah(async (req, res) => {
    const q = parse(pageQuery.extend({ targetId: z.string().uuid().optional() }), req.query);
    res.json({ items: await svc.listActions(q) });
  }),
);

export default r;
