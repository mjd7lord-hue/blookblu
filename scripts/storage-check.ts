/**
 * بررسی تنظیمات ذخیرهٔ فایل: یک فایل کوچک آپلود، دریافت و حذف می‌کند.
 * اجرا: npm run storage:check
 */
import type { Response } from 'express';
import { env } from '../src/config/env';
import { storage } from '../src/lib/storage';

async function main() {
  console.log(`درایور: ${env.STORAGE_DRIVER}${env.STORAGE_DRIVER === 'supabase' ? ` (${env.SUPABASE_URL}، باکت ${env.SUPABASE_BUCKET})` : ''}`);
  const key = `check/${Date.now()}.txt`;
  await storage.put(key, Buffer.from('blook storage check'), 'text/plain');
  console.log('✅ آپلود');

  // شبیه‌سازی پاسخ express برای گرفتن لینک/محتوا
  let target = '';
  const fake = {
    setHeader() {},
    status() {
      return this;
    },
    json(b: unknown) {
      throw new Error('دریافت نشد: ' + JSON.stringify(b));
    },
    redirect(_s: number, url: string) {
      target = url;
    },
    write() {},
    end() {},
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return true;
    },
  } as unknown as Response;
  if (env.STORAGE_DRIVER !== 'local') {
    await storage.send(fake, key, 'text/plain', { isPublic: false });
    const body = await (await fetch(target)).text();
    if (body !== 'blook storage check') throw new Error('محتوای دریافتی درست نیست: ' + body.slice(0, 100));
    console.log('✅ لینک امضاشده و دریافت');
  }
  await storage.remove(key);
  console.log('✅ حذف — ذخیره‌سازی آماده است');
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
