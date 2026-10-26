/**
 * درگاه پرداخت (دور ۵۳) — زرین‌پال نسخهٔ ۴، یا «fake» برای توسعه و تست (بدون پول واقعی).
 *   request ← authority و آدرس صفحهٔ پرداخت بانک
 *   verify  ← فقط این نتیجه معتبر است (نه Status=OK در آدرس برگشت)؛ با همان مبلغ ذخیره‌شده روی سرور
 * مبلغ‌ها تومان (currency=IRT).
 */
import crypto from 'crypto';
import { env, PAYMENT_DRIVER } from '../config/env';
import { logger } from './logger';

export type GatewayRequest = { amount: number; description: string; callbackUrl: string; mobile?: string };
export type VerifyResult = { ok: true; refId: string; cardPan: string | null; already: boolean } | { ok: false; reason: string };

const ZP = () => (env.ZARINPAL_SANDBOX ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com');

// پیام خطاهای رایج زرین‌پال به فارسی (برای ثبت در تراکنش و نمایش به کاربر)
const ZP_ERR: Record<string, string> = {
  '-9': 'اطلاعات پرداخت نامعتبر است',
  '-10': 'کد پذیرنده یا آدرس برگشت نامعتبر است',
  '-11': 'درگاه پذیرنده فعال نیست',
  '-12': 'تلاش‌ها بیش از حد؛ کمی بعد دوباره امتحان کن',
  '-50': 'مبلغ پرداخت‌شده با مبلغ تراکنش یکی نیست',
  '-51': 'پرداخت ناموفق بود',
  '-54': 'تراکنش نامعتبر است',
};

async function zpPost(path: string, body: Record<string, unknown>) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(ZP() + '/pg/v4/payment/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ merchant_id: env.ZARINPAL_MERCHANT, currency: 'IRT', ...body }),
      signal: ctrl.signal,
    });
    return (await r.json()) as { data?: { code?: number; authority?: string; ref_id?: number; card_pan?: string } | []; errors?: { code?: number; message?: string } | [] };
  } finally {
    clearTimeout(t);
  }
}

/* ---------- نسخهٔ آزمایشی داخلی ---------- */
// authorityهایی که در صفحهٔ آزمایشی «پرداخت» زده شده‌اند (درون‌حافظه؛ فقط توسعه و تست)
const fakePaid = new Set<string>();
export function fakeApprove(authority: string) {
  if (PAYMENT_DRIVER !== 'fake' || env.NODE_ENV === 'production') return false;
  fakePaid.add(authority);
  return true;
}

/**
 * پول واقعی فقط با زرین‌پال اصلی؛ روی سرور اصلی (production) درگاه آزمایشی یا sandbox پذیرفته نمی‌شود
 * (وگرنه هر کس بدون پرداخت واقعی ارتقا یا داوری می‌گرفت)
 */
export const gatewayOnline = () => env.NODE_ENV !== 'production' || (PAYMENT_DRIVER === 'zarinpal' && !env.ZARINPAL_SANDBOX);

export const gateway = {
  name: PAYMENT_DRIVER,

  async request(q: GatewayRequest, apiBase: string): Promise<{ authority: string; url: string }> {
    if (PAYMENT_DRIVER === 'fake') {
      const authority = 'FAKE' + crypto.randomBytes(16).toString('hex');
      return { authority, url: `${apiBase}/api/pay/fake/${authority}` };
    }
    const res = await zpPost('request.json', { amount: q.amount, description: q.description, callback_url: q.callbackUrl, metadata: q.mobile ? { mobile: q.mobile } : undefined });
    const d = Array.isArray(res.data) ? undefined : res.data;
    if (d?.code === 100 && d.authority) return { authority: d.authority, url: `${ZP()}/pg/StartPay/${d.authority}` };
    const code = String((!Array.isArray(res.errors) && res.errors?.code) ?? d?.code ?? '');
    logger.warn({ code, errors: res.errors }, 'zarinpal request failed');
    throw new Error(ZP_ERR[code] ?? 'درگاه پرداخت پاسخ نداد');
  },

  async verify(authority: string, amount: number): Promise<VerifyResult> {
    if (PAYMENT_DRIVER === 'fake') {
      if (!fakePaid.has(authority)) return { ok: false, reason: 'پرداخت انجام نشد' };
      return { ok: true, refId: 'TEST-' + authority.slice(4, 14).toUpperCase(), cardPan: '6037-99**-****-0000', already: false };
    }
    let res;
    try {
      res = await zpPost('verify.json', { amount, authority });
    } catch (e) {
      logger.warn({ e }, 'zarinpal verify failed');
      return { ok: false, reason: 'ارتباط با درگاه برقرار نشد؛ اگر پولی کم شده تا ۷۲ ساعت برمی‌گردد' };
    }
    const d = Array.isArray(res.data) ? undefined : res.data;
    // ۱۰۰ = موفق · ۱۰۱ = قبلاً تأیید شده (همان پرداخت؛ دوباره اعمال نمی‌شود)
    if ((d?.code === 100 || d?.code === 101) && d.ref_id) return { ok: true, refId: String(d.ref_id), cardPan: d.card_pan ?? null, already: d.code === 101 };
    const code = String((!Array.isArray(res.errors) && res.errors?.code) ?? d?.code ?? '');
    return { ok: false, reason: ZP_ERR[code] ?? 'پرداخت تأیید نشد' };
  },
};
