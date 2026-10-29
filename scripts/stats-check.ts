/**
 * بررسی پرس‌وجوهای آمار داشبورد پنل روی دیتابیس .env (فقط خواندن، چیزی تغییر نمی‌کند)
 *   npm run stats:check
 */
import { analytics } from '../src/modules/admin/analytics';
import { adFunnel, onlineStats, peopleStats } from '../src/modules/admin/panel-live';
import { visitStats } from '../src/lib/presence';
import { pool } from '../src/db';

async function run(name: string, f: () => Promise<unknown>) {
  try {
    const r = await f();
    console.log('✅', name, JSON.stringify(r).slice(0, 200));
  } catch (e) {
    const err = e as Error & { cause?: Error };
    console.log('❌', name, err.message, err.cause?.message ?? '');
  }
}

(async () => {
  await run('analytics(today)', () => analytics('today'));
  await run('analytics(7d)', () => analytics('7d'));
  await run('people', () => peopleStats());
  await run('online', () => onlineStats());
  await run('visits', () => visitStats());
  await run('funnel', () => adFunnel());
  await pool.end();
})();
