/**
 * مدیر ارشد کردن یک کاربر (پنل ادمین). اگر با این شماره حسابی نباشد، ساخته می‌شود (بعداً با همین شماره و OTP وارد می‌شوی).
 *   npm run admin:grant -- 09121234567
 *   npm run admin:grant -- 09121234567 --role=kyc        (نقش دیگر: content, support, finance, arbit, kyc)
 *   npm run admin:grant -- 09121234567 --revoke
 * مدیرهای دیگر را بهتر است خود مدیر ارشد از بخش «مدیران» پنل بسازد.
 * روی همان دیتابیسی کار می‌کند که DATABASE_URL در .env نشان می‌دهد.
 */
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { adminRoles, admins, users } from '../src/db/schema';
import { normalizePhone } from '../src/lib/text';

async function main() {
  const phone = normalizePhone(process.argv[2] ?? '');
  const revoke = process.argv.includes('--revoke');
  const roleKey = (process.argv.find((a) => a.startsWith('--role=')) ?? '--role=owner').slice(7);
  if (!phone) throw new Error('شمارهٔ موبایل را بده: npm run admin:grant -- 09121234567');
  const [role] = await db.select().from(adminRoles).where(eq(adminRoles.key, roleKey)).limit(1);
  if (!role && !revoke) throw new Error(`نقش «${roleKey}» نیست؛ یکی از: owner, content, support, finance, arbit, kyc`);

  let [u] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (!u) {
    if (revoke) throw new Error(`کاربری با شمارهٔ ${phone} نیست`);
    [u] = await db.insert(users).values({ phone }).returning();
    console.log(`حساب تازه با شمارهٔ ${phone} ساخته شد`);
  }
  if (u.status === 'deleted') throw new Error('این حساب حذف شده است');

  if (revoke) {
    await db.update(admins).set({ status: 'disabled', updatedAt: new Date() }).where(eq(admins.userId, u.id));
    await db.update(users).set({ isAdmin: false, updatedAt: new Date() }).where(eq(users.id, u.id));
    console.log(`✅ ${phone} دیگر مدیر نیست`);
    return;
  }
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || phone;
  await db
    .insert(admins)
    .values({ userId: u.id, roleKey, name })
    .onConflictDoUpdate({ target: admins.userId, set: { roleKey, status: 'active', updatedAt: new Date() } });
  await db.update(users).set({ isAdmin: true, updatedAt: new Date() }).where(eq(users.id, u.id));
  console.log(`✅ ${phone} مدیر شد با نقش «${role.name}»`);
}

main()
  .catch((e) => {
    console.error('❌', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
