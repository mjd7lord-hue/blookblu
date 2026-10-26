import { env } from './config/env';
import { createApp } from './app';
import { pool } from './db';
import { logger } from './lib/logger';
import { startMonitor } from './lib/monitor';
import { startStrikeSweeper } from './modules/trust/strikes';
import { recomputeVerified } from './modules/admin/admin.service';
import { finalizeExpired } from './modules/arbitration/arbitration.service';
import { expireStale } from './modules/pay/pay.service';

const server = createApp().listen(env.PORT, () => {
  logger.info(`🧱 Block API on :${env.PORT} (${env.NODE_ENV}, sms=${env.SMS_PROVIDER}, storage=${env.STORAGE_DRIVER})`);
});

// هر ساعت: نشان «مدرک‌دار» پروفایل‌هایی که مدرکشان منقضی شده برداشته می‌شود
// و رأی‌های داوری که مهلت اعتراضشان گذشته نهایی می‌شوند
const sweep = () =>
  Promise.all([
    recomputeVerified().then((n) => n && logger.info({ changed: n }, 'verified badges recomputed')),
    finalizeExpired().then((n) => n && logger.info({ finalized: n }, 'arbitration verdicts finalized')),
    expireStale().then((n) => n && logger.info({ expired: n }, 'stale gateway payments expired')),
  ]).catch((err) => logger.error({ err }, 'hourly sweep failed'));
setTimeout(sweep, 30_000).unref();
setInterval(sweep, 3600_000).unref();
// پرداخت‌های نیمه‌کارهٔ درگاه هر ۱۰ دقیقه
setInterval(() => void expireStale().catch((err) => logger.error({ err }, 'payment expiry failed')), 10 * 60_000).unref();

// بیدار نگه داشتن روی Render و هشدار پیامکی قطعی دیتابیس (lib/monitor.ts)
startMonitor();
startStrikeSweeper();

function shutdown() {
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
