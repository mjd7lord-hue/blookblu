import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { users } from '../src/db/schema';
import { api, auth, registered } from './helpers';

describe('real admin dashboard: online, visits, events, funnel; helpful answers', () => {
  it('ping counts visitors and online users; live endpoint returns real events', async () => {
    const o = await registered('general');
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, o.profile.userId));
    const v1 = 'guest' + Date.now(), v2 = 'member' + Date.now();
    await api().post('/api/app/ping').send({ v: v1, view: true }).expect(200);
    await api().post('/api/app/ping').send({ v: v1, view: true }).expect(200);
    await api().post('/api/app/ping').set(auth(o.token)).send({ v: v2, view: true }).expect(200);
    expect((await api().post('/api/app/ping').send({ v: 'x' })).status).toBe(400);
    const live = await api().get('/api/admin/panel/live').set(auth(o.token));
    expect(live.status).toBe(200);
    expect(live.body.online.now).toBeGreaterThanOrEqual(2);
    expect(live.body.online.members).toBeGreaterThanOrEqual(1);
    expect(live.body.visits.today.views).toBeGreaterThanOrEqual(3);
    expect(live.body.visits.today.visitors).toBeGreaterThanOrEqual(2);
    expect(live.body.visits.daily).toHaveLength(30);
    // ثبت‌نام همین مدیر یک رویداد واقعی است
    expect(live.body.events.some((e: { k: string; t: string }) => e.k === 'user' && e.t.includes(o.profile.displayName || 'سارا نوری'))).toBe(true);
    const snap = await api().get('/api/admin/panel/snapshot').set(auth(o.token));
    expect(snap.body.stats.funnel).toHaveProperty('views');
    expect(snap.body.stats.visits.total.visitors).toBeGreaterThanOrEqual(2);
  });

  it('signups by Tehran day: complete vs half-done, without sample accounts', async () => {
    const o = await registered('general');
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, o.profile.userId));
    const p0 = (await api().get('/api/admin/panel/live').set(auth(o.token))).body.people;
    // فقط کد پیامکی (بدون نقش) = نیمه‌کاره
    const half = await db.insert(users).values({ phone: '09127770002' }).returning();
    await db.insert(users).values({ phone: '09000001234' }); // حساب نمونه شمرده نمی‌شود
    const p = (await api().get('/api/admin/panel/live').set(auth(o.token))).body.people;
    expect(p.today).toBe(p0.today + 1);
    expect(p.todayDone).toBe(p0.todayDone);
    expect(p.total - p.totalDone).toBe(p0.total - p0.totalDone + 1);
    expect(p.daily).toHaveLength(30);
    expect(p.daily[29].n).toBe(p.today);
    expect(p.week).toBeGreaterThanOrEqual(p.today);
    const snap = await api().get('/api/admin/panel/snapshot').set(auth(o.token));
    expect(snap.body.stats.people.today).toBe(p.today);
    expect(half[0].id).toBeTruthy();
  });

  it('first like on an expert answer raises trust by 1 (max 5) and notifies', async () => {
    const g = await registered('general');
    const e = await registered('engineer');
    const before = (await api().get(`/api/profiles/${e.profile.code}`)).body.profile.trust;
    const q = await api().post('/api/ads').set(auth(g.token)).send({ type: 'consult', title: 'ترک مویی روی تیر بتنی خطرناک است؟', province: 'تهران', city: 'تهران', audience: ['engineer'] });
    await api().post(`/api/ads/${q.body.ad.id}/responses`).set(auth(e.token)).send({ message: 'ترک مویی معمولاً از جمع‌شدگی است؛ عرضش را بسنج.' }).expect(201);
    const ans = (await api().get(`/api/ads/${q.body.ad.id}/answers`)).body.items[0];
    await api().post(`/api/responses/${ans.id}/vote`).set(auth(g.token)).send({ value: 1 }).expect(200);
    const after = (await api().get(`/api/profiles/${e.profile.code}`)).body.profile.trust;
    expect(after.adj).toBe(before.adj + 1);
    const n = await api().get('/api/notifications').set(auth(e.token));
    expect(n.body.items.some((x: { title: string }) => x.title.includes('مفید'))).toBe(true);
    // برداشتن لایک ← امتیاز برمی‌گردد
    await api().post(`/api/responses/${ans.id}/vote`).set(auth(g.token)).send({ value: 0 }).expect(200);
    expect((await api().get(`/api/profiles/${e.profile.code}`)).body.profile.trust.adj).toBe(before.adj);
  });
});
