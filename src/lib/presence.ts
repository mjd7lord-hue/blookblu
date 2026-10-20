import { sql } from 'drizzle-orm';
import { db } from '../db';
import { siteVisits, users } from '../db/schema';
import { tehranDay } from './dates';
import { eq } from 'drizzle-orm';

/**
 * حضور لحظه‌ای و بازدید (دور ۳۹):
 * اپ هر ۶۰ ثانیه (وقتی صفحه باز است) و با هر باز شدن /api/app/ping می‌زند.
 * «آنلاین همین حالا» = بازدیدکننده‌هایی (مهمان یا واردشده) که در ۲ دقیقهٔ اخیر پینگ زده‌اند — درون‌حافظه (یک نمونهٔ سرور).
 * بازدید روزانه در site_visits ذخیره می‌شود (هر بازدیدکننده در هر روز یک ردیف).
 */
const seen = new Map<string, { at: number; userId: string | null }>();
export const ONLINE_MS = 2 * 60_000;

export function onlineNow() {
  const t = Date.now() - ONLINE_MS;
  let all = 0, members = 0;
  for (const [k, v] of seen) {
    if (v.at < t) { seen.delete(k); continue; }
    all++;
    if (v.userId) members++;
  }
  return { all, members, guests: all - members };
}

const lastUserTouch = new Map<string, number>();
/** lastSeenAt کاربر (حداکثر هر ۶۰ ثانیه یک بار در دیتابیس) */
export function touchUser(userId: string) {
  const now = Date.now();
  if ((lastUserTouch.get(userId) ?? 0) > now - 60_000) return;
  lastUserTouch.set(userId, now);
  db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId)).catch(() => {});
}

export async function ping(visitor: string, userId: string | null, view: boolean) {
  const prev = seen.get(visitor);
  seen.set(visitor, { at: Date.now(), userId });
  if (userId) touchUser(userId);
  // پینگ دوره‌ای بدون باز شدن صفحه، اگر همین الان ثبت شده، به دیتابیس نمی‌رود
  if (!view && prev && Date.now() - prev.at < 50_000) return;
  await db
    .insert(siteVisits)
    .values({ day: tehranDay(), visitor, userId, views: view ? 1 : 0 })
    .onConflictDoUpdate({
      target: [siteVisits.day, siteVisits.visitor],
      set: { views: sql`${siteVisits.views} + ${view ? 1 : 0}`, lastAt: new Date(), userId: sql`coalesce(${userId}::uuid, ${siteVisits.userId})` },
    });
}

/** آمار بازدید: امروز، ۳۰ روز اخیر، از اول، سری روزانه */
export async function visitStats() {
  const today = tehranDay(), from30 = tehranDay(-29);
  const { rows } = await db.execute<{ k: string; views: number; visitors: number }>(sql`
    select 'today' k, coalesce(sum(views),0)::int views, count(*)::int visitors from site_visits where day = ${today}::date
    union all
    select 'month', coalesce(sum(views),0)::int, count(distinct visitor)::int from site_visits where day >= ${from30}::date
    union all
    select 'total', coalesce(sum(views),0)::int, count(distinct visitor)::int from site_visits`);
  const by = Object.fromEntries(rows.map((r) => [r.k, { views: r.views, visitors: r.visitors }]));
  const { rows: series } = await db.execute<{ d: string; views: number; visitors: number }>(sql`
    select to_char(g.d, 'YYYY-MM-DD') d, coalesce(sum(v.views),0)::int views, count(v.visitor)::int visitors
    from generate_series(${from30}::date, ${today}::date, interval '1 day') g(d)
    left join site_visits v on v.day = g.d::date
    group by g.d order by g.d`);
  return { today: by.today, month: by.month, total: by.total, daily: series };
}
