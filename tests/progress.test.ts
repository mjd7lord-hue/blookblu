import { describe, it, expect } from 'vitest';
import { api, auth, makeProject, registered } from './helpers';

const deal = (over: Record<string, unknown> = {}) => ({
  job: 'سیم‌کشی ساختمان ۴ واحدی',
  qty: '۴ واحد',
  price: '۸۵۰.۲۰۰.۰۰۰ تومان کل کار',
  amount: '۸۵۰.۲۰۰.۰۰۰',
  start: 'شنبه ۱۹ مهر',
  durationDays: 30,
  plan: [{ title: 'پایان کار', pct: 100 }],
  ...over,
});

describe('home project cards: progress, money, ad closing', () => {
  it('progress checklist from the deal; only the provider ticks; money summary on the list', async () => {
    const boss = await registered('general');
    const sp = await registered('specialist');
    const c = await api().post('/api/conversations').set(auth(boss.token)).send({ profileCode: sp.profile.code });
    const cid = c.body.conversation.id;
    const d = await api()
      .post(`/api/conversations/${cid}/deals`)
      .set(auth(sp.token))
      .send(deal({ steps: ['واحد ۱', 'واحد ۲', 'واحد ۳', 'واحد ۴'] }));
    expect(d.status).toBe(201);
    const acc = await api().post(`/api/messages/${d.body.message.id}/answer`).set(auth(boss.token)).send({ status: 'accepted' });
    const pid = acc.body.project.id;
    // مبلغ با جداکنندهٔ نقطه درست خوانده می‌شود
    expect(acc.body.project.amount).toBe(850200000);
    expect(acc.body.project.progress).toEqual([0, 1, 2, 3].map((i) => ({ t: `واحد ${'۱۲۳۴'[i]}`, done: false })));

    // کارفرما نمی‌تواند تیک بزند
    const no = await api().put(`/api/projects/${pid}/progress`).set(auth(boss.token)).send({ items: [{ t: 'واحد ۱', done: true }] });
    expect(no.body.error.code).toBe('PROVIDER_ONLY');

    const items = ['واحد ۱', 'واحد ۲', 'واحد ۳', 'واحد ۴'].map((t, i) => ({ t, done: i < 2 }));
    const ok = await api().put(`/api/projects/${pid}/progress`).set(auth(sp.token)).send({ items });
    expect(ok.status).toBe(200);
    expect(ok.body.project.progress.filter((x: { done: boolean }) => x.done)).toHaveLength(2);
    expect(ok.body.project.progress[0].at).toBeTruthy();
    expect(ok.body.project.can.progress).toBe(true);

    // پیام سیستمی در چت و اعلان برای کارفرما
    const msgs = await api().get(`/api/conversations/${cid}/messages`).set(auth(boss.token));
    const sys = msgs.body.items.filter((m: { kind: string }) => m.kind === 'sys').map((m: { body: string }) => m.body);
    expect(sys.some((t: string) => t.includes('واحد ۱، واحد ۲') && t.includes('۲ از ۴'))).toBe(true);
    const nt = await api().get('/api/notifications').set(auth(boss.token));
    expect(nt.body.items.some((n: { title: string }) => n.title === 'پیشرفت تازه در پروژه')).toBe(true);

    // پرداخت: ثبت ← در انتظار تأیید؛ تأیید ← دریافت‌شده
    const p1 = await api().post(`/api/projects/${pid}/payments`).set(auth(boss.token)).send({ amount: '۲۰۰.۰۰۰.۰۰۰', label: 'پیش‌پرداخت', milestoneIndex: 0 });
    expect(p1.body.payment.amount).toBe(200000000);
    let list = await api().get('/api/projects').query({ role: 'specialist' }).set(auth(sp.token));
    expect(list.body.items[0]).toMatchObject({ paid: 0, paidPending: 200000000, lastReport: null });
    await api().post(`/api/payments/${p1.body.payment.id}/confirm`).set(auth(sp.token)).expect(200);
    await api().post(`/api/projects/${pid}/start`).set(auth(sp.token)).expect(200);
    await api().post(`/api/projects/${pid}/daily`).set(auth(sp.token)).send({ crew: 2, done: 'لوله‌گذاری برق واحد ۳' }).expect(201);
    list = await api().get('/api/projects').query({ role: 'specialist' }).set(auth(sp.token));
    expect(list.body.items[0]).toMatchObject({ paid: 200000000, paidPending: 0, lastReport: { done: 'لوله‌گذاری برق واحد ۳' } });
    const one = await api().get(`/api/projects/${pid}`).set(auth(boss.token));
    expect(one.body.project.paid).toBe(200000000);
    expect(one.body.project.can.progress).toBe(false);
  });

  it('contract text shows amounts with dot separators', async () => {
    const { boss, pid } = await makeProject();
    const g = await api().get(`/api/projects/${pid}/contract`).set(auth(boss.token));
    expect(g.body.contract.terms.clauses[2].text).toContain('۲۸.۵۰۰.۰۰۰ تومان');
  });

  it('an ad leaves explore once its contracts fill it; the owner can reopen it', async () => {
    const boss = await registered('contractor');
    const w1 = await registered('worker');
    const ad = await api()
      .post('/api/ads')
      .set(auth(boss.token))
      .send({ type: 'job', title: 'یک کارگر برای بلوک‌چینی', description: 'کار حدود ۵ روز', province: 'هرمزگان', city: 'قشم', wageType: 'روزانه', wageAmount: '۱.۸۰۰.۰۰۰', startWhen: 'فوری', range: 'city', audience: ['worker'], needCount: 1, skills: ['بلوک‌چینی'] });
    const adId = ad.body.ad.id;
    expect(ad.body.ad.wageAmount).toBe(1800000);
    const r = await api().post(`/api/ads/${adId}/responses`).set(auth(w1.token)).send({ message: 'می‌آیم' });
    const cid = r.body.response.conversationId;
    const d = await api().post(`/api/conversations/${cid}/deals`).set(auth(w1.token)).send(deal({ job: 'بلوک‌چینی', amount: '۹.۰۰۰.۰۰۰', price: '۱.۸۰۰.۰۰۰ روزانه', durationDays: 5 }));
    await api().post(`/api/messages/${d.body.message.id}/answer`).set(auth(boss.token)).send({ status: 'accepted' }).expect(200);

    const ex = await api().get('/api/ads').query({ mode: 'jobs' });
    expect(ex.body.items.some((a: { id: string }) => a.id === adId)).toBe(false);
    const nt = await api().get('/api/notifications').set(auth(boss.token));
    expect(nt.body.items.some((n: { title: string }) => n.title === 'آگهی‌ات از کاوش برداشته شد')).toBe(true);

    // آگهی «آمادهٔ کار» کارگر با اولین قرارداد بسته می‌شود
    const w2 = await registered('worker');
    const wad = await api()
      .post('/api/ads')
      .set(auth(w2.token))
      .send({ type: 'work', title: 'بنای ساختمان، آماده از شنبه', description: 'سابقهٔ ۵ سال', province: 'هرمزگان', city: 'قشم', wageType: 'روزانه', wageAmount: '۲.۰۰۰.۰۰۰', startWhen: 'فوری', range: 'city', audience: ['contractor'], skills: ['بنایی'] });
    expect(wad.status).toBe(201);
    const wr = await api().post(`/api/ads/${wad.body.ad.id}/responses`).set(auth(boss.token)).send({ message: 'بیا سر کار' });
    const d2 = await api().post(`/api/conversations/${wr.body.response.conversationId}/deals`).set(auth(boss.token)).send(deal({ job: 'بنایی', durationDays: 5 }));
    await api().post(`/api/messages/${d2.body.message.id}/answer`).set(auth(w2.token)).send({ status: 'accepted' }).expect(200);
    const ex2 = await api().get('/api/ads').query({ mode: 'workers' });
    expect(ex2.body.items.some((a: { id: string }) => a.id === wad.body.ad.id)).toBe(false);

    // دوباره فعال کردن از «آگهی‌های من»
    const re = await api().patch(`/api/ads/${adId}`).set(auth(boss.token)).send({ status: 'active' });
    expect(re.body.ad.status).toBe('active');
  });

  it('engineer can register with several fields', async () => {
    const e = await registered('engineer', { field: ['عمران', 'معماری'] });
    expect(e.profile.data.field).toEqual(['عمران', 'معماری']);
    expect(e.profile.title).toContain('عمران و معماری');
  });
});
