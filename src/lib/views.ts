import { sql } from 'drizzle-orm';
import { db } from '../db';
import { viewDays } from '../db/schema';
import { logger } from './logger';
import { tehranDay } from './dates';

/** یک بازدید (پروفایل یا آگهی) در شمارندهٔ روزانه؛ هیچ‌وقت درخواست اصلی را خراب نمی‌کند */
export async function bumpView(kind: 'profile' | 'ad', itemId: string) {
  try {
    await db
      .insert(viewDays)
      .values({ kind, itemId, day: tehranDay(), n: 1 })
      .onConflictDoUpdate({ target: [viewDays.kind, viewDays.itemId, viewDays.day], set: { n: sql`${viewDays.n} + 1` } });
  } catch (err) {
    logger.warn({ err }, 'view count failed');
  }
}

/** ۶ ماه شمسی اخیر (قدیمی ← تازه): کلید «سال-ماه» و نام ماه */
export function lastPersianMonths(n = 6) {
  const key = (d: Date) => new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', timeZone: 'Asia/Tehran' }).format(d).replace(/[^\d]+/g, '-');
  const name = (d: Date) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'long', timeZone: 'Asia/Tehran' }).format(d);
  const out: { key: string; name: string }[] = [];
  const d = new Date();
  for (let i = 0; i < 400 && out.length < n; i++) {
    const x = new Date(d.getTime() - i * 86400_000);
    const k = key(x);
    if (!out.some((o) => o.key === k)) out.push({ key: k, name: name(x) });
  }
  return { months: out.reverse(), keyOf: (day: string | Date) => key(typeof day === 'string' ? new Date(day + 'T12:00:00Z') : day) };
}
