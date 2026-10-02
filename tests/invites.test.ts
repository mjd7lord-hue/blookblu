import { describe, it, expect } from 'vitest';
import { api, auth, registered } from './helpers';

const job = (title: string) => ({ type: 'job', title, province: 'هرمزگان', city: 'قشم', audience: ['worker'] });

describe('invites, answer votes, code search, free ad limit', () => {
  it('free users get one active work/job ad; questions are not limited', async () => {
    const c = await registered('contractor');
    const a1 = await api().post('/api/ads').set(auth(c.token)).send(job('نیاز به ۲ بنا برای ویلا')).expect(201);
    const a2 = await api().post('/api/ads').set(auth(c.token)).send(job('کارگر ساده برای خاک‌برداری'));
    expect(a2.status).toBe(409);
    expect(a2.body.error.code).toBe('FREE_AD_LIMIT');
    expect(a2.body.error.message).toContain('یک آگهی فعال داری');
    await api().post('/api/ads').set(auth(c.token)).send({ type: 'consult', title: 'فاصلهٔ خاموت ستون چقدر باشد؟', province: 'هرمزگان', city: 'قشم', audience: ['engineer'] }).expect(201);
    // بستن آگهی قبلی = جا برای آگهی تازه
    await api().patch(`/api/ads/${a1.body.ad.id}`).set(auth(c.token)).send({ status: 'closed' }).expect(200);
    await api().post('/api/ads').set(auth(c.token)).send(job('کارگر ساده برای خاک‌برداری')).expect(201);
    const cfg = await api().get('/api/app/config');
    expect(cfg.body.limits).toEqual({ freeAds: 1 });
  });

  it('cooperation invite: send (single + bulk), list in/out, accept, withdraw, duplicate', async () => {
    const g = await registered('general');
    const w1 = await registered('worker');
    const w2 = await registered('worker');
    const one = await api().post('/api/invites').set(auth(g.token)).send({ profileCode: w1.profile.code.toLowerCase(), title: 'بلوک‌چینی طبقهٔ دوم', startWhen: 'شنبه ۱۱ مهر', offer: '۲٬۰۰۰٬۰۰۰ تومان روزانه' });
    expect(one.status).toBe(201);
    expect(one.body.items).toHaveLength(1);
    const dup = await api().post('/api/invites').set(auth(g.token)).send({ profileCode: w1.profile.code, title: 'بلوک‌چینی طبقهٔ دوم' });
    expect(dup.body.error.code).toBe('INVITE_DUPLICATE');
    const self = await api().post('/api/invites').set(auth(g.token)).send({ profileCode: g.profile.code, title: 'کار خودم' });
    expect(self.body.error.code).toBe('SELF_INVITE');

    const bulk = await api().post('/api/invites').set(auth(g.token)).send({ profileCodes: [w1.profile.code, w2.profile.code, 'B-ZZZZ'], title: 'ساخت ساختمان ۲ طبقه، قشم' });
    expect(bulk.status).toBe(201);
    expect(bulk.body.items).toHaveLength(2);
    expect(bulk.body.skipped).toEqual([{ code: 'B-ZZZZ', reason: 'NOT_FOUND' }]);

    const inbox = await api().get('/api/invites?dir=in').set(auth(w1.token));
    expect(inbox.body.items).toHaveLength(2);
    expect(inbox.body.items[0].from.code).toBe(g.profile.code);
    // گفت‌وگو با پیام درخواست باز شده
    const msgs = await api().get(`/api/conversations/${one.body.items[0].conversationId}/messages`).set(auth(w1.token));
    expect(msgs.body.items.some((m: { body: string }) => /درخواست همکاری: بلوک‌چینی/.test(m.body || ''))).toBe(true);

    const id = one.body.items[0].id;
    // فقط گیرنده جواب می‌دهد
    expect((await api().patch(`/api/invites/${id}`).set(auth(w2.token)).send({ status: 'accepted' })).status).toBe(404);
    await api().patch(`/api/invites/${id}`).set(auth(w1.token)).send({ status: 'accepted' }).expect(200);
    expect((await api().patch(`/api/invites/${id}`).set(auth(w1.token)).send({ status: 'rejected' })).body.error.code).toBe('INVITE_CLOSED');

    const out = await api().get('/api/invites?dir=out').set(auth(g.token));
    expect(out.body.items).toHaveLength(3);
    expect(out.body.items.find((x: { id: string }) => x.id === id)).toMatchObject({ status: 'accepted', to: { code: w1.profile.code } });
    const w2inv = bulk.body.items.find((x: { code: string }) => x.code === w2.profile.code).id;
    await api().post(`/api/invites/${w2inv}/withdraw`).set(auth(g.token)).expect(200);
    expect((await api().get('/api/invites?dir=in').set(auth(w2.token))).body.items).toHaveLength(0);
  });

  it('everyone can answer a question; answers are voted and sorted by score', async () => {
    const g = await registered('general');
    const e = await registered('engineer');
    const w = await registered('worker'); // نقش خارج از مخاطب پرسش
    const c = await registered('contractor');
    const q = await api().post('/api/ads').set(auth(g.token)).send({ type: 'consult', title: 'نم پای دیوار زیرزمین از کجاست؟', province: 'هرمزگان', city: 'قشم', audience: ['engineer'] });
    const qid = q.body.ad.id;
    await api().post(`/api/ads/${qid}/responses`).set(auth(e.token)).send({ message: 'احتمالاً عایق رطوبتی پی خراب است.' }).expect(201);
    await api().post(`/api/ads/${qid}/responses`).set(auth(w.token)).send({ message: 'لولهٔ آب را هم چک کنید.' }).expect(201);
    let pub = await api().get(`/api/ads/${qid}/answers`);
    const [first, second] = pub.body.items;
    expect(first.score).toBe(0);
    // رأی به پاسخ دوم ← بالا می‌رود
    await api().post(`/api/responses/${second.id}/vote`).set(auth(g.token)).send({ value: 1 }).expect(200);
    const v = await api().post(`/api/responses/${second.id}/vote`).set(auth(c.token)).send({ value: 1 });
    expect(v.body).toMatchObject({ up: 2, down: 0, score: 2, myVote: 1 });
    await api().post(`/api/responses/${first.id}/vote`).set(auth(c.token)).send({ value: -1 }).expect(200);
    expect((await api().post(`/api/responses/${second.id}/vote`).set(auth(w.token)).send({ value: 1 })).body.error.code).toBe('OWN_ANSWER');
    pub = await api().get(`/api/ads/${qid}/answers`).set(auth(c.token));
    expect(pub.body.items.map((x: { id: string }) => x.id)).toEqual([second.id, first.id]);
    expect(pub.body.items[0]).toMatchObject({ up: 2, down: 0, myVote: 1 });
    expect(pub.body.items[1]).toMatchObject({ up: 0, down: 1, score: -1, myVote: -1 });
    // برداشتن رأی
    expect((await api().post(`/api/responses/${first.id}/vote`).set(auth(c.token)).send({ value: 0 })).body.score).toBe(0);
  });

  it('people search by partial name or user code (case/dash-insensitive)', async () => {
    const w = await registered('worker');
    const code = w.profile.code as string; // B-XXXX
    for (const q of [code, code.toLowerCase(), code.replace('-', ''), code.slice(2)]) {
      const r = await api().get('/api/profiles').query({ q });
      expect(r.body.items.map((x: { code: string }) => x.code)).toContain(code);
    }
    const part = (w.profile.displayName as string).slice(0, 3);
    const byName = await api().get('/api/profiles').query({ q: part });
    expect(byName.body.items.map((x: { code: string }) => x.code)).toContain(code);
  });
});
