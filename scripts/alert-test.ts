/**
 * آزمایش پیامک هشدار سرور: یک پیامک متنی به شماره‌های ALERT_PHONES (یا شمارهٔ داده‌شده) می‌فرستد.
 *   npm run alert:test               (ALERT_PHONES از .env)
 *   npm run alert:test -- 09121234567
 * ملی‌پیامک برای پیامک متنی به MELIPAYAMAK_FROM (شمارهٔ خط پنل) نیاز دارد.
 */
import { env } from '../src/config/env';
import { alertPhones } from '../src/lib/monitor';
import { sms } from '../src/lib/sms';
import { normalizePhone } from '../src/lib/text';

async function main() {
  const arg = process.argv[2] ? normalizePhone(process.argv[2]) : null;
  const phones = arg ? [arg] : alertPhones();
  if (!phones.length) throw new Error('شماره‌ای نیست: ALERT_PHONES را در .env بگذار یا شماره بده');
  for (const p of phones) {
    await sms.sendText(p, 'بلوک: آزمایش هشدار سرور ✅ اگر این را می‌بینی، هشدار قطعی به تو می‌رسد.');
    console.log(`✅ فرستاده شد به ${p} (${env.SMS_PROVIDER})`);
  }
}
main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
