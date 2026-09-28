import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { requireAuth } from '../../middlewares/auth';
import { getOwnProfile } from '../profiles/profiles.service';
import { singleFile, uploadLimiter } from './upload';
import * as svc from './media.service';

/** زیر /api/me — آپلودها با multipart/form-data و فایل در فیلد «file» */
const r = Router();
r.use(requireAuth);

const roleParam = z.object({ role: z.enum(ROLES) });
// فیلدهای متنی multipart همیشه رشته‌اند؛ رشتهٔ خالی = نبودن
const optText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());

/* ---------- عکس پروفایل ---------- */

r.put(
  '/roles/:role/avatar',
  uploadLimiter,
  singleFile,
  ah(async (req, res) => {
    const { role } = parse(roleParam, req.params);
    res.json({ avatarUrl: await svc.setAvatar(req.user!.id, role, req.file!) });
  }),
);

r.delete(
  '/roles/:role/avatar',
  ah(async (req, res) => {
    const { role } = parse(roleParam, req.params);
    await svc.removeAvatar(req.user!.id, role);
    res.json({ ok: true });
  }),
);

/* ---------- نمونه‌کار ---------- */

r.get(
  '/roles/:role/portfolio',
  ah(async (req, res) => {
    const { role } = parse(roleParam, req.params);
    const p = await getOwnProfile(req.user!.id, role);
    res.json({ items: await svc.listPortfolio(p.id), max: svc.MAX_PORTFOLIO });
  }),
);

r.post(
  '/roles/:role/portfolio',
  uploadLimiter,
  singleFile,
  ah(async (req, res) => {
    const { role } = parse(roleParam, req.params);
    const body = parse(
      z.object({
        title: z.string({ required_error: 'عنوان نمونه‌کار را بنویس' }).trim().min(2, 'عنوان خیلی کوتاه است').max(120),
        place: optText(60),
        when: optText(40),
      }),
      req.body,
    );
    res.status(201).json({ item: await svc.addPortfolio(req.user!.id, role, req.file!, body) });
  }),
);

r.patch(
  '/portfolio/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        title: z.string().trim().min(2).max(120).optional(),
        place: z.string().trim().max(60).nullable().optional(),
        when: z.string().trim().max(40).nullable().optional(),
        sort: z.number().int().min(-100).max(100).optional(),
      }),
      req.body,
    );
    res.json({ item: await svc.updatePortfolio(req.user!.id, id, body) });
  }),
);

r.delete(
  '/portfolio/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.deletePortfolio(req.user!.id, id);
    res.json({ ok: true });
  }),
);

/* ---------- مدارک (خصوصی) ---------- */

r.get(
  '/documents',
  ah(async (req, res) => {
    res.json({ items: await svc.listDocuments(req.user!.id) });
  }),
);

r.post(
  '/documents',
  uploadLimiter,
  singleFile,
  ah(async (req, res) => {
    const body = parse(
      z.object({
        title: z.string({ required_error: 'نوع مدرک را مشخص کن' }).trim().min(2).max(80),
        group: optText(30),
        role: z.preprocess((v) => (v === '' ? undefined : v), z.enum(ROLES).optional()),
      }),
      req.body,
    );
    res.status(201).json({ document: await svc.addDocument(req.user!.id, req.file!, body) });
  }),
);

r.delete(
  '/documents/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.deleteDocument(req.user!.id, id);
    res.json({ ok: true });
  }),
);

export default r;
