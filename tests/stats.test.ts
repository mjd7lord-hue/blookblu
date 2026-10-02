import { describe, it, expect } from 'vitest';
import { api, auth, registered } from './helpers';

describe('views, real stats and public Q&A answers', () => {
  it('counts profile/ad views by others and reports real stats', async () => {
    const c = await registered('contractor');
    const w = await registered('worker');
    const ad = await api().post('/api/ads').set(auth(c.token)).send({ type: 'job', title: 'نیاز به ۲ بنا برای ویلا', province: 'هرمزگان', city: 'قشم', audience: ['worker'], skills: ['بنایی و دیوارچینی'] });
    const id = ad.body.ad.id;

    // بازدید خود آدم حساب نمی‌شود
    await api().get(`/api/profiles/${c.profile.code}`).set(auth(c.token)).expect(200);
    await api().get(`/api/ads/${id}`).set(auth(c.token)).expect(200);
    // بازدید دیگران
    await api().get(`/api/profiles/${c.profile.code}`).set(auth(w.token)).expect(200);
    await api().get(`/api/profiles/${c.profile.code}`).expect(200);
    await api().get(`/api/ads/${id}`).set(auth(w.token)).expect(200);
    await api().post(`/api/ads/${id}/responses`).set(auth(w.token)).send({ message: 'سلام، از شنبه آزادم' }).expect(201);

    const s = await api().get('/api/me/stats').set(auth(c.token));
    expect(s.status).toBe(200);
    expect(s.body.months).toHaveLength(6);
    expect(s.body.profileViews.total).toBe(2);
    expect(s.body.profileViews.monthly.at(-1)).toBe(2);
    expect(s.body.adViews).toMatchObject({ total: 1, activeAds: 1 });
    expect(s.body.adViews.monthly.at(-1)).toBe(1);
    expect(s.body.responses).toMatchObject({ received: 1, answerRate: 0 });
    expect(s.body.demand.length).toBeGreaterThan(0);

    const ws = await api().get('/api/me/stats').set(auth(w.token));
    expect(ws.body.responses).toMatchObject({ sent: 1, received: 0 });
  });

  it('answers to a consult question are public; other responses stay private', async () => {
    const g = await registered('general');
    const e = await registered('engineer');
    const q = await api().post('/api/ads').set(auth(g.token)).send({ type: 'consult', title: 'علت ترک مورب کنار پنجره چیست؟', province: 'تهران', city: 'تهران', audience: ['engineer'] });
    await api().post(`/api/ads/${q.body.ad.id}/responses`).set(auth(e.token)).send({ message: 'به نظر ترک نشست است؛ بازدید لازم است.' }).expect(201);
    const pub = await api().get(`/api/ads/${q.body.ad.id}/answers`);
    expect(pub.status).toBe(200);
    expect(pub.body.items).toHaveLength(1);
    expect(pub.body.items[0]).toMatchObject({ message: expect.stringContaining('ترک نشست'), author: { code: e.profile.code } });

    const c = await registered('contractor');
    const job = await api().post('/api/ads').set(auth(c.token)).send({ type: 'job', title: 'کارگر ساده', province: 'هرمزگان', city: 'قشم', audience: ['worker'] });
    expect((await api().get(`/api/ads/${job.body.ad.id}/answers`)).body.error.code).toBe('NOT_CONSULT');
  });
});
