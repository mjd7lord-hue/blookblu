/**
 * ادمین کردن یک کاربر (باید قبلاً با OTP وارد اپ شده باشد).
 *   npm run admin:grant -- 09121234567
 *   npm run admin:grant -- 09121234567 --revoke
 * روی همان دیتابیسی کار می‌کند که DATABASE_URL در .env نشان می‌دهد.
 */
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { users } from '../src/db/schema';
import { normalizePhone } from '../src/lib/text';

async function main() {
  const phone = normalizePhone(process.argv[2] ?? '');
  const revoke = process.argv.includes('--revoke');
  if (!phone) throw new Error('شمارهٔ موبایل را بده: npm run admin:grant -- 09121234567');
  const [u] = await db
    .update(users)
    .set({ isAdmin: !revoke, updatedAt: new Date() })
    .where(eq(users.phone, phone))
    .returning({ id: users.id, status: users.status });
  if (!u) throw new Error(`کاربری با شمارهٔ ${phone} نیست؛ اول یک بار با همین شماره وارد اپ شو`);
  console.log(revoke ? `✅ ${phone} دیگر ادمین نیست` : `✅ ${phone} ادمین شد`);
}

main()
  .catch((e) => {
    console.error('❌', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
