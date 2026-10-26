/**
 * درگاه پرداخت (دور ۵۳): هزینهٔ داوری و ارتقای آگهی
 *
 * قواعد امنیتی:
 *   ۱) مبلغ فقط روی سرور حساب می‌شود (هزینهٔ پرونده یا قیمت پلن از تنظیمات)؛ اپ مبلغ نمی‌فرستد.
 *   ۲) فقط صاحب کار پرداخت می‌کند: پرداخت‌کنندهٔ پرونده / صاحب آگهی.
 *   ۳) Status=OK در آدرس برگشت کافی نیست؛ همیشه verify خود درگاه با مبلغ ذخیره‌شده.
 *   ۴) هر پرداخت یک بار اعمال می‌شود: تغییر وضعیت pending → paid شرطی و در همان تراکنش با اثرش.
 *   ۵) پرداخت نیمه‌کاره بعد از ۳۰ دقیقه منقضی می‌شود.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { env } from '../../config/env';
import { db } from '../../db';
import { ads, arbitrationCases, gatewayPayments, profiles, users } from '../../db/schema';

type User = typeof users.$inferSelect;
import { cfg, flag } from '../../lib/appConfig';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { gateway, gatewayOnline } from '../../lib/gateway';
import { logger } from '../../lib/logger';
import { faMoney } from '../../lib/text';
import { notify } from '../notifications/notify';
import { afterArbPaid } from '../arbitration/arbitration.service';

export const BOOST_PLANS = { urgent: { n: 'فوری', hours: 24 }, ladder: { n: 'نردبان', hours: 0 }, star: { n: 'ویژه', hours: 7 * 24 } } as const;
export type BoostPlan = keyof typeof BOOST_PLANS;
export const PENDING_MINUTES = 30;

type Pay = typeof gatewayPayments.$inferSelect;
export type StartInput = { purpose: 'arbitration'; targetId: string } | { purpose: 'boost'; targetId: string; plan: BoostPlan };

/** قیمت پلن‌های فعال ارتقا (از پنل قابل تغییر) */
export function boostPlans() {
  const list = (cfg('boost') as { k: string; p: number; on: boolean; d?: string }[] | null) ?? [];
  return (Object.keys(BOOST_PLANS) as BoostPlan[])
    .map((k) => { const c = list.find((x) => x.k === k); return { k, n: BOOST_PLANS[k].n, p: c ? Math.round(c.p) : 0, on: !!c && c.on !== false && c.p >= 1000, d: c?.d ?? '' }; })
    .filter((x) => x.on);
}

async function priceOf(user: User, q: StartInput): Promise<{ amount: number; description: string }> {
  if (q.purpose === 'arbitration') {
    const [row] = await db
      .select({ c: arbitrationCases, payerUser: profiles.userId })
      .from(arbitrationCases)
      .leftJoin(profiles, eq(profiles.id, arbitrationCases.payerProfileId))
      .where(eq(arbitrationCases.id, q.targetId))
      .limit(1);
    if (!row) throw notFound('پرونده پیدا نشد');
    if (row.payerUser !== user.id) throw forbidden('پرداخت این پرونده با طرف دیگر است', 'NOT_PAYER');
    if (row.c.status !== 'awaiting_payment' || row.c.paymentStatus !== 'unpaid') throw conflict('این پرونده منتظر پرداخت نیست', 'NOT_AWAITING_PAYMENT');
    return { amount: row.c.total, description: row.c.round === 2 ? 'هزینهٔ بازبینی داوری بلوک' : 'هزینهٔ داوری حضوری بلوک (امانی)' };
  }
  if (!flag('boost')) throw forbidden('ارتقای آگهی فعلاً غیرفعال است', 'BOOST_OFF');
  const [row] = await db.select({ ad: ads, owner: profiles.userId }).from(ads).innerJoin(profiles, eq(profiles.id, ads.profileId)).where(eq(ads.id, q.targetId)).limit(1);
  if (!row) throw notFound('آگهی پیدا نشد');
  if (row.owner !== user.id) throw forbidden('فقط صاحب آگهی می‌تواند ارتقا بدهد', 'NOT_OWNER');
  if (row.ad.status !== 'active') throw conflict('فقط آگهی فعال ارتقا می‌گیرد', 'AD_NOT_ACTIVE');
  const plan = boostPlans().find((x) => x.k === q.plan);
  if (!plan) throw badRequest('این نوع ارتقا فعال نیست', 'BOOST_PLAN');
  return { amount: plan.p, description: `ارتقای آگهی (${plan.n}): ${row.ad.title}`.slice(0, 200) };
}

