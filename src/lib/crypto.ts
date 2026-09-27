import crypto from 'crypto';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function hmac(secret: string, s: string) {
  return crypto.createHmac('sha256', secret).update(s).digest('hex');
}

export function randomDigits(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += crypto.randomInt(0, 10).toString();
  return out;
}

export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// بدون حروف گیج‌کننده (0/O، 1/I)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** شناسهٔ کاری مثل B-7K31 */
export function workCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return 'B-' + s;
}
