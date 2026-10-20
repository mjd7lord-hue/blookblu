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
import { onlineNow, visitStats } from '../../lib/presence';

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

export async function onlineStats() {
  const p = onlineNow();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(gte(users.lastSeenAt, new Date(Date.now() - 5 * 60_000)));
  return { now: p.all, guests: p.guests, members: Math.max(p.members, n) };
}

export function registerLiveRoutes(r: Router) {
  r.get(
    '/live',
    perm('dash', 1),
    ah(async (req, res) => {
      const [events, visits, online] = await Promise.all([recentEvents(req.admin!), visitStats(), onlineStats()]);
      res.json({ at: new Date(), online, visits, events });
    }),
  );
}
