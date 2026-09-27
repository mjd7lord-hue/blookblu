import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '../../db/schema';
import { ah, pageQuery, parse } from '../../lib/http';
import { optionalAuth } from '../../middlewares/auth';
import * as svc from './profiles.service';

const r = Router();
r.use(optionalAuth);

r.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      pageQuery.extend({
        role: z.enum(ROLES).optional(),
        q: z.string().max(80).optional(),
        province: z.string().max(60).optional(),
        city: z.string().max(60).optional(),
        verified: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
        available: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
      }),
      req.query,
    );
    res.json({ items: await svc.searchProfiles(q, req.user), page: q.page });
  }),
);

r.get(
  '/:code',
  ah(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().regex(/^B-[A-Z0-9]{4}$/i, 'کد نامعتبر') }), req.params);
    res.json({ profile: await svc.publicProfile(code, req.user) });
  }),
);

export default r;