/** شروع پرداخت: ردیف pending + درخواست از درگاه ← آدرس صفحهٔ پرداخت بانک */
export async function startPayment(user: User, q: StartInput, apiBase: string) {
  if (!gatewayOnline()) throw forbidden('پرداخت آنلاین به‌زودی فعال می‌شود', 'GATEWAY_OFF');
  const { amount, description } = await priceOf(user, q);
  const [p] = await db
    .insert(gatewayPayments)
    .values({ userId: user.id, purpose: q.purpose, targetId: q.targetId, plan: q.purpose === 'boost' ? q.plan : null, amount, description, gateway: gateway.name })
    .returning();
  try {
    const r = await gateway.request({ amount, description, callbackUrl: `${apiBase}/api/pay/callback`, mobile: user.phone }, apiBase);
    await db.update(gatewayPayments).set({ authority: r.authority, updatedAt: new Date() }).where(eq(gatewayPayments.id, p.id));
    return { id: p.id, url: r.url, amount, gateway: gateway.name };
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'درگاه پاسخ نداد';
    await db.update(gatewayPayments).set({ status: 'failed', failReason: reason, updatedAt: new Date() }).where(eq(gatewayPayments.id, p.id));
    throw badRequest(`درگاه پرداخت در دسترس نیست: ${reason}`, 'GATEWAY_DOWN');
  }
}

/** اثر پرداخت موفق (داخل همان تراکنش تغییر وضعیت) — برمی‌گرداند آیا اثری گذاشت */
async function apply(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], p: Pay, refId: string) {
  if (p.purpose === 'arbitration') {
    const r = await tx
      .update(arbitrationCases)
      .set({ status: 'matching', paymentStatus: 'paid', paymentRef: `زرین‌پال ${refId}`.slice(0, 80), paidAt: new Date(), updatedAt: new Date() })
      .where(and(eq(arbitrationCases.id, p.targetId), eq(arbitrationCases.status, 'awaiting_payment'), eq(arbitrationCases.paymentStatus, 'unpaid')))
      .returning({ id: arbitrationCases.id });
    return r.length > 0;
  }
  const plan = p.plan as BoostPlan;
  const until = (col: typeof ads.featuredUntil) => sql`greatest(coalesce(${col}, now()), now()) + make_interval(hours => ${BOOST_PLANS[plan].hours})`;
  const set =
    plan === 'star' ? { featuredUntil: until(ads.featuredUntil), bumpedAt: new Date() } : plan === 'urgent' ? { urgentUntil: until(ads.urgentUntil), bumpedAt: new Date() } : { bumpedAt: new Date() };
  const r = await tx.update(ads).set(set).where(eq(ads.id, p.targetId)).returning({ id: ads.id });
  return r.length > 0;
}

