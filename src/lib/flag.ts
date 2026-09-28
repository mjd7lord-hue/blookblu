import { toLatinDigits } from './text';

/**
 * تشخیص پیام مشکوک به کلاهبرداری: شمارهٔ کارت/شبا یا درخواست پیش‌پرداخت و کارت‌به‌کارت.
 * پیام فرستاده می‌شود، ولی برای گیرنده هشدار نمایش داده می‌شود.
 */
export function isSuspicious(text: string): boolean {
  const t = toLatinDigits(text).replace(/‌/g, ' ');
  const digitsOnly = t.replace(/[\s\-*.]/g, '');
  const card = /\d{4}[\s\-.]?[\d*]{4}[\s\-.]?[\d*]{4}[\s\-.]?\d{4}/.test(t) || /\d{16}/.test(digitsOnly);
  const sheba = /IR\s?\d{2}[\s\d]{20,}/i.test(t);
  const prepay = /(پیش\s?پرداخت|بیعانه|کارت\s?به\s?کارت|واریز\s?کن|به\s?کارت\s)/.test(t);
  return card || sheba || prepay;
}
