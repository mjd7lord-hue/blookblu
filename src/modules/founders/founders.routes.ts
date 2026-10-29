/**
 * کمپین «۱۰۰ عضو بنیان‌گذار» (دور ۵۴)
 *   اپ:  GET /api/founders (ورود اختیاری) · POST /api/founders/follow
 *   پنل: GET /api/admin/panel/founders · POST /api/admin/panel/founders/:id/grant|revoke
 *        تنظیمات (روشن/خاموش، ظرفیت، متن امتیازها) = PUT /api/admin/panel/config/founders
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db';
import { ah, parse, uuidParam } from '../../lib/http';
import { optionalAuth, perm, requireAuth } from '../../middlewares/auth';
import { adminLog } from '../admin/admin.service';
import * as svc from './founders.service';

const r = Router();
r.get('/', optionalAuth, ah(async (req, res) => res.json(await svc.status(req.user))));
r.post('/follow', requireAuth, ah(async (req, res) => res.json(await svc.follow(req.user!))));
export default r;

export function registerFounderAdminRoutes(a: Router) {
  a.get(
    '/founders',
    perm('users', 1),
    ah(async (_req, res) => {
      const [stats, items] = await Promise.all([svc.adminStats(), svc.adminList()]);
      res.json({ stats, items });
    }),
  );
  a.post(
    '/founders/:id/grant',
    perm('users', 2),
    ah(async (req, res) => {
      const { id } = parse(uuidParam, req.params);
      // شمارهٔ دلخواه مدیر (اختیاری)؛ بدون آن کوچک‌ترین شمارهٔ آزاد
      const { number: wanted } = parse(z.object({ number: z.coerce.number().int().min(1).max(10000).optional() }), req.body ?? {});
      const number = await svc.adminGrant(id, wanted);
      await adminLog(db, req.user!, 'founder.grant', 'user', id, `#${number}`);
      res.json({ number });
    }),
  );
  a.post(
    '/founders/:id/revoke',
    perm('users', 2),
    ah(async (req, res) => {
      const { id } = parse(uuidParam, req.params);
      await svc.adminRevoke(id);
      await adminLog(db, req.user!, 'founder.revoke', 'user', id, null);
      res.json({ ok: true });
    }),
  );
}
