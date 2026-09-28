const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** ارقام فارسی/عربی را به لاتین تبدیل می‌کند */
export function toLatinDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}

/**
 * شمارهٔ موبایل ایران را به شکل 09xxxxxxxxx در می‌آورد.
 * ورودی‌های مجاز: ۰۹۱۲..., 9121234567, +989121234567, 00989121234567
 */
export function normalizePhone(input: string): string | null {
  let s = toLatinDigits(String(input)).replace(/[\s\-()]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
  else if (s.startsWith('9') && s.length === 10) s = '0' + s;
  return /^09\d{9}$/.test(s) ? s : null;
}

/** شماره را برای نمایش نیمه‌پنهان می‌کند: 0912***4567 */
export function maskPhone(p: string): string {
  return p.slice(0, 4) + '***' + p.slice(-4);
}

/** نویسه‌های عربی و فاصله‌ها را یکسان می‌کند (ارقام فارسی دست نمی‌خورند) */
export function normalizeFa(s: string): string {
  return s.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/\s+/g, ' ').trim();
}

/** کد ملی ۱۰ رقمی ایران با رقم کنترل (ورودی با ارقام فارسی هم قبول است) */
export function isValidNationalCode(input: string): boolean {
  const s = toLatinDigits(input).replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(s) || /^(\d)\1{9}$/.test(s)) return false;
  const sum = [...s.slice(0, 9)].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0) % 11;
  const check = Number(s[9]);
  return sum < 2 ? check === sum : check === 11 - sum;
}
