import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ah, parse } from '../../lib/http';
import { normalizePhone, toLatinDigits } from '../../lib/text';
import { requireAuth } from '../../middlewares/auth';
import * as svc from './auth.service';

const r = Router();

// محدودیت برای هر IP (جدا از محدودیت هر شماره در سرویس)
const otpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'درخواست زیاد بود؛ کمی بعد تلاش کنید' } },
});

const phoneSchema = z
  .string()
  .transform((v, ctx) => {
    const p = normalizePhone(v);
    if (!p) {
      ctx.addIssue({ code: 'custom', message: 'شمارهٔ موبایل معتبر نیست (مثل ۰۹۱۲۱۲۳۴۵۶۷)' });
      return z.NEVER;
    }
    return p;
  });

r.post(
  '/otp/send',
  otpLimiter,
  ah(async (req, res) => {
    const { phone } = parse(z.object({ phone: phoneSchema }), req.body);
    res.json(await svc.sendOtp(phone, req.ip));
  }),
);

r.post(
  '/otp/verify',
  otpLimiter,
  ah(async (req, res) => {
    const { phone, code } = parse(
      z.object({
        phone: phoneSchema,
        code: z
          .string()
          .transform((c) => toLatinDigits(c).trim())
          .pipe(z.string().regex(/^\d{5}$/, 'کد ۵ رقمی است')),
      }),
      req.body,
    );
    res.json(await svc.verifyOtp(phone, code, req.get('user-agent')));
  }),
);

r.post(
  '/refresh',
  ah(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    res.json(await svc.refresh(refreshToken, req.get('user-agent')));
  }),
);

r.post(
  '/logout',
  ah(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    await svc.logout(refreshToken);
    res.json({ ok: true });
  }),
);

// خروج از همهٔ دستگاه‌ها (صفحهٔ امنیت)
r.post(
  '/logout-all',
  requireAuth,
  ah(async (req, res) => {
    await svc.logoutAll(req.user!.id);
    res.json({ ok: true });
  }),
);

export default r;
