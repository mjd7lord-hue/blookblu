import { describe, it, expect } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { api, app, auth, registered } from './helpers';

const deal = {
  job: 'آرماتوربندی سقف دوم',
  qty: 'حدود ۳ تن',
  price: '۹٬۵۰۰٬۰۰۰ تومان هر تن',
  amount: '۲۸٬۵۰۰٬۰۰۰',
  start: 'دوشنبه ۶ مهر، ۷ صبح',
  durationDays: 3,
  plan: [
    { title: 'پیش‌پرداخت', pct: 30 },
    { title: 'پایان کار', pct: 70 },
  ],
  retentionPct: 10,
};

describe('chat, deals, projects', () => {
  it('full flow: chat → deal → project → start → finish → review', async () => {
    const boss = await registered('contractor');
    const w = await registered('specialist');

    // گفت‌وگوی مستقیم (از پروفایل)
    const c = await api().post('/api/conversations').set(auth(boss.token)).send({ profileCode: w.profile.code });
    expect(c.status).toBe(201);
    const cid = c.body.conversation.id;
    // دوباره = همان گفت‌وگو
    const c2 = await api().post('/api/conversations').set(auth(boss.token)).send({ profileCode: w.profile.code });
    expect(c2.body.conversation.id).toBe(cid);

    await api().post(`/api/conversations/${cid}/messages`).set(auth(boss.token)).send({ kind: 'text', body: 'سلام استاد، از کی آزادی؟' });
    let list = await api().get('/api/conversations').set(auth(w.token));
    expect(list.body.unreadTotal).toBe(1);
    expect(list.body.items[0].other.code).toBe(boss.profile.code);
    expect(list.body.items[0].last.text).toContain('سلام استاد');

    // خواندن → صفر شدن شمارنده
    const read = await api().get(`/api/conversations/${cid}/messages`).set(auth(w.token));
    expect(read.body.items.at(-1).mine).toBe(false);
    list = await api().get('/api/conversations').set(auth(w.token));
    expect(list.body.unreadTotal).toBe(0);

    // غریبه به گفت‌وگو دسترسی ندارد
    const stranger = await registered('worker');
    expect((await api().get(`/api/conversations/${cid}/messages`).set(auth(stranger.token))).status).toBe(404);

    // پیام مشکوک برای گیرنده علامت می‌خورد، برای فرستنده نه
    const sus = await api()
      .post(`/api/conversations/${cid}/messages`)
      .set(auth(w.token))
      .send({ kind: 'text', body: 'برای رزرو ۵۰٪ پیش‌پرداخت به کارت ۶۰۳۷-۹۹۷۵-۱۲۳۴-۴۴۲۱ بزنید' });
    expect(sus.body.message.flagged).toBe(false);
    const seen = await api().get(`/api/conversations/${cid}/messages`).set(auth(boss.token));
    expect(seen.body.items.at(-1).flagged).toBe(true);

    // شماره: از حساب خود فرستنده
    const ph = await api().post(`/api/conversations/${cid}/messages`).set(auth(w.token)).send({ kind: 'phone' });
    expect(ph.body.message.body).toBe(w.phone);

    // جمع درصد نادرست
    const bad = await api().post(`/api/conversations/${cid}/deals`).set(auth(w.token)).send({ ...deal, plan: [{ title: 'پیش‌پرداخت', pct: 50 }] });
    expect(bad.body.error.code).toBe('PLAN_SUM');

    const d1 = await api().post(`/api/conversations/${cid}/deals`).set(auth(w.token)).send(deal);
    expect(d1.status).toBe(201);
    expect(d1.body.message.status).toBe('pending');
    // پیشنهاد تازه، قبلی را لغو می‌کند
    const d2 = await api().post(`/api/conversations/${cid}/deals`).set(auth(w.token)).send({ ...deal, price: '۹٬۲۰۰٬۰۰۰ تومان هر تن' });
    expect((await api().post(`/api/messages/${d1.body.message.id}/answer`).set(auth(boss.token)).send({ status: 'accepted' })).body.error.code).toBe('NOT_PENDING');
    // فرستنده نمی‌تواند پیشنهاد خودش را بپذیرد
    expect((await api().post(`/api/messages/${d2.body.message.id}/answer`).set(auth(w.token)).send({ status: 'accepted' })).status).toBe(403);

    const acc = await api().post(`/api/messages/${d2.body.message.id}/answer`).set(auth(boss.token)).send({ status: 'accepted' });
    expect(acc.status).toBe(200);
    const pid = acc.body.project.id;
    expect(acc.body.project.stage).toBe(1);
    expect(acc.body.project.amount).toBe(28500000);

    // پیمانکار (رتبهٔ بالاتر) کارفرماست
    const pr = await api().get(`/api/projects/${pid}`).set(auth(boss.token));
    expect(pr.body.project.myRole).toBe('client');
    expect(pr.body.project.stageName).toBe('توافق');
    expect(pr.body.project.other.code).toBe(w.profile.code);
    expect(pr.body.project.paymentPlan).toHaveLength(2);

    // پروژهٔ فعال هست → توافق تازه ممنوع
    expect((await api().post(`/api/conversations/${cid}/deals`).set(auth(w.token)).send(deal)).body.error.code).toBe('PROJECT_ACTIVE');

    // روز شروع
    const day = await api().post(`/api/conversations/${cid}/days`).set(auth(boss.token)).send({ date: 'شنبه ۱۱ مهر', hour: '۷ صبح' });
    await api().post(`/api/messages/${day.body.message.id}/answer`).set(auth(w.token)).send({ status: 'accepted' });
    expect((await api().get(`/api/projects/${pid}`).set(auth(w.token))).body.project.startDate).toBe('شنبه ۱۱ مهر');

    // امتیاز قبل از پایان ممنوع
    expect((await api().post(`/api/projects/${pid}/review`).set(auth(boss.token)).send({ rating: 5 })).body.error.code).toBe('NOT_DONE');
    expect((await api().post(`/api/projects/${pid}/finish`).set(auth(boss.token))).body.error.code).toBe('BAD_STAGE');

    const st = await api().post(`/api/projects/${pid}/start`).set(auth(w.token));
    expect(st.body.project.stage).toBe(2);
    // مجری نمی‌تواند پایان را تأیید کند
    expect((await api().post(`/api/projects/${pid}/finish`).set(auth(w.token))).body.error.code).toBe('CLIENT_ONLY');
    const fin = await api().post(`/api/projects/${pid}/finish`).set(auth(boss.token));
    expect(fin.body.project.status).toBe('done');
    expect(fin.body.project.can.review).toBe(true);

    const rv = await api().post(`/api/projects/${pid}/review`).set(auth(boss.token)).send({ rating: 5, text: 'دقیق و منظم' });
    expect(rv.status).toBe(201);
    expect((await api().post(`/api/projects/${pid}/review`).set(auth(boss.token)).send({ rating: 1 })).status).toBe(409);
    expect((await api().post(`/api/projects/${pid}/review`).set(auth(stranger.token)).send({ rating: 1 })).status).toBe(404);
    await api().post(`/api/projects/${pid}/review`).set(auth(w.token)).send({ rating: 4 });

    const wp = await api().get(`/api/profiles/${w.profile.code}`);
    expect(wp.body.profile.trust).toMatchObject({ satisfaction: 55, projects: 1, reviews: 1, total: 57 });
    expect(wp.body.profile.reviews[0].text).toBe('دقیق و منظم');
    const bp = await api().get(`/api/profiles/${boss.profile.code}`);
    expect(bp.body.profile.rating).toBe(4);
    expect(bp.body.profile.doneCount).toBe(1);

    // گفت‌وگو مرحله را دنبال می‌کند
    const conv = await api().get(`/api/conversations/${cid}/messages`).set(auth(w.token));
    expect(conv.body.conversation.stage).toBe(3);
    expect(conv.body.project.id).toBe(pid);
    const mine = await api().get('/api/projects').query({ status: 'done' }).set(auth(w.token));
    expect(mine.body.items[0].myRole).toBe('provider');
  });

  it('ad-based deal: poster of a "work" ad is the provider', async () => {
    const w = await registered('worker');
    const g = await registered('general');
    const ad = await api()
      .post('/api/ads')
      .set(auth(w.token))
      .send({ type: 'work', title: 'کارگر بنایی آماده از شنبه', province: 'هرمزگان', city: 'قشم', audience: ['general'] });
    const r = await api().post(`/api/ads/${ad.body.ad.id}/responses`).set(auth(g.token)).send({ message: 'برای دیوار حیاط لازمت دارم' });
    const cid = r.body.response.conversationId;
    const d = await api().post(`/api/conversations/${cid}/deals`).set(auth(g.token)).send({ ...deal, job: 'دیوار حیاط' });
    const acc = await api().post(`/api/messages/${d.body.message.id}/answer`).set(auth(w.token)).send({ status: 'accepted' });
    const p = await api().get(`/api/projects/${acc.body.project.id}`).set(auth(w.token));
    expect(p.body.project.myRole).toBe('provider');

    const cancel = await api().post(`/api/projects/${acc.body.project.id}/cancel`).set(auth(w.token)).send({ reason: 'مصالح نرسید' });
    expect(cancel.body.project.status).toBe('cancelled');
    expect(cancel.body.project.stageName).toBe('لغو شده');
  });

  it('message delete, archive/pin, hide, blocking', async () => {
    const a = await registered('contractor');
    const b = await registered('worker');
    const cid = (await api().post('/api/conversations').set(auth(a.token)).send({ profileCode: b.profile.code })).body.conversation.id;
    const m = await api().post(`/api/conversations/${cid}/messages`).set(auth(a.token)).send({ kind: 'text', body: 'اشتباه فرستادم' });
    expect((await api().delete(`/api/messages/${m.body.message.id}`).set(auth(b.token))).status).toBe(403);
    await api().delete(`/api/messages/${m.body.message.id}`).set(auth(a.token));
    const msgs = await api().get(`/api/conversations/${cid}/messages`).set(auth(b.token));
    expect(msgs.body.items.at(-1).kind).toBe('del');
    expect(msgs.body.items.at(-1).body).toBeNull();

    await api().patch(`/api/conversations/${cid}`).set(auth(b.token)).send({ archived: true, pinned: true });
    expect((await api().get('/api/conversations').set(auth(b.token))).body.items).toHaveLength(0);
    expect((await api().get('/api/conversations').query({ filter: 'archived' }).set(auth(b.token))).body.items).toHaveLength(1);

    await api().delete(`/api/conversations/${cid}`).set(auth(a.token));
    expect((await api().get('/api/conversations').set(auth(a.token))).body.items).toHaveLength(0);
    // پیام تازه دوباره نشانش می‌دهد
    await api().post(`/api/conversations/${cid}/messages`).set(auth(b.token)).send({ kind: 'loc', payload: { place: 'قشم', label: 'ورودی کارگاه' } });
    expect((await api().get('/api/conversations').set(auth(a.token))).body.items).toHaveLength(1);

    await api().post('/api/blocks').set(auth(b.token)).send({ profileCode: a.profile.code });
    const blocked = await api().post(`/api/conversations/${cid}/messages`).set(auth(a.token)).send({ kind: 'text', body: 'سلام' });
    expect(blocked.body.error.code).toBe('BLOCKED');
  });

  it('live events over SSE', async () => {
    const a = await registered('contractor');
    const b = await registered('worker');
    const cid = (await api().post('/api/conversations').set(auth(a.token)).send({ profileCode: b.profile.code })).body.conversation.id;
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const got = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/events?token=${b.token}`, (res) => {
        let buf = '';
        res.on('data', (ch) => {
          buf += ch;
          if (buf.includes('event: ready')) {
            buf = '';
            api().post(`/api/conversations/${cid}/messages`).set(auth(a.token)).send({ kind: 'text', body: 'زنده' }).then(() => undefined);
          }
          if (buf.includes('event: message')) {
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    server.close();
    expect(got).toContain('زنده');
  });
});
