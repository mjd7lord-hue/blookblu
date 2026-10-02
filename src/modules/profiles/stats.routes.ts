/**
 * /api/me/stats — آمار عملکرد واقعی نقش فعال (۶ ماه شمسی اخیر):
 * بازدید پروفایل و آگهی‌ها، پاسخ‌های دریافتی و فرستاده، نرخ و زمان پاسخ، تبدیل به پروژه،
 * درآمد ثبت‌شده در دفترچهٔ پرداخت، و پرتقاضاترین مهارت‌ها در استان.
 */
import { Router } from 'express';
import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { adResponses, ads, projectPayments, projects, viewDays } from '../../db/schema';
import { ah } from '../../lib/http';
import { lastPersianMonths } from '../../lib/views';
import { requireProfile } from '../../middlewares/auth';

const r = Router();

r.get(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const p = req.profile!;
    const { months, keyOf } = lastPersianMonths(6);
    const since = new Date(Date.now() - 200 * 86400_000);
    const sinceDay = since.toISOString().slice(0, 10);
    const bucket = () => Object.fromEntries(months.map((m) => [m.key, 0])) as Record<string, number>;
    const series = (b: Record<string, number>) => months.map((m) => b[m.key] ?? 0);

    const myAds = await db.select({ id: ads.id, views: ads.views, status: ads.status }).from(ads).where(eq(ads.profileId, p.id));
    const adIds = myAds.map((a) => a.id);

    const [pv, av, recv, sent, projs, pays, demand] = await Promise.all([
      db.select({ day: viewDays.day, n: viewDays.n }).from(viewDays).where(and(eq(viewDays.kind, 'profile'), eq(viewDays.itemId, p.id), gte(viewDays.day, sinceDay))),
      adIds.length ? db.select({ day: viewDays.day, n: viewDays.n }).from(viewDays).where(and(eq(viewDays.kind, 'ad'), inArray(viewDays.itemId, adIds), gte(viewDays.day, sinceDay))) : Promise.resolve([]),
      adIds.length
        ? db.select({ createdAt: adResponses.createdAt, status: adResponses.status, respondedAt: adResponses.respondedAt }).from(adResponses).where(inArray(adResponses.adId, adIds))
        : Promise.resolve([]),
      db.select({ createdAt: adResponses.createdAt, status: adResponses.status }).from(adResponses).where(eq(adResponses.profileId, p.id)),
      db
        .select({ id: projects.id, status: projects.status, adId: projects.adId, provider: projects.providerProfileId, createdAt: projects.createdAt })
        .from(projects)
        .where(or(eq(projects.clientProfileId, p.id), eq(projects.providerProfileId, p.id))),
      db
        .select({ amount: projectPayments.amount, paidOn: projectPayments.paidOn })
        .from(projectPayments)
        .innerJoin(projects, eq(projects.id, projectPayments.projectId))
        .where(and(eq(projects.providerProfileId, p.id), eq(projectPayments.status, 'confirmed'), gte(projectPayments.paidOn, sinceDay))),
      db
        .select({ skill: sql<string>`unnest(${ads.skills})`, n: sql<number>`count(*)::int` })
        .from(ads)
        .where(and(eq(ads.province, p.province), eq(ads.status, 'active'), gte(ads.createdAt, new Date(Date.now() - 30 * 86400_000))))
        .groupBy(sql`1`)
        .orderBy(sql`2 desc`)
        .limit(3),
    ]);

    const pvB = bucket(), avB = bucket(), rcB = bucket(), snB = bucket(), incB = bucket();
    pv.forEach((x) => { const k = keyOf(x.day); if (k in pvB) pvB[k] += x.n; });
    av.forEach((x) => { const k = keyOf(x.day); if (k in avB) avB[k] += x.n; });
    recv.forEach((x) => { const k = keyOf(x.createdAt); if (k in rcB) rcB[k]++; });
    sent.forEach((x) => { const k = keyOf(x.createdAt); if (k in snB) snB[k]++; });
    pays.forEach((x) => { const k = keyOf(x.paidOn); if (k in incB) incB[k] += x.amount; });

    const answered = recv.filter((x) => x.status === 'accepted' || x.status === 'rejected');
    const times = answered.filter((x) => x.respondedAt).map((x) => (x.respondedAt!.getTime() - x.createdAt.getTime()) / 60000);
    const fromMyAds = projs.filter((x) => x.adId && adIds.includes(x.adId)).length;
    const accepted = sent.filter((x) => x.status === 'accepted').length;

    res.json({
      months: months.map((m) => m.name),
      profileViews: { total: p.views, monthly: series(pvB) },
      adViews: { total: myAds.reduce((s, a) => s + a.views, 0), monthly: series(avB), activeAds: myAds.filter((a) => a.status === 'active').length },
      responses: {
        received: recv.length,
        receivedMonthly: series(rcB),
        sent: sent.length,
        sentMonthly: series(snB),
        answerRate: recv.length ? Math.round((answered.length / recv.length) * 100) : null,
        avgAnswerMinutes: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
        // تبدیل به همکاری: برای آگهی‌دهنده پروژه از آگهی‌ها / پاسخ‌های دریافتی؛ برای پاسخ‌دهنده پاسخ‌های پذیرفته‌شده / فرستاده
        conversion: recv.length ? Math.round((fromMyAds / recv.length) * 100) : sent.length ? Math.round((accepted / sent.length) * 100) : null,
      },
      projects: { total: projs.length, active: projs.filter((x) => x.status === 'active').length, done: projs.filter((x) => x.status === 'done').length },
      income: { monthly: series(incB), total: pays.reduce((s, x) => s + x.amount, 0) },
      demand: demand.map((d) => ({ skill: d.skill, n: d.n })),
      province: p.province,
    });
  }),
);

export default r;
