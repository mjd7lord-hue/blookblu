/**
 * آزمایش پنل پیامک با تنظیمات .env: یک کد نمونه به شمارهٔ داده‌شده می‌فرستد.
 *   npm run sms:test -- 09121234567
 */
import { env } from '../src/config/env';
import { sms } from '../src/lib/sms';
import { normalizePhone } from '../src/lib/text';

async function main() {
  const phone = normalizePhone(process.argv[2] ?? '');
  if (!phone) throw new Error('شمارهٔ موبایل را بده: npm run sms:test -- 09121234567');
  if (env.SMS_PROVIDER === 'console') console.log('⚠️ SMS_PROVIDER=console است؛ پیامک واقعی فرستاده نمی‌شود (فقط در لاگ)');
  await sms.sendOtp(phone, '12345');
  console.log(`✅ کد آزمایشی 12345 با ${env.SMS_PROVIDER} به ${phone} فرستاده شد`);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
