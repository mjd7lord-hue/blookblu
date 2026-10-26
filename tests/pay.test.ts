import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { ads, arbitrationCases, disputes, gatewayPayments } from '../src/db/schema';
import { expireStale } from '../src/modules/pay/pay.service';
import { api, auth, makeProject, registered } from './helpers';

/** صفحهٔ پرداخت آزمایشی را مثل کاربر طی می‌کند: «پرداخت» ← برگشت ← آدرس اپ */
async function payOnFakePage(url: string) {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  expect((await api().get(path)).status).toBe(200);
  const post = await api().post(path);
  expect(post.status).toBe(303);
  const back = await api().get('/api/pay/' + post.headers.location.replace(/^\.\.\//, ''));
  expect(back.status).toBe(303);
  return back.headers.location as string;
}

describe('payment gateway (round 53): ad boost and arbitration fee', () => {
  it('boost: price from server, owner only, forged callback rejected, applied once, featured first', async () => {
    const w = await registered('worker');
    const other = await registered('worker');
    const ad = await api().post('/api/ads').set(auth(w.token)).send({ type: 'work', title: 'کاشی‌کار با ۱۰ سال سابقه، آماده از شنبه', province: 'فارس', city: 'شیراز', audience: ['general'] });
    expect(ad.status).toBe(201);
    const adId = ad.body.ad.id;

    const plans = (await api().get('/api/pay/plans')).body.plans;
    expect(plans.map((p: { k: string }) => p.k)).toEqual(['urgent', 'ladder', 'star']);
    const star = plans.find((p: { k: string }) => p.k === 'star');

    expect((await api().post('/api/pay').send({ purpose: 'boost', targetId: adId, plan: 'star' })).status).toBe(401);
    expect((await api().post('/api/pay').set(auth(other.token)).send({ purpose: 'boost', targetId: adId, plan: 'star' })).body.error.code).toBe('NOT_OWNER');
    expect((await api().post('/api/pay').set(auth(w.token)).send({ purpose: 'boost', targetId: adId, plan: 'gold' })).status).toBe(400);

    // اپ مبلغ نمی‌فرستد؛ اگر بفرستد نادیده گرفته می‌شود
    const s1 = await api().post('/api/pay').set(auth(w.token)).send({ purpose: 'boost', targetId: adId, plan: 'star', amount: 1000 });
    expect(s1.status).toBe(201);
    expect(s1.body).toMatchObject({ amount: star.p, gateway: 'fake' });
    expect(s1.body.url).toMatch(/\/api\/pay\/fake\/FAKE[0-9a-f]+$/);
    const auth1 = s1.body.url.split('/').pop();

    // جعل برگشت: Status=OK بدون پرداخت واقعی ← verify رد می‌کند
    const forged = await api().get(`/api/pay/callback?Authority=${auth1}&Status=OK`);
    expect(forged.status).toBe(303);
    expect(forged.headers.location).toContain('?pay=' + s1.body.id);
    const p1 = (await api().get('/api/pay/' + s1.body.id).set(auth(w.token))).body.payment;
    expect(p1).toMatchObject({ status: 'failed', refId: null });
    expect((await db.select().from(ads).where(eq(ads.id, adId)))[0].featuredUntil).toBeNull();
    // پرداخت دیگران دیده نمی‌شود
    expect((await api().get('/api/pay/' + s1.body.id).set(auth(other.token))).status).toBe(404);

    // پرداخت درست
    const s2 = await api().post('/api/pay').set(auth(w.token)).send({ purpose: 'boost', targetId: adId, plan: 'star' });
    const loc = await payOnFakePage(s2.body.url);
    expect(loc).toMatch(new RegExp('^https://blooko\\.ir/\\?pay=' + s2.body.id + '$'));
    const p2 = (await api().get('/api/pay/' + s2.body.id).set(auth(w.token))).body.payment;
    expect(p2).toMatchObject({ status: 'paid', amount: star.p, purpose: 'boost', plan: 'star' });
    expect(p2.refId).toMatch(/^TEST-/);
    const [a1] = await db.select().from(ads).where(eq(ads.id, adId));
    const days = (+a1.featuredUntil! - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    // تکرار برگشت (رفرش) ← دوباره اعمال نمی‌شود
    const auth2 = s2.body.url.split('/').pop();
    await api().get(`/api/pay/callback?Authority=${auth2}&Status=OK`).expect(303);
    expect(+(await db.select().from(ads).where(eq(ads.id, adId)))[0].featuredUntil!).toBe(+a1.featuredUntil!);

    // در کاوش اول است
    const ex = await api().get('/api/ads?type=work&sort=new&limit=5');
    expect(ex.body.items[0].id).toBe(adId);

    // انصراف
    const s3 = await api().post('/api/pay').set(auth(w.token)).send({ purpose: 'boost', targetId: adId, plan: 'urgent' });
    await api().get(`/api/pay/callback?Authority=${s3.body.url.split('/').pop()}&Status=NOK`).expect(303);
    expect((await api().get('/api/pay/' + s3.body.id).set(auth(w.token))).body.payment).toMatchObject({ status: 'failed', failReason: 'پرداخت لغو شد' });

    // نیمه‌کاره بعد از ۳۰ دقیقه منقضی
    const s4 = await api().post('/api/pay').set(auth(w.token)).send({ purpose: 'boost', targetId: adId, plan: 'ladder' });
    await db.update(gatewayPayments).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(gatewayPayments.id, s4.body.id));
    expect(await expireStale()).toBeGreaterThanOrEqual(1);
    expect((await api().get('/api/pay/' + s4.body.id).set(auth(w.token))).body.payment.status).toBe('expired');

    const mine = (await api().get('/api/pay/mine').set(auth(w.token))).body.items;
    expect(mine).toHaveLength(4);
    // آدرس برگشت نامعتبر
    expect((await api().get('/api/pay/callback?Authority=<x>&Status=OK')).headers.location).toContain('?pay=unknown');
  });

  it('arbitration fee: only the payer, then the case moves to matching automatically', async () => {
    const { boss, w, pid } = await makeProject();
    const op = await api().post(`/api/projects/${pid}/disputes`).set(auth(boss.token)).send({ reason: 'کیفیت کار', ask: 'اصلاح کار', description: 'کاشی‌کاری حمام شیب ندارد و آب می‌ماند.' });
    const did = op.body.dispute.id;
    await db.update(disputes).set({ talkUntil: new Date(Date.now() - 1000) }).where(eq(disputes.id, did));
    const rq = await api().post(`/api/disputes/${did}/arbitration`).set(auth(boss.token)).send({ field: 'fin', amountMillion: '40', multi: false, agree: true });
    expect(rq.status).toBe(201);
    const caseId = rq.body.dispute.case.id;

    expect((await api().post('/api/pay').set(auth(w.token)).send({ purpose: 'arbitration', targetId: caseId })).body.error.code).toBe('NOT_PAYER');
    const s = await api().post('/api/pay').set(auth(boss.token)).send({ purpose: 'arbitration', targetId: caseId });
    expect(s.status).toBe(201);
    expect(s.body.amount).toBe(rq.body.payment.amount);
    await payOnFakePage(s.body.url);

    const [c] = await db.select().from(arbitrationCases).where(eq(arbitrationCases.id, caseId));
    expect(c.paymentStatus).toBe('paid');
    expect(['matching', 'offered']).toContain(c.status);
    expect(c.paymentRef).toMatch(/^زرین‌پال TEST-/);
    // پرونده دیگر منتظر پرداخت نیست
    expect((await api().post('/api/pay').set(auth(boss.token)).send({ purpose: 'arbitration', targetId: caseId })).body.error.code).toBe('NOT_AWAITING_PAYMENT');
  });
});
