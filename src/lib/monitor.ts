import { sql } from 'drizzle-orm';
import { env } from '../config/env';
import { db } from '../db';
import { logger } from './logger';
import { sms } from './sms';
import { normalizePhone } from './text';

/**
 * پایش سرور:
 * ۱) بیدار نگه داشتن: سرور رایگان Render بعد از ۱۵ دقیقه بی‌درخواست می‌خوابد؛ هر ۱۰ دقیقه آدرس عمومی خودش را صدا می‌زند.
 * ۲) نگهبان دیتابیس: هر دقیقه دیتابیس را چک می‌کند؛ ۳ بار پشت‌سرهم خطا ← پیامک «قطع شد» به ALERT_PHONES، برگشت ← پیامک «برگشت».
 * اگر خود سرور خاموش شود این‌جا کاری از دستش برنمی‌آید؛ آن را GitHub Actions (.github/workflows/uptime.yml) از بیرون می‌پاید.
 */

export const alertPhones = () =>
  env.ALERT_PHONES.split(',')
    .map((p) => normalizePhone(p.trim()))
    .filter((p): p is string => !!p);

export async function alert(text: string) {
  const phones = alertPhones();
  logger.warn({ phones: phones.length }, `🚨 ${text}`);
  await Promise.all(
    phones.map((p) => sms.sendText(p, text).catch((err) => logger.error({ err }, 'alert sms failed'))),
  );
}

const faTime = (d: Date) => d.toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' });

/** وضعیت نگهبان جدا از تایمر تا تست‌پذیر باشد */
export function dbWatch(opts: { check: () => Promise<unknown>; send: (text: string) => Promise<void>; threshold?: number; now?: () => Date }) {
  const threshold = opts.threshold ?? 3;
  const now = opts.now ?? (() => new Date());
  let fails = 0;
  let downSince: Date | null = null;
  let alerted = false;
  return {
    get down() {
      return alerted;
    },
    async tick() {
      try {
        await opts.check();
        if (alerted && downSince) {
          const min = Math.max(1, Math.round((now().getTime() - downSince.getTime()) / 60_000));
          await opts.send(`بلوک: دیتابیس برگشت ✅ (حدود ${min.toLocaleString('fa-IR')} دقیقه قطع بود)`);
        }
        fails = 0;
        downSince = null;
        alerted = false;
      } catch (err) {
        if (fails === 0) downSince = now();
        fails++;
        logger.error({ err, fails }, 'db health check failed');
        if (fails >= threshold && !alerted) {
          alerted = true;
          await opts.send(`بلوک: دیتابیس از ساعت ${faTime(downSince!)} در دسترس نیست ❌ اپ کار نمی‌کند. Supabase را چک کن.`);
        }
      }
    },
  };
}

export function startMonitor() {
  const timers: NodeJS.Timeout[] = [];

  const self = env.KEEPALIVE_URL ?? env.RENDER_EXTERNAL_URL ?? env.PUBLIC_BASE_URL;
  if (env.NODE_ENV === 'production' && self) {
    const url = self.replace(/\/+$/, '') + '/api/health';
    const ping = () =>
      fetch(url, { signal: AbortSignal.timeout(30_000) })
        .then((r) => logger.debug({ status: r.status }, 'keepalive'))
        .catch((err) => logger.warn({ err }, 'keepalive failed'));
    timers.push(setInterval(ping, 10 * 60_000));
    logger.info(`⏰ keepalive every 10 min → ${url}`);
  }

  if (env.NODE_ENV !== 'test') {
    const w = dbWatch({ check: () => db.execute(sql`select 1`), send: alert });
    timers.push(setInterval(() => void w.tick(), 60_000));
    if (!alertPhones().length) logger.warn('ALERT_PHONES خالی است؛ هشدار قطعی دیتابیس فقط در لاگ می‌آید');
  }

  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}
