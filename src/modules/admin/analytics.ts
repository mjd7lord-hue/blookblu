/**
 * پنل ادمین — دور ۵۱: آمار بازدید و رشد به سبک ابزارهای جهانی (Google Analytics / Plausible)
 *   بازه: امروز | ۷ روز | ۳۰ روز | از اول — هر عدد با بازهٔ قبلیِ هم‌اندازه مقایسه می‌شود
 *   بازدیدکنندهٔ یکتا، بار باز شدن، میانگین زمان ماندن، نرخ پرش، تازه/برگشتی، عضو/مهمان، نصب‌شده
 *   منبع ورود، دستگاه، سیستم‌عامل، مرورگر، قیف ثبت‌نام، نمودار ساعتی (امروز) یا روزانه
 * همه به وقت تهران؛ بازدید مدیران، حساب‌های نمونه (0900000…) و ربات‌ها شمرده نمی‌شود.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { addDays, tehranDay } from '../../lib/dates';
import { SAMPLE_PREFIX } from '../../lib/samples';

export const RANGES = ['today', '7d', '30d', 'all'] as const;
export type Range = (typeof RANGES)[number];

const SAMPLE = SAMPLE_PREFIX + '%';
// بازدیدکننده‌ای که حتی یک بار با حساب مدیر یا نمونه دیده شده، «داخلی» است
const VISITS = sql`(select * from site_visits sv where not exists (
  select 1 from site_visits x join users u on u.id = x.user_id
  where x.visitor = sv.visitor and (u.is_admin or u.phone like ${SAMPLE})))`;
const REAL_USER = sql`u.status <> 'deleted' and not u.is_admin and u.phone not like ${SAMPLE}`;
const TEHRAN_DAY = (col: SQL) => sql`(${col} at time zone 'Asia/Tehran')::date`;

async function rows<T>(q: SQL) {
  return (await db.execute<T & Record<string, unknown>>(q)).rows as T[];
}

async function metrics(from: string, to: string) {
  const [m] = await rows<{ visitors: number; views: number; visits: number; bounces: number; avg_sec: number; members: number; installed: number; returning: number }>(sql`
    select count(distinct v.visitor)::int as visitors, coalesce(sum(v.views), 0)::int as views, count(*)::int as visits,
      count(*) filter (where v.views <= 1 and v.last_at - v.first_at < interval '30 seconds')::int as bounces,
      coalesce(round(avg(extract(epoch from v.last_at - v.first_at))), 0)::int as avg_sec,
      count(distinct v.visitor) filter (where v.user_id is not null)::int as members,
      count(distinct v.visitor) filter (where v.installed)::int as installed,
      count(distinct v.visitor) filter (where exists (select 1 from site_visits p where p.visitor = v.visitor and p.day < ${from}::date))::int as returning
    from ${VISITS} v where v.day between ${from}::date and ${to}::date`);
  const [s] = await rows<{ signups: number; done: number }>(sql`
    select count(*)::int as signups, count(*) filter (where exists (select 1 from profiles p where p.user_id = u.id))::int as done
    from users u where ${REAL_USER} and ${TEHRAN_DAY(sql`u.created_at`)} between ${from}::date and ${to}::date`);
  // قیف: شماره وارد کرد (کد خواست، تازه‌وارد) ← کد را تأیید کرد (حساب ساخته شد) ← نقش ساخت (ثبت‌نام کامل)
  const [o] = await rows<{ phones: number }>(sql`
    select count(distinct o.phone)::int as phones from otp_codes o left join users u on u.phone = o.phone
    where o.purpose = 'login' and o.phone not like ${SAMPLE} and ${TEHRAN_DAY(sql`o.created_at`)} between ${from}::date and ${to}::date
      and (u.id is null or (${TEHRAN_DAY(sql`u.created_at`)} >= ${from}::date and not u.is_admin))`);
  return {
    visitors: m.visitors, views: m.views, visits: m.visits, avgSec: m.avg_sec,
    bounceRate: m.visits ? Math.round((m.bounces / m.visits) * 1000) / 10 : 0,
    members: m.members, guests: m.visitors - m.members, installed: m.installed, returning: m.returning, newVisitors: m.visitors - m.returning,
    signups: s.done, accounts: s.signups, halfDone: s.signups - s.done, phones: Math.max(o.phones, s.signups),
    // ثبت‌نامی که بدون پینگ اپ آمده (مثلاً از نسخهٔ قدیمی) نرخ را از ۱۰۰٪ بالاتر نبرد
    conversion: m.visitors ? Math.min(100, Math.round((s.done / m.visitors) * 1000) / 10) : 0,
  };
}

async function breakdown(col: 'source' | 'device' | 'os' | 'browser', from: string, to: string) {
  return rows<{ k: string; n: number }>(sql`
    select coalesce(v.${sql.raw(col)}, 'unknown') as k, count(distinct v.visitor)::int as n
    from ${VISITS} v where v.day between ${from}::date and ${to}::date group by 1 order by 2 desc limit 8`);
}

async function series(range: Range, from: string, to: string) {
  if (range === 'today') {
    return rows<{ k: string; visitors: number; views: number; signups: number }>(sql`
      select lpad(h::text, 2, '0') as k,
        (select count(distinct v.visitor) from ${VISITS} v where v.day = ${to}::date and extract(hour from v.first_at at time zone 'Asia/Tehran') = h)::int as visitors,
        (select coalesce(sum(v.views), 0) from ${VISITS} v where v.day = ${to}::date and extract(hour from v.first_at at time zone 'Asia/Tehran') = h)::int as views,
        (select count(*) from users u where ${REAL_USER} and ${TEHRAN_DAY(sql`u.created_at`)} = ${to}::date and extract(hour from u.created_at at time zone 'Asia/Tehran') = h)::int as signups
      from generate_series(0, 23) h order by h`);
  }
  return rows<{ k: string; visitors: number; views: number; signups: number }>(sql`
    select to_char(g.d, 'YYYY-MM-DD') as k,
      (select count(distinct v.visitor) from ${VISITS} v where v.day = g.d::date)::int as visitors,
      (select coalesce(sum(v.views), 0) from ${VISITS} v where v.day = g.d::date)::int as views,
      (select count(*) from users u where ${REAL_USER} and ${TEHRAN_DAY(sql`u.created_at`)} = g.d::date)::int as signups
    from generate_series(${from}::date, ${to}::date, interval '1 day') g(d) order by g.d`);
}

export async function analytics(range: Range = 'today') {
  const to = tehranDay();
  let from = to, prevFrom: string | null = addDays(to, -1), prevTo: string | null = addDays(to, -1);
  if (range === '7d' || range === '30d') {
    const n = range === '7d' ? 7 : 30;
    from = addDays(to, -(n - 1)); prevTo = addDays(from, -1); prevFrom = addDays(prevTo, -(n - 1));
  } else if (range === 'all') {
    const [f] = await rows<{ d: string | null }>(sql`select to_char(least((select min(day) from site_visits), (select min((created_at at time zone 'Asia/Tehran')::date) from users)), 'YYYY-MM-DD') as d`);
    // نمودار «از اول» حداکثر ۱۲۰ روز اخیر را روز به روز نشان می‌دهد
    from = f?.d && f.d < to ? (f.d < addDays(to, -119) ? addDays(to, -119) : f.d) : to;
    prevFrom = prevTo = null;
  }
  const allFrom = range === 'all' ? '2000-01-01' : from;
  const [cur, prev, sources, devices, os, browsers, chart] = await Promise.all([
    metrics(allFrom, to),
    prevFrom && prevTo ? metrics(prevFrom, prevTo) : Promise.resolve(null),
    breakdown('source', allFrom, to),
    breakdown('device', allFrom, to),
    breakdown('os', allFrom, to),
    breakdown('browser', allFrom, to),
    series(range, from, to),
  ]);
  return { range, from, to, cur, prev, sources, devices, os, browsers, chart };
}
