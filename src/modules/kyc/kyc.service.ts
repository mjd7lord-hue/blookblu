import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { kycRequests, profiles, users } from '../../db/schema';
import { badRequest, conflict } from '../../lib/errors';
import { isValidNationalCode, normalizeFa, toLatinDigits } from '../../lib/text';
import { purgeFiles, saveUpload } from '../files/files.service';

type User = typeof users.$inferSelect;
type KycRow = typeof kycRequests.$inferSelect;
type Upload = { buffer: Buffer; originalname?: string };

/** وضعیت برای خود کاربر — بدون عکس و شمارهٔ کامل */
export function shapeForUser(k: KycRow | undefined, u: Pick<User, 'kycStatus'>) {
  return {
    status: u.kycStatus,
    request: k
      ? {
          id: k.id,
          status: k.status,
          firstName: k.firstName,
          lastName: k.lastName,
          idType: k.idType,
          idNumberMasked: k.idNumber ? `${k.idNumber.slice(0, 3)}****${k.idNumber.slice(-3)}` : null,
          rejectReason: k.rejectReason,
          createdAt: k.createdAt,
          reviewedAt: k.reviewedAt,
        }
      : null,
  };
}

export async function latestKyc(userId: string) {
  const [k] = await db.select().from(kycRequests).where(eq(kycRequests.userId, userId)).orderBy(desc(kycRequests.createdAt)).limit(1);
  return k;
}

export async function submitKyc(
  user: User,
  card: Upload,
  selfie: Upload,
  input: { idType: 'national' | 'foreign'; idNumber?: string; firstName?: string; lastName?: string },
) {
  if (user.kycStatus === 'verified') throw conflict('هویت شما قبلاً تأیید شده است', 'KYC_DONE');
  if (user.kycStatus === 'pending') throw conflict('درخواست قبلی شما در حال بررسی است؛ معمولاً تا ۲۴ ساعت', 'KYC_PENDING');

  const firstName = normalizeFa(input.firstName ?? user.firstName ?? '');
  const lastName = normalizeFa(input.lastName ?? user.lastName ?? '');
  if (firstName.length < 2 || lastName.length < 2) {
    throw badRequest('نام و نام خانوادگی مطابق کارت لازم است', 'KYC_NAME');
  }

  let idNumber: string | null = null;
  if (input.idNumber) {
    idNumber = toLatinDigits(input.idNumber).replace(/[\s-]/g, '');
    if (input.idType === 'national' && !isValidNationalCode(idNumber)) {
      throw badRequest('کد ملی معتبر نیست؛ ۱۰ رقم روی کارت را دوباره بررسی کن', 'NATIONAL_CODE_INVALID');
    }
    if (input.idType === 'foreign' && !/^[A-Za-z0-9]{5,30}$/.test(idNumber)) {
      throw badRequest('شمارهٔ مدرک اقامت معتبر نیست', 'ID_NUMBER_INVALID');
    }
  }

  const cardFile = await saveUpload(user.id, 'kyc', card);
  let selfieFile;
  try {
    selfieFile = await saveUpload(user.id, 'kyc', selfie);
  } catch (e) {
    await purgeFiles([cardFile.id]);
    throw e;
  }

  try {
    return await db.transaction(async (tx) => {
      // قفل خوش‌بینانه: فقط اگر هم‌زمان درخواست دیگری ثبت نشده باشد
      const upd = await tx
        .update(users)
        .set({ kycStatus: 'pending', updatedAt: new Date() })
        .where(and(eq(users.id, user.id), sql`${users.kycStatus} in ('none', 'rejected')`))
        .returning({ id: users.id });
      if (!upd.length) throw conflict('درخواست قبلی شما در حال بررسی است', 'KYC_PENDING');
      const [k] = await tx
        .insert(kycRequests)
        .values({
          userId: user.id,
          firstName,
          lastName,
          idType: input.idType,
          idNumber,
          cardFileId: cardFile.id,
          selfieFileId: selfieFile.id,
        })
        .returning();
      return k;
    });
  } catch (e) {
    await purgeFiles([cardFile.id, selfieFile.id]);
    throw e;
  }
}

/** کاربران تأییدشدهٔ دیگری که همین کد ملی/مدرک را دارند (نشانهٔ چند حساب با یک هویت) */
export async function duplicateIdentity(userId: string, idNumber: string | null) {
  if (!idNumber) return [];
  return db
    .selectDistinct({ userId: kycRequests.userId, phone: users.phone })
    .from(kycRequests)
    .innerJoin(users, eq(users.id, kycRequests.userId))
    .where(and(eq(kycRequests.idNumber, idNumber), eq(kycRequests.status, 'approved'), ne(kycRequests.userId, userId), ne(users.status, 'deleted')));
}

/** نام تأییدشده روی همهٔ پروفایل‌های شخصی (غیر شرکت) */
export async function applyVerifiedName(tx: Pick<typeof db, 'update'>, userId: string, firstName: string, lastName: string) {
  await tx.update(users).set({ kycStatus: 'verified', firstName, lastName, updatedAt: new Date() }).where(eq(users.id, userId));
  await tx
    .update(profiles)
    .set({ displayName: `${firstName} ${lastName}`, updatedAt: new Date() })
    .where(and(eq(profiles.userId, userId), sql`${profiles.role} <> 'company'`));
}
