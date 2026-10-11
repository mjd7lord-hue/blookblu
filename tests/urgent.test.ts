import { describe, it, expect } from 'vitest';
import { api, auth, registered } from './helpers';

// مهارت یکتا تا آگهی‌های تست‌های دیگر قاطی نشوند
const SK = 'سنگ‌کاری فوری';
const readyAd = (over: Record<string, unknown> = {}) => ({
  type: 'work',
  title: 'سنگ‌کار، آماده به کار',
  description: 'سابقهٔ ۸ سال',
  province: 'هرمزگان',
  city: 'قشم',
  wageType: 'روزانه',
  wageAmount: '۲.۰۰۰.۰۰۰',
  startWhen: 'فوری',
  range: 'city',
  audience: ['contractor', 'general'],
  skills: [SK],
  ...over,
});
const urgent = (over: Record<string, unknown> = {}) => ({
  title: 'سنگ‌کاری نمای ویلا',
  skill: SK,
  roles: ['worker'],
  needCount: 1,
  startWhen: 'فردا ۷ صبح',
  dailyWage: '۲.۵۰۰.۰۰۰',
  days: 3,
  ...over,
});

describe('urgent hire (نیروی فوری)', () => {
  it('broadcasts to ready workers; first to accept wins and gets a project; the rest are told they were late', async () => {
    const boss = await registered('contractor');
    const ws = await Promise.all([1, 2, 3].map(() => registered('worker')));
    const far = await registered('worker');
    const other = await registered('worker');
    for (const w of ws) expect((await api().post('/api/ads').set(auth(w.token)).send(readyAd())).status).toBe(201);
    const farAd = await api().post('/api/ads').set(auth(far.token)).send(readyAd({ province: 'تهران', city: 'تهران' }));
    expect(farAd.status).toBe(201);
    await api().post('/api/ads').set(auth(other.token)).send(readyAd({ skills: ['نقاشی'], title: 'نقاش آماده' })).expect(201);

    // پیش‌نمایش: فقط هم‌استانی‌های همین مهارت
    const pv = await api().get('/api/urgent/preview').query({ skill: SK }).set(auth(boss.token));
    expect(pv.body.count).toBe(3);
    expect(pv.body.sameCity).toBe(3);

    // کارگر نمی‌تواند درخواست فوری بدهد
    expect((await api().post('/api/urgent').set(auth(ws[0].token)).send(urgent())).body.error.code).toBe('NOT_CLIENT');
    // مهارتی که کسی آماده‌اش نیست
    expect((await api().post('/api/urgent').set(auth(boss.token)).send(urgent({ skill: 'مهارتی که نیست' }))).body.error.code).toBe('NO_READY');

    const c = await api().post('/api/urgent').set(auth(boss.token)).send(urgent());
    expect(c.status).toBe(201);
    expect(c.body.sentCount).toBe(3);
    expect(c.body.request.total).toBe(7500000);
    const rid = c.body.request.id;

    // هر سه پیشنهاد و اعلان گرفتند؛ تهرانی و نقاش نه
    const in0 = await api().get('/api/urgent/inbox').set(auth(ws[0].token));
    expect(in0.body.items).toHaveLength(1);
    expect(in0.body.items[0]).toMatchObject({ id: rid, dailyWage: 2500000, days: 3, total: 7500000 });
    expect(in0.body.items[0].client.code).toBe(boss.profile.code);
    expect((await api().get('/api/urgent/inbox').set(auth(far.token))).body.items).toHaveLength(0);
    expect((await api().get('/api/urgent/inbox').set(auth(other.token))).body.items).toHaveLength(0);
    const n0 = await api().get('/api/notifications').set(auth(ws[0].token));
    expect(n0.body.items[0].title).toContain('کار فوری');

    // نفر دوم رد می‌کند، نفر اول قبول ← پروژه
    await api().post(`/api/urgent/${rid}/decline`).set(auth(ws[1].token)).expect(200);
    const a1 = await api().post(`/api/urgent/${rid}/accept`).set(auth(ws[0].token));
    expect(a1.status).toBe(200);
    expect(a1.body.filled).toBe(true);
    const pr = await api().get(`/api/projects/${a1.body.projectId}`).set(auth(boss.token));
    expect(pr.body.project).toMatchObject({ amount: 7500000, durationDays: 3, myRole: 'client' });
    expect(pr.body.project.progress).toHaveLength(3);
    // آگهی آمادگی برنده خاموش شد
    const mineAds = await api().get('/api/ads/mine').set(auth(ws[0].token));
    expect(mineAds.body.items[0].status).toBe('closed');

    // نفر سوم دیر رسید
    const late = await api().post(`/api/urgent/${rid}/accept`).set(auth(ws[2].token));
    expect(late.body.error.code).toBe('URGENT_CLOSED');
    expect(late.body.error.message).toContain('دیر رسیدی');
    expect((await api().get('/api/urgent/inbox').set(auth(ws[2].token))).body.items).toHaveLength(0);
    expect((await api().post(`/api/urgent/${rid}/accept`).set(auth(ws[0].token))).body.error.code).toBe('ALREADY_ANSWERED');

    // صفحهٔ پیگیری کارفرما
    const mine = await api().get('/api/urgent/mine').set(auth(boss.token));
    expect(mine.body.items[0]).toMatchObject({ id: rid, status: 'filled', counts: { sent: 3, accepted: 1, declined: 1, waiting: 0 } });
    expect(mine.body.items[0].accepted[0].person.code).toBe(ws[0].profile.code);
    expect(mine.body.items[0].accepted[0].projectId).toBe(a1.body.projectId);
    const bn = await api().get('/api/notifications').set(auth(boss.token));
    expect(bn.body.items.some((n: { title: string }) => n.title.includes('کار فوری را قبول کرد'))).toBe(true);
  });

  it('two people, cancel, open-request limit and expiry', async () => {
    const boss = await registered('general');
    const ws = await Promise.all([1, 2, 3].map(() => registered('worker')));
    for (const w of ws) await api().post('/api/ads').set(auth(w.token)).send(readyAd({ skills: ['کاشی فوری'] })).expect(201);
    const two = await api().post('/api/urgent').set(auth(boss.token)).send(urgent({ skill: 'کاشی فوری', needCount: 2, province: 'هرمزگان', city: 'قشم' }));
    expect(two.status).toBe(201);
    const rid = two.body.request.id;
    const a = await api().post(`/api/urgent/${rid}/accept`).set(auth(ws[0].token));
    expect(a.body.filled).toBe(false);
    const b = await api().post(`/api/urgent/${rid}/accept`).set(auth(ws[1].token));
    expect(b.body.filled).toBe(true);
    expect((await api().post(`/api/urgent/${rid}/accept`).set(auth(ws[2].token))).body.error.code).toBe('URGENT_CLOSED');

    // لغو: پیشنهادهای باز بسته می‌شوند (نفر سوم هنوز آماده است)
    const c = await api().post('/api/urgent').set(auth(boss.token)).send(urgent({ skill: 'کاشی فوری', province: 'هرمزگان', city: 'قشم' }));
    expect(c.body.sentCount).toBe(1);
    await api().post(`/api/urgent/${c.body.request.id}/cancel`).set(auth(boss.token)).expect(200);
    expect((await api().get('/api/urgent/inbox').set(auth(ws[2].token))).body.items).toHaveLength(0);
    expect((await api().post(`/api/urgent/${c.body.request.id}/accept`).set(auth(ws[2].token))).body.error.code).toBe('URGENT_CLOSED');

    // حداکثر ۳ درخواست باز
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await api().post('/api/urgent').set(auth(boss.token)).send(urgent({ skill: 'کاشی فوری', province: 'هرمزگان', city: 'قشم' }))).body.request.id);
    expect((await api().post('/api/urgent').set(auth(boss.token)).send(urgent({ skill: 'کاشی فوری', province: 'هرمزگان', city: 'قشم' }))).body.error.code).toBe('URGENT_LIMIT');

    // انقضا: بعد از زمانش برای کارگر دیده نمی‌شود و در «من» expired است
    const { db } = await import('../src/db');
    const { urgentRequests } = await import('../src/db/schema');
    const { inArray } = await import('drizzle-orm');
    await db.update(urgentRequests).set({ expiresAt: new Date(Date.now() - 60000) }).where(inArray(urgentRequests.id, ids));
    expect((await api().get('/api/urgent/inbox').set(auth(ws[2].token))).body.items).toHaveLength(0);
    const mine = await api().get('/api/urgent/mine').set(auth(boss.token));
    expect(mine.body.items.filter((x: { status: string }) => x.status === 'expired')).toHaveLength(3);
    // حالا دوباره می‌تواند درخواست بدهد
    expect((await api().post('/api/urgent').set(auth(boss.token)).send(urgent({ skill: 'کاشی فوری', province: 'هرمزگان', city: 'قشم' }))).status).toBe(201);
  });
});