/** برگشت از درگاه: verify ← اعمال یک‌باره ← شناسهٔ پرداخت برای صفحهٔ نتیجهٔ اپ */
export async function handleCallback(authority: string, status: string): Promise<string | null> {
  const [p] = await db.select().from(gatewayPayments).where(eq(gatewayPayments.authority, authority)).limit(1);
  if (!p) return null;
  if (p.status !== 'pending') return p.id; // رفرش صفحهٔ برگشت یا تلاش دوباره: کاری نکن
  if (status !== 'OK') {
    await db.update(gatewayPayments).set({ status: 'failed', failReason: 'پرداخت لغو شد', updatedAt: new Date() }).where(and(eq(gatewayPayments.id, p.id), eq(gatewayPayments.status, 'pending')));
    return p.id;
  }
  const v = await gateway.verify(authority, p.amount);
  if (!v.ok) {
    await db.update(gatewayPayments).set({ status: 'failed', failReason: v.reason, updatedAt: new Date() }).where(and(eq(gatewayPayments.id, p.id), eq(gatewayPayments.status, 'pending')));
    return p.id;
  }
  let applied = false, won = false;
  await db.transaction(async (tx) => {
    const r = await tx
      .update(gatewayPayments)
      .set({ status: 'paid', refId: v.refId, cardPan: v.cardPan, paidAt: new Date(), updatedAt: new Date() })
      .where(and(eq(gatewayPayments.id, p.id), eq(gatewayPayments.status, 'pending')))
      .returning({ id: gatewayPayments.id });
    if (!r.length) return; // درخواست همزمان دیگری زودتر ثبتش کرد
    won = true;
    applied = await apply(tx, p, v.refId);
    // پول گرفته شد ولی کار قبلاً انجام شده بود (مثلاً مدیر دستی تأیید کرده) ← برای بازگشت وجه علامت بخورد
    if (!applied) await tx.update(gatewayPayments).set({ failReason: 'پرداخت موفق ولی قبلاً انجام شده بود؛ بازگشت وجه لازم است' }).where(eq(gatewayPayments.id, p.id));
  });
  if (won) {
    logger.info({ id: p.id, purpose: p.purpose, amount: p.amount, refId: v.refId, applied }, 'gateway payment paid');
    if (applied && p.purpose === 'arbitration') await afterArbPaid(p.targetId).catch((err) => logger.error({ err }, 'after arbitration payment'));
    if (p.purpose === 'boost') {
      await notify(p.userId, {
        type: 'ad',
        title: applied ? 'آگهی‌ات ارتقا گرفت' : 'پرداخت ثبت شد',
        body: `${faMoney(p.amount)} تومان · کد پیگیری ${v.refId}`,
        link: { screen: 'myads' },
      }).catch(() => {});
    }
  }
  return p.id;
}

const out = (p: Pay) => ({
  id: p.id, purpose: p.purpose, targetId: p.targetId, plan: p.plan, amount: p.amount, description: p.description, gateway: p.gateway,
  status: p.status, refId: p.refId, cardPan: p.cardPan, failReason: p.failReason, createdAt: p.createdAt, paidAt: p.paidAt,
});

export async function getPayment(user: User, id: string) {
  const [p] = await db.select().from(gatewayPayments).where(eq(gatewayPayments.id, id)).limit(1);
  if (!p || p.userId !== user.id) throw notFound('پرداخت پیدا نشد');
  return out(p);
}

export async function myPayments(user: User) {
  const rows = await db.select().from(gatewayPayments).where(eq(gatewayPayments.userId, user.id)).orderBy(desc(gatewayPayments.createdAt)).limit(50);
  return rows.map(out);
}

/** پنل: همهٔ پرداخت‌های درگاه با نام و شمارهٔ پرداخت‌کننده */
export async function adminPayments(limit = 300) {
  const rows = await db
    .select({ p: gatewayPayments, phone: users.phone, name: sql<string>`coalesce(${users.firstName} || ' ' || ${users.lastName}, '')` })
    .from(gatewayPayments)
    .innerJoin(users, eq(users.id, gatewayPayments.userId))
    .orderBy(desc(gatewayPayments.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...out(r.p), userId: r.p.userId, phone: r.phone, name: r.name.trim() }));
}

/** پرداخت‌های نیمه‌کاره بعد از ۳۰ دقیقه منقضی می‌شوند */
export async function expireStale() {
  const r = await db
    .update(gatewayPayments)
    .set({ status: 'expired', failReason: 'پرداخت در زمان مقرر انجام نشد', updatedAt: new Date() })
    .where(and(eq(gatewayPayments.status, 'pending'), lt(gatewayPayments.createdAt, new Date(Date.now() - PENDING_MINUTES * 60_000))))
    .returning({ id: gatewayPayments.id });
  return r.length;
}

export const appReturnUrl = (id: string | null) => `${env.APP_URL}/?pay=${id ?? 'unknown'}`;
