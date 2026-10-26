/**
 * پنل ادمین — دور ۳۹: داشبورد زنده با دادهٔ واقعی
 *   آنلاین همین حالا (مهمان + عضو)، بازدید (امروز، ۳۰ روز، از اول، روزانه)، رویدادهای واقعی اپ، قیف تبدیل آگهی
 *   GET /admin/panel/live — سبک؛ داشبورد هر ۱۵ ثانیه می‌خواند
 */
import { Router } from 'express';
import { and, desc, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { adResponses, ads, contracts, conversations, disputes, kycRequests, profiles, projectPayments, projects, reports, strikes, urgentRequests, users } from '../../db/schema';
import { ah } from '../../lib/http';
import { perm, type AdminCtx } from '../../middlewares/auth';
import { onlineEntries, visitStats } from '../../lib/presence';
import { tehranDay } from '../../lib/dates';
import { analytics, RANGES, type Range } from './analytics';
import { SAMPLE_PREFIX } from '../../lib/samples';

const ROLE_FA: Record<string, string> = { worker: 'کارگر', specialist: 'متخصص', engineer: 'مهندس', contractor: 'پیمانکار', company: 'شرکت ساختمانی', general: 'کارفرما' };
const TYPE_FA: Record<string, string> = { work: 'آمادهٔ همکاری', job: 'نیاز به نیرو', consult: 'پرسش تخصصی' };
const faN = (n: number) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
const mil = (n: number) => (n >= 1e6 ? faN(Math.round(n / 1e5) / 10).replace('.', '٫') + ' میلیون' : faN(n)) + ' تومان';

export type LiveEvent = { k: string; t: string; at: Date };

/** آخرین رخدادهای واقعی اپ از جدول‌ها (جدیدترین اول) */
export async function recentEvents(a: AdminCtx, limit = 30): Promise<LiveEvent[]> {
  const since = new Date(Date.now() - 7 * 86400_000);
  const prov = a.provinces.length ? a.provinces : null;
  const [ps, as, pj, ct, pay, ky, rp, ds, ug, st] = await Promise.all([
    db.select({ name: profiles.displayName, role: profiles.role, city: profiles.city, at: profiles.createdAt }).from(profiles)
      .where(and(gte(profiles.createdAt, since), prov ? inArray(profiles.province, prov) : undefined)).orderBy(desc(profiles.createdAt)).limit(limit),
    db.select({ title: ads.title, type: ads.type, city: ads.city, at: ads.createdAt }).from(ads)
      .where(and(gte(ads.createdAt, since), prov ? inArray(ads.province, prov) : undefined)).orderBy(desc(ads.createdAt)).limit(limit),
    db.select({ title: projects.title, at: projects.createdAt }).from(projects).where(gte(projects.createdAt, since)).orderBy(desc(projects.createdAt)).limit(limit),
    db.select({ title: projects.title, no: contracts.number, at: contracts.activatedAt }).from(contracts).innerJoin(projects, sql`${projects.id} = ${contracts.projectId}`)
      .where(and(isNotNull(contracts.activatedAt), gte(contracts.activatedAt, since))).orderBy(desc(contracts.activatedAt)).limit(limit),
    db.select({ amount: projectPayments.amount, title: projects.title, at: projectPayments.createdAt }).from(projectPayments).innerJoin(projects, sql`${projects.id} = ${projectPayments.projectId}`)
      .where(gte(projectPayments.createdAt, since)).orderBy(desc(projectPayments.createdAt)).limit(limit),
    db.select({ at: kycRequests.createdAt }).from(kycRequests).where(gte(kycRequests.createdAt, since)).orderBy(desc(kycRequests.createdAt)).limit(limit),
    db.select({ reason: reports.reason, at: reports.createdAt }).from(reports).where(gte(reports.createdAt, since)).orderBy(desc(reports.createdAt)).limit(limit),
    db.select({ at: disputes.createdAt }).from(disputes).where(gte(disputes.createdAt, since)).orderBy(desc(disputes.createdAt)).limit(limit),
    db.select({ title: urgentRequests.title, city: urgentRequests.city, at: urgentRequests.createdAt }).from(urgentRequests).where(gte(urgentRequests.createdAt, since)).orderBy(desc(urgentRequests.createdAt)).limit(limit),
    db.select({ kind: strikes.kind, at: strikes.createdAt }).from(strikes).where(gte(strikes.createdAt, since)).orderBy(desc(strikes.createdAt)).limit(limit),
  ]);
  const out: LiveEvent[] = [
    ...ps.map((x) => ({ k: 'user', t: `«${x.name}» به‌عنوان ${ROLE_FA[x.role] || x.role} در ${x.city} ثبت‌نام کرد`, at: x.at })),
    ...as.map((x) => ({ k: 'ad', t: `آگهی «${x.title}» (${TYPE_FA[x.type] || x.type}) در ${x.city} منتشر شد`, at: x.at })),
    ...pj.map((x) => ({ k: 'chat', t: `توافق «${x.title}» در چت تأیید شد`, at: x.at })),
    ...ct.map((x) => ({ k: 'chat', t: `قرارداد ${x.no} «${x.title}» را هر دو طرف امضا کردند`, at: x.at! })),
    ...pay.map((x) => ({ k: 'pay', t: `پرداخت ${mil(Number(x.amount))} برای «${x.title}» ثبت شد`, at: x.at })),
    ...ky.map((x) => ({ k: 'kyc', t: 'درخواست تأیید هویت تازه رسید', at: x.at })),
    ...rp.map((x) => ({ k: 'flag', t: `گزارش تازه: ${x.reason}`, at: x.at })),
    ...ds.map((x) => ({ k: 'arb', t: 'پروندهٔ اختلاف تازه باز شد', at: x.at })),
    ...ug.map((x) => ({ k: 'ad', t: `درخواست نیروی فوری «${x.title}» در ${x.city}`, at: x.at })),
    ...st.map((x) => ({ k: 'flag', t: `بدقولی ثبت شد (${x.kind === 'no_show' ? 'سر کار نیامد' : x.kind === 'cancel' ? 'لغو یک‌طرفه' : 'عمل نکردن به قرارداد'})`, at: x.at })),
  ];
  return out.sort((x, y) => +y.at - +x.at).slice(0, limit);
}

/** قیف تبدیل آگهی (از اول): دیدن ← اعلام آمادگی/پاسخ ← گفت‌وگو ← توافق ← قرارداد امضاشده */
export async function adFunnel() {
  const [[v], [r], [c], [d], [s]] = await Promise.all([
    db.select({ n: sql<number>`coalesce(sum(${ads.views}),0)::int` }).from(ads),
    db.select({ n: sql<number>`count(*)::int` }).from(adResponses),
    db.select({ n: sql<number>`count(*)::int` }).from(conversations).where(isNotNull(conversations.adId)),
    db.select({ n: sql<number>`count(*)::int` }).from(projects).where(isNotNull(projects.adId)),
    db.select({ n: sql<number>`count(*)::int` }).from(contracts).innerJoin(projects, sql`${projects.id} = ${contracts.projectId}`)
      .where(and(isNotNull(projects.adId), sql`${contracts.status} = 'active'`)),
  ]);
  return { views: v.n, responses: r.n, chats: c.n, deals: d.n, signed: s.n };
}

/**
 * ثبت‌نام‌ها به روز تهران (نه UTC) و فقط کاربران واقعی (بدون حساب‌های نمونهٔ 0900000…)
 * «کامل» = دست‌کم یک نقش ساخته؛ بقیه فقط کد پیامکی را زده‌اند و فرم را نیمه رها کرده‌اند
 */
export async function peopleStats() {
  const today = tehranDay(), from30 = tehranDay(-29);
  const real = sql`u.status <> 'deleted' and u.phone not like ${SAMPLE_PREFIX + '%'}`;
  const { rows } = await db.execute<{ today: number; today_done: number; yesterday: number; week: number; month: number; total: number; total_done: number }>(sql`
    with x as (
      select (u.created_at at time zone 'Asia/Tehran')::date d, exists (select 1 from profiles p where p.user_id = u.id) done
      from users u where ${real}
    )
    select count(*) filter (where d = ${today}::date)::int as today,
      count(*) filter (where d = ${today}::date and done)::int as today_done,
      count(*) filter (where d = ${today}::date - 1)::int as yesterday,
      count(*) filter (where d > ${today}::date - 7)::int as week,
      count(*) filter (where d > ${today}::date - 30)::int as month,
      count(*)::int as total,
      count(*) filter (where done)::int as total_done
    from x`);
  const { rows: daily } = await db.execute<{ d: string; n: number }>(sql`
    select to_char(g.d, 'YYYY-MM-DD') d, count(u.id)::int n
    from generate_series(${from30}::date, ${today}::date, interval '1 day') g(d)
    left join users u on (u.created_at at time zone 'Asia/Tehran')::date = g.d::date and ${real}
    group by g.d order by g.d`);
  const p = rows[0];
  return { today: p.today, todayDone: p.today_done, yesterday: p.yesterday, week: p.week, month: p.month, total: p.total, totalDone: p.total_done, daily };
}

/** آنلاین همین حالا — بدون مدیران و حساب‌های نمونه (و مرورگری که قبلاً با آن‌ها دیده شده) */
export async function onlineStats() {
  const list = onlineEntries();
  if (!list.length) return { now: 0, guests: 0, members: 0 };
  const vids = list.map(([v]) => v), uids = [...new Set(list.map(([, u]) => u).filter((u): u is string => !!u))];
  const { rows } = await db.execute<{ visitor: string }>(sql`
    select distinct x.visitor from site_visits x join users u on u.id = x.user_id
    where x.visitor in (${sql.join(vids.map((v) => sql`${v}`), sql`, `)}) and (u.is_admin or u.phone like ${SAMPLE_PREFIX + '%'})`);
  const bad = new Set(rows.map((r) => r.visitor));
  if (uids.length) {
    const inner = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, uids), sql`(${users.isAdmin} or ${users.phone} like ${SAMPLE_PREFIX + '%'})`));
    const innerIds = new Set(inner.map((x) => x.id));
    list.forEach(([v, u]) => { if (u && innerIds.has(u)) bad.add(v); });
  }
  const real = list.filter(([v]) => !bad.has(v));
  const members = real.filter(([, u]) => u).length;
  return { now: real.length, guests: real.length - members, members };
}

export function registerLiveRoutes(r: Router) {
  r.get(
    '/live',
    perm('dash', 1),
    ah(async (req, res) => {
      const range = (RANGES as readonly string[]).includes(String(req.query.range)) ? (req.query.range as Range) : 'today';
      const [events, visits, online, people, stats] = await Promise.all([recentEvents(req.admin!), visitStats(), onlineStats(), peopleStats(), analytics(range)]);
      res.json({ at: new Date(), online, visits, people, analytics: stats, events });
    }),
  );
}
