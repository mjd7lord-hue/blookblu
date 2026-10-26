/**
 * /api/pay — درگاه پرداخت (دور ۵۳)
 *   GET  /plans              قیمت پلن‌های ارتقای آگهی (عمومی)
 *   POST /                   شروع پرداخت { purpose: arbitration|boost, targetId, plan? } ← { id, url }
 *   GET  /callback           برگشت از درگاه (Authority, Status) ← verify ← هدایت به اپ ?pay=<id>
 *   GET  /mine · GET /:id    پرداخت‌های من / نتیجهٔ یک پرداخت
 *   GET|POST /fake/:authority  صفحهٔ پرداخت آزمایشی (فقط PAYMENT_DRIVER=fake)
 */
import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, PAYMENT_DRIVER } from '../../config/env';
import { fakeApprove, gatewayOnline } from '../../lib/gateway';
import { ah, parse, uuidParam } from '../../lib/http';
import { faMoney } from '../../lib/text';
import { requireAuth } from '../../middlewares/auth';
import { db } from '../../db';
import { gatewayPayments } from '../../db/schema';
import { eq } from 'drizzle-orm';
import * as svc from './pay.service';

const r = Router();

const payLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'درخواست پرداخت زیاد بود؛ کمی بعد تلاش کنید' } },
});

// آدرس عمومی همین سرور (برای آدرس برگشت درگاه)؛ پشت پروکسی از x-forwarded-proto
const apiBase = (req: Request) => env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`;

r.get('/plans', (_req, res) => res.json({ plans: svc.boostPlans(), online: gatewayOnline(), test: PAYMENT_DRIVER !== 'zarinpal' || env.ZARINPAL_SANDBOX }));

r.post(
  '/',
  payLimiter,
  requireAuth,
  ah(async (req, res) => {
    const q = parse(
      z.discriminatedUnion('purpose', [
        z.object({ purpose: z.literal('arbitration'), targetId: z.string().uuid() }),
        z.object({ purpose: z.literal('boost'), targetId: z.string().uuid(), plan: z.enum(['urgent', 'ladder', 'star']) }),
      ]),
      req.body,
    );
    res.status(201).json(await svc.startPayment(req.user!, q, apiBase(req)));
  }),
);

r.get(
  '/callback',
  ah(async (req, res) => {
    const authority = String(req.query.Authority ?? req.query.authority ?? '').slice(0, 64);
    const status = String(req.query.Status ?? req.query.status ?? '');
    const id = /^[A-Za-z0-9]{8,64}$/.test(authority) ? await svc.handleCallback(authority, status) : null;
    res.redirect(303, svc.appReturnUrl(id));
  }),
);

r.get('/mine', requireAuth, ah(async (req, res) => res.json({ items: await svc.myPayments(req.user!) })));
r.get('/:id', requireAuth, ah(async (req, res) => res.json({ payment: await svc.getPayment(req.user!, parse(uuidParam, req.params).id) })));

/* ---------- صفحهٔ پرداخت آزمایشی (بدون پول واقعی) ---------- */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
r.get(
  '/fake/:authority',
  ah(async (req, res) => {
    if (PAYMENT_DRIVER !== 'fake' || env.NODE_ENV === 'production') return void res.status(404).end();
    const a = String(req.params.authority).replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
    const [p] = await db.select().from(gatewayPayments).where(eq(gatewayPayments.authority, a)).limit(1);
    if (!p) return void res.status(404).send('تراکنش پیدا نشد');
    res.type('html').send(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>درگاه آزمایشی بلوک</title>
<style>body{font-family:Tahoma,sans-serif;background:#f3f4f6;margin:0;display:grid;place-items:center;min-height:100vh}.c{background:#fff;border-radius:18px;padding:24px;max-width:380px;width:calc(100% - 32px);box-shadow:0 8px 30px #0001;text-align:center}
.w{background:#FEF3C7;color:#92400E;border-radius:10px;padding:8px;font-size:13px}b.a{display:block;font-size:26px;margin:14px 0 4px}button,a{display:block;width:100%;border:0;border-radius:12px;padding:13px;font-size:16px;margin-top:10px;cursor:pointer;text-decoration:none;box-sizing:border-box}button{background:#0F9C88;color:#fff}a{background:#eee;color:#333}</style></head>
<body><div class="c"><div class="w">درگاه آزمایشی — پول واقعی کم نمی‌شود</div><p>${esc(p.description)}</p><b class="a">${faMoney(p.amount)} تومان</b>
<form method="post" action="${esc(a)}"><button type="submit">پرداخت (آزمایشی)</button></form><a href="../callback?Authority=${esc(a)}&amp;Status=NOK">انصراف</a></div></body></html>`);
  }),
);
r.post('/fake/:authority', (req, res) => {
  const a = String(req.params.authority).replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
  if (!fakeApprove(a)) return void res.status(404).end();
  res.redirect(303, `../callback?Authority=${a}&Status=OK`);
});

export default r;
