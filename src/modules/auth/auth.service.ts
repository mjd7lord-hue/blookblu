import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { otpCodes, refreshTokens, users } from '../../db/schema';
import { env } from '../../config/env';
import { hmac, randomDigits, randomToken, safeEqual, sha256 } from '../../lib/crypto';
import { badRequest, tooMany, unauthorized } from '../../lib/errors';
import { sms } from '../../lib/sms';
import { signAccess } from '../../lib/jwt';
import { logger } from '../../lib/logger';

/**
 * کاربرد کد: ورود، یا امضای یک قرارداد مشخص. ctx در هش می‌آید تا کد امضای یک قرارداد
 * نه برای ورود کار کند نه برای قرارداد/نسخهٔ دیگر.
 */
export type CodePurpose = { kind: 'login' } | { kind: 'sign'; ctx: string };
const LOGIN: CodePurpose = { kind: 'login' };

const hashCode = (phone: string, code: string, p: CodePurpose) =>
  hmac(env.JWT_ACCESS_SECRET, p.kind === 'login' ? `${phone}:${code}` : `${phone}:${code}:${p.kind}:${p.ctx}`);

export async function sendOtp(phone: string, ip?: string, purpose: CodePurpose = LOGIN) {
  const now = Date.now();

  // محدودیت: فاصلهٔ بین دو ارسال و سقف ساعتی برای هر شماره
  const recent = await db
    .select({ createdAt: otpCodes.createdAt, purpose: otpCodes.purpose })
    .from(otpCodes)
    .where(and(eq(otpCodes.phone, phone), gt(otpCodes.createdAt, new Date(now - 3600_000))))
    .orderBy(desc(otpCodes.createdAt));

  // فاصلهٔ ارسال دوباره برای هر کاربرد جداست (ورود تازه مانع گرفتن کد امضا نشود)؛ سقف ساعتی مشترک است
  const last = recent.find((x) => x.purpose === purpose.kind);
  if (last) {
    const wait = Math.ceil((last.createdAt.getTime() + env.OTP_RESEND_SECONDS * 1000 - now) / 1000);
    if (wait > 0) throw tooMany(`برای ارسال دوباره ${wait} ثانیه صبر کنید`, 'OTP_WAIT', { retryIn: wait });
  }
  // امضا چند کد بیشتر لازم دارد (دو طرف × چند نسخه)
  if (recent.length >= env.OTP_MAX_PER_HOUR * (purpose.kind === 'sign' ? 2 : 1)) {
    throw tooMany('تعداد درخواست کد زیاد بود؛ یک ساعت دیگر دوباره تلاش کنید', 'OTP_LIMIT');
  }

  const code = randomDigits(5);
  // کدهای قبلی باطل می‌شوند
  await db
    .update(otpCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(otpCodes.phone, phone), eq(otpCodes.purpose, purpose.kind), isNull(otpCodes.consumedAt)));
  await db.insert(otpCodes).values({
    phone,
    purpose: purpose.kind,
    codeHash: hashCode(phone, code, purpose),
    expiresAt: new Date(now + env.OTP_TTL_SECONDS * 1000),
    ip,
  });

  try {
    await sms.sendOtp(phone, code, purpose.kind);
  } catch (e) {
    logger.error({ err: e }, 'SMS send failed');
    throw badRequest('ارسال پیامک ناموفق بود؛ چند دقیقهٔ دیگر تلاش کنید', 'SMS_FAILED');
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).limit(1);

  return {
    sent: true,
    expiresIn: env.OTP_TTL_SECONDS,
    resendIn: env.OTP_RESEND_SECONDS,
    isNew: !existing,
    ...(env.OTP_DEV_ECHO ? { devCode: code } : {}),
  };
}

