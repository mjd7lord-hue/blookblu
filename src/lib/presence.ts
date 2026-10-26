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

/** بازدیدکننده‌های ۲ دقیقهٔ اخیر: [شناسهٔ مرورگر، کاربر] */
export function onlineEntries(): [string, string | null][] {
  const t = Date.now() - ONLINE_MS;
  return [...seen].filter(([, v]) => v.at >= t).map(([k, v]) => [k, v.userId]);
}

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

/* ---------- جزئیات بازدید (دور ۵۱) — مثل ابزارهای آمار جهانی، بدون IP و کوکی ---------- */

export const BOT_UA = /bot|crawl|spider|slurp|headlesschrome|lighthouse|pagespeed|facebookexternalhit|embedly|preview|monitor|uptime/i;

export type VisitMeta = { device: string; os: string; browser: string; source: string; installed: boolean };

export function parseUA(ua = '') {
  const device = /ipad|tablet/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua)) ? 'tablet' : /mobi|iphone|ipod|android/i.test(ua) ? 'mobile' : 'desktop';
  const os = /android/i.test(ua) ? 'android' : /iphone|ipad|ipod/i.test(ua) ? 'ios' : /windows/i.test(ua) ? 'windows' : /mac os/i.test(ua) ? 'mac' : /linux|cros/i.test(ua) ? 'linux' : 'other';
  const browser = /instagram/i.test(ua) ? 'instagram' : /telegram/i.test(ua) ? 'telegram' : /samsungbrowser/i.test(ua) ? 'samsung' : ua.includes('Edg/') ? 'edge' : ua.includes('OPR/') || /opera/i.test(ua) ? 'opera' : /firefox|fxios/i.test(ua) ? 'firefox' : /chrome|crios/i.test(ua) ? 'chrome' : /safari/i.test(ua) ? 'safari' : 'other';
  return { device, os, browser };
}

const SOURCES: [string[], string][] = [
  [['bing.com'], 'bing'], [['t.me', 'telegram.org', 'telegram.me'], 'telegram'], [['instagram.com'], 'instagram'], [['wa.me', 'whatsapp.com'], 'whatsapp'],
  [['eitaa.com'], 'eitaa'], [['rubika.ir'], 'rubika'], [['ble.ir', 'bale.ai'], 'bale'], [['divar.ir'], 'divar'], [['twitter.com', 'x.com', 't.co'], 'x'],
  [['facebook.com', 'fb.com'], 'facebook'], [['youtube.com', 'youtu.be'], 'youtube'], [['aparat.com'], 'aparat'], [['linkedin.com'], 'linkedin'], [['blooko.ir'], 'direct'],
];
const onHost = (h: string, d: string) => h === d || h.endsWith('.' + d);
/** منبع ورود: utm_source یا دامنهٔ صفحهٔ قبلی؛ مرورگر داخلی اینستاگرام/تلگرام هم منبع است */
export function normSource(src: string | undefined, browser: string): string {
  const s = (src || '').trim().toLowerCase().replace(/^https?:/, '').replace(/^[/]+/, '').replace(/^www[.]/, '').split(/[/?#]/)[0].slice(0, 40);
  if (!s) return browser === 'instagram' || browser === 'telegram' ? browser : 'direct';
  if (/(^|[.])google[.]/.test(s)) return 'google';
  for (const [hosts, name] of SOURCES) if (hosts.some((d) => onHost(s, d))) return name;
  if (/^[a-z0-9_-]+$/.test(s) && !s.includes('.')) return s; // utm_source=telegram
  return /^[a-z0-9.-]+$/.test(s) ? s : 'other';
}

export async function ping(visitor: string, userId: string | null, view: boolean, meta?: VisitMeta) {
  const prev = seen.get(visitor);
  seen.set(visitor, { at: Date.now(), userId });
  if (userId) touchUser(userId);
  // پینگ دوره‌ای بدون باز شدن صفحه، اگر همین الان ثبت شده، به دیتابیس نمی‌رود
  if (!view && prev && Date.now() - prev.at < 50_000) return;
  const m = meta ?? { device: null, os: null, browser: null, source: null, installed: false };
  await db
    .insert(siteVisits)
    .values({ day: tehranDay(), visitor, userId, views: view ? 1 : 0, ...m })
    .onConflictDoUpdate({
      target: [siteVisits.day, siteVisits.visitor],
      set: {
        views: sql`${siteVisits.views} + ${view ? 1 : 0}`,
        lastAt: new Date(),
        userId: sql`coalesce(${userId}::uuid, ${siteVisits.userId})`,
        // جزئیات از اولین بازدید روز می‌ماند؛ فقط اگر خالی بود پر می‌شود
        device: sql`coalesce(${siteVisits.device}, excluded.device)`,
        os: sql`coalesce(${siteVisits.os}, excluded.os)`,
        browser: sql`coalesce(${siteVisits.browser}, excluded.browser)`,
        source: sql`coalesce(${siteVisits.source}, excluded.source)`,
        installed: sql`${siteVisits.installed} or excluded.installed`,
      },
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
