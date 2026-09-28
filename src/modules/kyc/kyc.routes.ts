import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../../lib/http';
import { requireAuth } from '../../middlewares/auth';
import { kycFiles, uploadLimiter } from '../files/upload';
import * as svc from './kyc.service';

/** زیر /api/me — تأیید هویت کاربر */
const r = Router();
r.use('/kyc', requireAuth);

r.get(
  '/kyc',
  ah(async (req, res) => {
    res.json(svc.shapeForUser(await svc.latestKyc(req.user!.id), req.user!));
  }),
);

/** multipart: card (روی کارت ملی یا کارت اقامت)، selfie (سلفی با کارت)، idType?، idNumber?، firstName?، lastName? */
r.post(
  '/kyc',
  uploadLimiter,
  kycFiles,
  ah(async (req, res) => {
    const empty = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
    const body = parse(
      z.object({
        idType: z.preprocess(empty, z.enum(['national', 'foreign']).default('national')),
        idNumber: z.preprocess(empty, z.string().trim().max(30).optional()),
        firstName: z.preprocess(empty, z.string().trim().max(60).optional()),
        lastName: z.preprocess(empty, z.string().trim().max(60).optional()),
      }),
      req.body,
    );
    const f = req.files as Record<string, Express.Multer.File[]>;
    const k = await svc.submitKyc(req.user!, f.card[0], f.selfie[0], body);
    res.status(201).json({
      ...svc.shapeForUser(k, { kycStatus: 'pending' }),
      message: 'مدارک در صف بررسی است؛ معمولاً تا ۲۴ ساعت',
    });
  }),
);

export default r;