/** بررسی و مصرف کد؛ خطای فارسی برای کد اشتباه/منقضی */
export async function consumeCode(phone: string, code: string, purpose: CodePurpose) {
  const [otp] = await db
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.phone, phone),
        eq(otpCodes.purpose, purpose.kind),
        isNull(otpCodes.consumedAt),
        gt(otpCodes.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);

  if (!otp) throw badRequest('کد منقضی شده؛ دوباره درخواست کد بدهید', 'OTP_EXPIRED');
  if (otp.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw tooMany('تعداد تلاش‌ها زیاد بود؛ کد تازه بگیرید', 'OTP_ATTEMPTS');
  }

  if (!safeEqual(otp.codeHash, hashCode(phone, code, purpose))) {
    await db
      .update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(eq(otpCodes.id, otp.id));
    const left = env.OTP_MAX_ATTEMPTS - otp.attempts - 1;
    throw badRequest(left > 0 ? `کد اشتباه است؛ ${left} تلاش دیگر باقی است` : 'کد اشتباه است؛ کد تازه بگیرید', 'OTP_WRONG', {
      attemptsLeft: Math.max(0, left),
    });
  }

  const used = await db
    .update(otpCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(otpCodes.id, otp.id), isNull(otpCodes.consumedAt)))
    .returning({ id: otpCodes.id });
  if (!used.length) throw badRequest('کد منقضی شده؛ دوباره درخواست کد بدهید', 'OTP_EXPIRED');
}

export async function verifyOtp(phone: string, code: string, userAgent?: string) {
  await consumeCode(phone, code, LOGIN);

  let [user] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  const isNew = !user;
  if (!user) {
    [user] = await db.insert(users).values({ phone }).returning();
  } else if (user.status === 'deleted') {
    // حساب حذف‌شده با همین شماره از نو شروع می‌شود
    [user] = await db
      .update(users)
      .set({ status: 'active', firstName: null, lastName: null, activeRole: null, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
  }
  if (user.status === 'suspended') throw unauthorized('حساب شما موقتاً مسدود است', 'SUSPENDED');

  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
  const tokens = await issueTokens(user.id, userAgent);

  return {
    ...tokens,
    isNew,
    // تا وقتی هیچ نقشی ثبت نشده، اپ باید به صفحهٔ انتخاب نقش برود
    needsRegistration: !user.activeRole,
    user: { id: user.id, phone: user.phone, activeRole: user.activeRole },
  };
}

async function issueTokens(userId: string, userAgent?: string) {
  const refreshToken = randomToken();
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: sha256(refreshToken),
    userAgent: userAgent?.slice(0, 255),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86400_000),
  });
  return { accessToken: signAccess(userId), refreshToken };
}

// تا ۳ دقیقه بعد از تمدید، همان توکن قبلی هنوز پذیرفته می‌شود (جواب گم‌شده در شبکه)
const REFRESH_GRACE_MS = 3 * 60_000;

/** refresh token یک‌بار مصرف است و با هر بار استفاده عوض می‌شود */
export async function refresh(token: string, userAgent?: string) {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, sha256(token)))
    .limit(1);
  if (!row || row.expiresAt < new Date()) throw unauthorized('نشست منقضی شده؛ دوباره وارد شوید', 'REFRESH_INVALID');
  if (row.revokedAt && row.replacedAt && Date.now() - row.replacedAt.getTime() < REFRESH_GRACE_MS) {
    // جواب تمدید قبلی به گوشی نرسیده (اینترنت ضعیف) و همان توکن دوباره آمده: سرقت نیست، نشست تازه
    const [u0] = await db.select({ status: users.status }).from(users).where(eq(users.id, row.userId)).limit(1);
    if (u0?.status === 'active') return issueTokens(row.userId, userAgent);
  }
  if (row.revokedAt) {
    // استفادهٔ دوباره از توکن باطل‌شده = احتمال سرقت؛ همهٔ نشست‌ها بسته می‌شود
    await db.update(refreshTokens).set({ revokedAt: new Date(), replacedAt: null }).where(eq(refreshTokens.userId, row.userId));
    throw unauthorized('نشست نامعتبر است؛ دوباره وارد شوید', 'REFRESH_REUSED');
  }
  const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, row.userId)).limit(1);
  if (!u || u.status !== 'active') throw unauthorized('حساب فعال نیست', 'REFRESH_INVALID');

  await db.update(refreshTokens).set({ revokedAt: new Date(), replacedAt: new Date() }).where(eq(refreshTokens.id, row.id));
  return issueTokens(row.userId, userAgent);
}

export async function logout(token: string) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, sha256(token)), isNull(refreshTokens.revokedAt)));
}

export async function logoutAll(userId: string) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
