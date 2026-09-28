import { env } from '../config/env';
import { hmac, safeEqual } from './crypto';

/**
 * لینک امضاشدهٔ موقت برای منابعی که در <img>/پنجرهٔ تازه باز می‌شوند و هدر Authorization ندارند
 * (فایل خصوصی، نسخهٔ چاپی قرارداد). scope جلوی استفادهٔ امضای یک نوع برای نوع دیگر را می‌گیرد.
 * زمان انقضا گرد می‌شود تا لینک در بازهٔ کوتاه ثابت بماند و کش مرورگر کار کند.
 */
function sign(scope: string, id: string, exp: number) {
  return hmac(env.JWT_ACCESS_SECRET, `${scope}:${id}:${exp}`).slice(0, 32);
}

export function signedQuery(scope: string, id: string, ttl = env.FILE_URL_TTL_SECONDS) {
  const exp = Math.ceil((Date.now() / 1000 + ttl) / ttl) * ttl;
  return `exp=${exp}&sig=${sign(scope, id, exp)}`;
}

export function checkSigned(scope: string, id: string, exp: unknown, sig: unknown): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e * 1000 < Date.now() || typeof sig !== 'string') return false;
  return safeEqual(sign(scope, id, e), sig);
}

export const apiUrl = (path: string) => `${env.PUBLIC_BASE_URL ?? ''}${path}`;
