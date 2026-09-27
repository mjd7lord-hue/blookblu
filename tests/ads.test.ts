import { describe, it, expect } from 'vitest';
import { api, auth, registered } from './helpers';

const jobAd = {
  type: 'job',
  title: '۳ کارگر برای بلوک‌چینی طبقهٔ دوم',
  description: 'کار حدود ۱۰ روز',
  province: 'هرمزگان',
  city: 'درگهان',
  wageType: 'روزانه',
  wageAmount: '۱٬۸۰۰٬۰۰۰',
  startWhen: 'فوری',
  range: 'city',
  audience: ['worker'],
  needCount: 3,
  skills: ['بلوک‌چینی'],
};

describe('ads, explore, responses, reviews', () => {
  it('full flow', async () => {
    const boss = await registered('contractor');
    const worker = await registered('worker');
    const eng = await registered('engineer');

    // مخاطب نامعتبر برای نوع آگهی
    const bad = await api().post('/api/ads').set(auth(boss.token)).send({ ...jobAd, type: 'work' });
    expect(bad.body.error.code).toBe('BAD_AUDIENCE');

    const c = await api().post('/api/ads').set(auth(boss.token)).send(jobAd);
    expect(c.status).toBe(201);
    const adId = c.body.ad.id;
    expect(c.body.ad.wageAmount).toBe(1800000);

    // کاوش برای مهمان
    const ex = await api().get('/api/ads').query({ mode: 'jobs', q: 'بلوک' });
    expect(ex.body.items.some((a: { id: string }) => a.id === adId)).toBe(true);
    const ex2 = await api().get('/api/ads').query({ mode: 'jobs', skills: 'بلوک‌چینی', province: 'هرمزگان' });
    expect(ex2.body.items[0].author).toHaveProperty('trust');

    // «برای من» با نقش مهندس نباید این آگهی را نشان دهد
    const forEng = await api().get('/api/ads').set(auth(eng.token)).query({ mode: 'jobs', forMe: 'true' });
    expect(forEng.body.items.some((a: { id: string }) => a.id === adId)).toBe(false);

    // مهندس مخاطب این آگهی نیست
    const nope = await api().post(`/api/ads/${adId}/responses`).set(auth(eng.token)).send({ message: 'سلام' });
    expect(nope.body.error.code).toBe('NOT_AUDIENCE');
    // صاحب آگهی نمی‌تواند پاسخ بدهد
    const own = await api().post(`/api/ads/${adId}/responses`).set(auth(boss.token)).send({ message: 'سلام' });
    expect(own.status).toBe(400);

    const resp = await api()
      .post(`/api/ads/${adId}/responses`)
      .set(auth(worker.token))
      .send({ message: 'از فردا می‌آیم', offer: '۱٬۸۰۰٬۰۰۰' });
    expect(resp.status).toBe(201);
    const dup = await api().post(`/api/ads/${adId}/responses`).set(auth(worker.token)).send({ message: 'دوباره' });
    expect(dup.status).toBe(409);

    // اعلان برای صاحب آگهی
    const n = await api().get('/api/notifications').set(auth(boss.token));
    expect(n.body.unread).toBe(1);
    expect(n.body.items[0].type).toBe('req');

    const inbox = await api().get('/api/responses').query({ dir: 'in' }).set(auth(boss.token));
    expect(inbox.body.items).toHaveLength(1);
    const out = await api().get('/api/responses').query({ dir: 'out' }).set(auth(worker.token));
    expect(out.body.items[0].ad.id).toBe(adId);

    // قبل از پذیرش، نظر ممنوع
    const early = await api().post('/api/reviews').set(auth(boss.token)).send({ responseId: resp.body.response.id, rating: 5 });
    expect(early.body.error.code).toBe('NOT_ACCEPTED');

    const acc = await api().patch(`/api/responses/${resp.body.response.id}`).set(auth(boss.token)).send({ status: 'accepted' });
    expect(acc.body.response.status).toBe('accepted');
    // کارگر نمی‌تواند درخواست خودش را بپذیرد
    const hack = await api().patch(`/api/responses/${resp.body.response.id}`).set(auth(worker.token)).send({ status: 'accepted' });
    expect(hack.status).toBe(403);

    const rv = await api()
      .post('/api/reviews')
      .set(auth(boss.token))
      .send({ responseId: resp.body.response.id, rating: 5, text: 'دقیق و منظم' });
    expect(rv.status).toBe(201);
    const rv2 = await api().post('/api/reviews').set(auth(boss.token)).send({ responseId: resp.body.response.id, rating: 1 });
    expect(rv2.status).toBe(409);
    // غریبه نمی‌تواند نظر بدهد
    const rv3 = await api().post('/api/reviews').set(auth(eng.token)).send({ responseId: resp.body.response.id, rating: 1 });
    expect(rv3.status).toBe(403);

    const wp = await api().get(`/api/profiles/${worker.profile.code}`);
    expect(wp.body.profile.rating).toBe(5);
    expect(wp.body.profile.trust).toMatchObject({ satisfaction: 55, projects: 1, reviews: 1, total: 57 });
    expect(wp.body.profile.stars).toEqual([1, 0, 0, 0, 0]);
    expect(wp.body.profile.reviews[0].text).toBe('دقیق و منظم');

    // مدیریت آگهی
    const paused = await api().patch(`/api/ads/${adId}`).set(auth(boss.token)).send({ status: 'paused' });
    expect(paused.body.ad.status).toBe('paused');
    expect((await api().get(`/api/ads/${adId}`)).status).toBe(404);
    expect((await api().get(`/api/ads/${adId}`).set(auth(boss.token))).status).toBe(200);
    const mine = await api().get('/api/ads/mine').set(auth(boss.token));
    expect(mine.body.items).toHaveLength(1);
    await api().delete(`/api/ads/${adId}`).set(auth(boss.token));
    expect((await api().get('/api/ads/mine').set(auth(boss.token))).body.items).toHaveLength(0);
  });

  it('consult ads drop wage fields', async () => {
    const g = await registered('general');
    const r = await api()
      .post('/api/ads')
      .set(auth(g.token))
      .send({ ...jobAd, type: 'consult', title: 'علت ترک مورب کنار پنجره چیست؟', audience: ['engineer'], wageAmount: 5 });
    expect(r.status).toBe(201);
    expect(r.body.ad.wageAmount).toBeNull();
    expect(r.body.ad.needCount).toBeNull();
  });

  it('views count for others, not owner', async () => {
    const g = await registered('general');
    const c = await api().post('/api/ads').set(auth(g.token)).send({ ...jobAd, audience: ['contractor'] });
    await api().get(`/api/ads/${c.body.ad.id}`);
    await api().get(`/api/ads/${c.body.ad.id}`).set(auth(g.token));
    const d = await api().get(`/api/ads/${c.body.ad.id}`).set(auth(g.token));
    expect(d.body.ad.views).toBe(1);
    expect(d.body.isOwn).toBe(true);
  });
});
