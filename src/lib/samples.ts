import { sql, type SQL } from 'drizzle-orm';
import { users } from '../db/schema';
import { cfg } from './appConfig';

/**
 * حساب‌های نمونه/آزمایشی (شماره‌های 0900000xxxx: npm run showcase و npm run test:projects) — دور ۴۲
 * پاک نمی‌شوند، ولی در فهرست‌های عمومی (کاوش، جست‌وجو، پاسخ‌ها، نیروی فوری) دیده نمی‌شوند تا اپ ساختگی به نظر نرسد.
 * مدیر برای نمایش اپ می‌تواند در پنل «نمایش حساب‌های نمونه» (flags.showSamples) را روشن کند.
 */
export const SAMPLE_PREFIX = '0900000';
export function realUsersOnly(): SQL | undefined {
  const show = (cfg('settings').flags as Record<string, boolean>).showSamples === true;
  return show ? undefined : sql`${users.phone} not like ${SAMPLE_PREFIX + '%'}`;
}
