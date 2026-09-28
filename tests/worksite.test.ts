import { describe, it, expect } from 'vitest';
import { api, auth, makeProject, registered } from './helpers';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF', 'latin1');

describe('phase 5: contract, payments, statements, daily reports', () => {
  it('contract: draft from deal, edit resets signatures, SMS-code signing, print', async () => {
    const { boss, w, cid, pid } = await makeProject();
    const stranger = await registered('worker');

    const g = await api().get(`/api/projects/${pid}/contract`).set(auth(boss.token));
    expect(g.status).toBe(200);
    const c0 = g.body.contract;
    expect(c0.number).toMatch(/^BLK-14\d\d-\d{6}$/);
    expect(c0.status).toBe('draft');
    expect(c0.mySide).toBe('client');
    expect(c0.terms.clauses).toHaveLength(7);
    expect(c0.terms.milestones).toEqual([
      { title: 'پیش‌پرداخت', pct: 30 },
      { title: 'پایان کار', pct: 70 },
    ]);
    expect(c0.terms.clauses[2].text).toContain('۸٬۵۵۰٬۰۰۰ تومان');
    expect(c0.terms.provider.code).toBe(w.profile.code);
    expect((await api().get(`/api/projects/${pid}/contract`).set(auth(stranger.token))).status).toBe(404);
    // دوباره = همان قرارداد
    expect((await api().get(`/api/projects/${pid}/contract`).set(auth(w.token))).body.contract.id).toBe(c0.id);

    const bad = await api().patch(`/api/projects/${pid}/contract`).set(auth(boss.token)).send({ milestones: [{ title: 'همه', pct: 90 }] });
    expect(bad.body.error.code).toBe('PLAN_SUM');

    // کد ورود برای امضا کار نمی‌کند
    const login = await api().post('/api/auth/otp/send').send({ phone: boss.phone });
    const wrong = await api().post(`/api/projects/${pid}/contract/sign`).set(auth(boss.token)).send({ code: login.body.devCode, contentHash: c0.contentHash });
    expect(wrong.status).toBe(400);

    // کارفرما امضا می‌کند
    const code1 = await api().post(`/api/projects/${pid}/contract/sign-code`).set(auth(boss.token));
    expect(code1.body.devCode).toMatch(/^\d{5}$/);
    const stale = await api().post(`/api/projects/${pid}/contract/sign`).set(auth(boss.token)).send({ code: code1.body.devCode, contentHash: '0'.repeat(64) });
    expect(stale.body.error.code).toBe('CONTRACT_CHANGED');
    const s1 = await api()
      .post(`/api/projects/${pid}/contract/sign`)
      .set(auth(boss.token))
      .send({ code: code1.body.devCode.replace(/\d/g, (d: string) => '۰۱۲۳۴۵۶۷۸۹'[+d]), contentHash: c0.contentHash });
    expect(s1.status).toBe(200);
    expect(s1.body.contract.status).toBe('signing');
    expect(s1.body.contract.signatures.client).not.toBeNull();
    expect((await api().post(`/api/projects/${pid}/contract/sign-code`).set(auth(boss.token))).body.error.code).toBe('ALREADY_SIGNED');

    // مجری ویرایش می‌کند → نسخهٔ تازه، امضای قبلی باطل
    const ed = await api()
      .patch(`/api/projects/${pid}/contract`)
      .set(auth(w.token))
      .send({ retentionPct: 5, extraClauses: ['میلگرد و سیم‌آرماتور به عهدهٔ کارفرماست.'] });
    expect(ed.body.contract.version).toBe(2);
    expect(ed.body.contract.status).toBe('draft');
    expect(ed.body.contract.signatures.client).toBeNull();
    expect(ed.body.contract.terms.clauses).toHaveLength(8);
    expect(ed.body.contract.terms.clauses[4].text).toContain('۵٪');
    const proj = await api().get(`/api/projects/${pid}`).set(auth(boss.token));
    expect(proj.body.project.retentionPct).toBe(5);
    expect(JSON.stringify((await api().get('/api/notifications').set(auth(boss.token))).body)).toContain('دوباره امضا لازم است');

    // هر دو امضا می‌کنند
    for (const u of [boss, w]) {
      const cur = (await api().get(`/api/projects/${pid}/contract`).set(auth(u.token))).body.contract;
      const code = await api().post(`/api/projects/${pid}/contract/sign-code`).set(auth(u.token));
      const s = await api().post(`/api/projects/${pid}/contract/sign`).set(auth(u.token)).send({ code: code.body.devCode, contentHash: cur.contentHash });
      expect(s.status).toBe(200);
    }
    const fin = (await api().get(`/api/projects/${pid}/contract`).set(auth(w.token))).body.contract;
    expect(fin.status).toBe('active');
    expect(fin.can).toEqual({ edit: false, sign: false, remind: false });
    expect((await api().patch(`/api/projects/${pid}/contract`).set(auth(boss.token)).send({ retentionPct: 0 })).body.error.code).toBe('CONTRACT_LOCKED');
    expect((await api().get(`/api/projects/${pid}`).set(auth(boss.token))).body.project.contract.status).toBe('active');

    const msgs = await api().get(`/api/conversations/${cid}/messages`).set(auth(w.token));
    expect(JSON.stringify(msgs.body.items)).toContain('فعال شد');

    // نسخهٔ چاپی با لینک امضاشده
    const pr = await api().get(fin.printUrl);
    expect(pr.status).toBe(200);
    expect(pr.headers['content-type']).toContain('text/html');
    expect(pr.text).toContain(fin.number);
    expect(pr.text).toContain('امضاشده و فعال');
    expect(pr.text).toContain('میلگرد و سیم‌آرماتور');
    expect((await api().get(fin.printUrl.replace(/sig=.{4}/, 'sig=0000'))).status).toBe(404);
  });

  it('payment ledger: record, other side confirms or disputes, summary per milestone', async () => {
    const { boss, w, pid } = await makeProject();

    const p1 = await api()
      .post(`/api/projects/${pid}/payments`)
      .set(auth(boss.token))
      .send({ amount: '۸٬۵۵۰٬۰۰۰', label: 'پیش‌پرداخت', milestoneIndex: 0, paidOn: '2026-09-28' });
    expect(p1.status).toBe(201);
    expect(p1.body.payment.amount).toBe(8550000);
    expect(p1.body.payment.status).toBe('recorded');
    expect((await api().post(`/api/payments/${p1.body.payment.id}/confirm`).set(auth(boss.token))).body.error.code).toBe('OWN_PAYMENT');
    const ok = await api().post(`/api/payments/${p1.body.payment.id}/confirm`).set(auth(w.token));
    expect(ok.body.payment.status).toBe('confirmed');
    expect((await api().post(`/api/payments/${p1.body.payment.id}/confirm`).set(auth(w.token))).body.error.code).toBe('ALREADY_ANSWERED');

    expect((await api().post(`/api/projects/${pid}/payments`).set(auth(boss.token)).send({ amount: 1000, label: 'قسط مرحله', milestoneIndex: 5 })).body.error.code).toBe('BAD_MILESTONE');
    const p2 = await api().post(`/api/projects/${pid}/payments`).set(auth(boss.token)).send({ amount: 5000000, label: 'قسط مرحله', milestoneIndex: 1 });
    const dis = await api().post(`/api/payments/${p2.body.payment.id}/dispute`).set(auth(w.token)).send({ reason: 'این مبلغ به حسابم نرسیده' });
    expect(dis.body.payment.status).toBe('disputed');
    expect(dis.body.payment.disputeReason).toBe('این مبلغ به حسابم نرسیده');

    const list = await api().get(`/api/projects/${pid}/payments`).set(auth(w.token));
    expect(list.body.items).toHaveLength(2);
    expect(list.body.summary).toMatchObject({ total: 28500000, confirmed: 8550000, disputed: 5000000, remaining: 19950000, retention: 2850000 });
    expect(list.body.summary.milestones[0]).toMatchObject({ title: 'پیش‌پرداخت', due: 8550000, paid: 8550000 });
    expect(list.body.summary.milestones[1]).toMatchObject({ due: 19950000, paid: 0 });

    expect((await api().delete(`/api/payments/${p1.body.payment.id}`).set(auth(boss.token))).body.error.code).toBe('PAYMENT_CONFIRMED');
    expect((await api().delete(`/api/payments/${p2.body.payment.id}`).set(auth(w.token))).body.error.code).toBe('NOT_OWNER');
    await api().delete(`/api/payments/${p2.body.payment.id}`).set(auth(boss.token)).expect(200);
  });

  it('progress statements: provider bills, client approves with adjustment, next one continues', async () => {
    const { boss, w, pid } = await makeProject();

    expect((await api().post(`/api/projects/${pid}/statements`).set(auth(boss.token)).send({})).body.error.code).toBe('PROVIDER_ONLY');
    expect((await api().post(`/api/projects/${pid}/statements`).set(auth(w.token)).send({})).body.error.code).toBe('NO_ROWS');

    const s1 = await api()
      .post(`/api/projects/${pid}/statements`)
      .set(auth(w.token))
      .send({
        insurancePct: 5,
        items: [
          { title: 'بتن‌ریزی فونداسیون', unit: 'متر مکعب', qty: '۴۲', unitPrice: '۴٬۲۰۰٬۰۰۰', done: 42 },
          { title: 'آرماتوربندی سقف اول', unit: 'کیلوگرم', qty: 6800, unitPrice: 95000, done: '۳۴۰۰' },
        ],
      });
    expect(s1.status).toBe(201);
    const st = s1.body.statement;
    expect(st.number).toBe(1);
    expect(st.retentionPct).toBe(10); // از قرارداد/پروژه
    expect(st.totals).toMatchObject({ contractValue: 822400000, doneValue: 499400000, prevValue: 0, periodValue: 499400000, retention: 49940000, insurance: 24970000, payable: 424490000, progressPct: 61 });
    expect(st.items[0].title).toBe('بتن‌ریزی فونداسیون');
    expect((await api().post(`/api/projects/${pid}/statements`).set(auth(w.token)).send({})).body.error.code).toBe('STATEMENT_OPEN');

    // کارفرما پیش‌نویس را تأیید نمی‌کند؛ اول باید ارسال شود
    expect((await api().post(`/api/statements/${st.id}/approve`).set(auth(boss.token)).send({})).body.error.code).toBe('NOT_SENT');
    await api().post(`/api/statements/${st.id}/send`).set(auth(w.token)).expect(200);
    expect((await api().patch(`/api/statements/${st.id}`).set(auth(w.token)).send({ note: 'x' })).body.error.code).toBe('STATEMENT_LOCKED');

    // کارفرما آرماتوربندی را ۳۰۰۰ کیلو تأیید می‌کند (نه ۳۴۰۰)
    const keyB = st.items[1].key;
    expect((await api().post(`/api/statements/${st.id}/approve`).set(auth(boss.token)).send({ adjust: [{ key: keyB, done: 4000 }] })).body.error.code).toBe('BAD_ADJUST');
    const ap = await api().post(`/api/statements/${st.id}/approve`).set(auth(boss.token)).send({ adjust: [{ key: keyB, done: 3000 }] });
    expect(ap.body.statement.status).toBe('approved');
    expect(ap.body.statement.totals).toMatchObject({ doneValue: 461400000, periodValue: 461400000, retention: 46140000, insurance: 23070000, payable: 392190000 });

    // پرداخت به صورت‌وضعیت تأییدشده گره می‌خورد
    const pay = await api().post(`/api/projects/${pid}/payments`).set(auth(boss.token)).send({ amount: 392190000, label: 'صورت‌وضعیت', statementId: st.id });
    expect(pay.status).toBe(201);

    // صورت‌وضعیت دوم: ردیف‌ها از قبلی با «قبلی» پر می‌شوند
    const s2 = await api().post(`/api/projects/${pid}/statements`).set(auth(w.token)).send({});
    const st2 = s2.body.statement;
    expect(st2.number).toBe(2);
    expect(st2.items[1]).toMatchObject({ key: keyB, prevDone: 3000, done: 3000 });
    expect(st2.totals.periodValue).toBe(0);
    expect((await api().post(`/api/statements/${st2.id}/send`).set(auth(w.token))).body.error.code).toBe('NOTHING_TO_BILL');

    const rows = st2.items.map((x: { key: string; title: string; unit: string; qty: number; unitPrice: number; done: number }) => ({ ...x }));
    rows[1].done = 2000;
    expect((await api().patch(`/api/statements/${st2.id}`).set(auth(w.token)).send({ items: rows })).body.error.code).toBe('ROW_BELOW_PREV');
    rows[1].done = 6800;
    const up = await api().patch(`/api/statements/${st2.id}`).set(auth(w.token)).send({ items: rows });
    expect(up.body.statement.totals).toMatchObject({ prevValue: 461400000, periodValue: 361000000, progressPct: 100 });

    await api().post(`/api/statements/${st2.id}/send`).set(auth(w.token)).expect(200);
    const rj = await api().post(`/api/statements/${st2.id}/reject`).set(auth(boss.token)).send({ reason: 'ردیف آرماتور هنوز بازدید نشده' });
    expect(rj.body.statement.status).toBe('rejected');
    expect(rj.body.statement.can.edit).toBe(false); // دید کارفرما
    const again = await api().get(`/api/statements/${st2.id}`).set(auth(w.token));
    expect(again.body.statement.can).toMatchObject({ edit: true, send: true });
    await api().post(`/api/statements/${st2.id}/send`).set(auth(w.token)).expect(200);
    await api().post(`/api/statements/${st2.id}/approve`).set(auth(boss.token)).send({}).expect(200);

    const list = await api().get(`/api/projects/${pid}/statements`).set(auth(boss.token));
    expect(list.body.items.map((x: { number: number; status: string }) => [x.number, x.status])).toEqual([
      [2, 'approved'],
      [1, 'approved'],
    ]);
  });

  it('daily site reports with photos, and project files', async () => {
    const { boss, w, pid } = await makeProject();
    const stranger = await registered('worker');

    const d1 = await api()
      .post(`/api/projects/${pid}/daily`)
      .set(auth(w.token))
      .field('weather', 'آفتابی · ۳۴°')
      .field('crew', '۶')
      .field('done', 'آرماتوربندی تیرهای سقف دوم؛ ۶۰٪ شبکهٔ میلگرد بسته شد.')
      .field('issues', 'میلگرد ۱۴ کم آمد.')
      .attach('photos', JPEG, 'a.jpg')
      .attach('photos', JPEG, 'b.jpg');
    expect(d1.status).toBe(201);
    const r = d1.body.report;
    expect(r.crew).toBe(6);
    expect(r.photos).toHaveLength(2);
    expect(r.author.side).toBe('provider');
    expect(r.dateFa).toMatch(/^۱۴/);

    // عکس‌ها فقط برای دو طرف پروژه
    expect((await api().get(r.photos[0])).status).toBe(200);
    const bare = r.photos[0].split('?')[0];
    expect((await api().get(bare).set(auth(boss.token))).status).toBe(200);
    expect((await api().get(bare).set(auth(stranger.token))).status).toBe(404);

    const dup = await api().post(`/api/projects/${pid}/daily`).set(auth(w.token)).send({ done: 'گزارش دوم امروز' });
    expect(dup.body.error.code).toBe('DAILY_EXISTS');
    expect(dup.body.error.details.id).toBe(r.id);
    expect((await api().post(`/api/projects/${pid}/daily`).set(auth(w.token)).send({ done: 'فردا', date: '2099-01-01' })).body.error.code).toBe('FUTURE_DATE');
    expect((await api().post(`/api/projects/${pid}/daily`).set(auth(stranger.token)).send({ done: 'غریبه' })).status).toBe(404);

    // کارفرما هم گزارش خودش را (بدون عکس، JSON) می‌نویسد
    await api().post(`/api/projects/${pid}/daily`).set(auth(boss.token)).send({ done: 'بازدید از کارگاه؛ کیفیت بستن میلگرد خوب بود.' }).expect(201);
    const list = await api().get(`/api/projects/${pid}/daily`).set(auth(boss.token));
    expect(list.body.items).toHaveLength(2);
    expect(list.body.stats).toEqual({ days: 1, crewDays: 6 });

    expect((await api().patch(`/api/daily/${r.id}`).set(auth(boss.token)).send({ crew: 7 })).body.error.code).toBe('NOT_OWNER');
    expect((await api().patch(`/api/daily/${r.id}`).set(auth(w.token)).send({ crew: 7, issues: '' })).body.report).toMatchObject({ crew: 7, issues: null });

    // فایل پروژه
    const f = await api().post(`/api/projects/${pid}/files`).set(auth(boss.token)).attach('file', PDF, 'نقشهٔ آرماتور سقف دوم.pdf');
    expect(f.status).toBe(201);
    const files = await api().get(`/api/projects/${pid}/files`).set(auth(w.token));
    expect(files.body.items).toHaveLength(1); // عکس‌های گزارش روزانه جدا هستند
    expect(files.body.items[0]).toMatchObject({ name: 'نقشهٔ آرماتور سقف دوم.pdf', mine: false });
    expect((await api().get(files.body.items[0].url)).status).toBe(200);
    expect((await api().delete(`/api/projects/${pid}/files/${f.body.file.id}`).set(auth(w.token))).body.error.code).toBe('NOT_OWNER');
    await api().delete(`/api/projects/${pid}/files/${f.body.file.id}`).set(auth(boss.token)).expect(200);

    // حذف گزارش → عکس‌ها هم پاک
    await api().delete(`/api/daily/${r.id}`).set(auth(w.token)).expect(200);
    expect((await api().get(r.photos[0])).status).toBe(404);
  });

  it('cancelling a project voids the unsigned contract and closes the ledger', async () => {
    const { boss, pid } = await makeProject();
    await api().get(`/api/projects/${pid}/contract`).set(auth(boss.token)).expect(200);
    await api().post(`/api/projects/${pid}/cancel`).set(auth(boss.token)).send({ reason: 'کارفرما منصرف شد' }).expect(200);
    const c = await api().get(`/api/projects/${pid}/contract`).set(auth(boss.token));
    expect(c.body.contract.status).toBe('void');
    expect(c.body.contract.can.sign).toBe(false);
    expect((await api().post(`/api/projects/${pid}/contract/sign-code`).set(auth(boss.token))).body.error.code).toBe('PROJECT_CLOSED');
    expect((await api().post(`/api/projects/${pid}/payments`).set(auth(boss.token)).send({ amount: 1000, label: 'سایر' })).body.error.code).toBe('PROJECT_CLOSED');
    expect((await api().post(`/api/projects/${pid}/daily`).set(auth(boss.token)).send({ done: 'بعد از لغو' })).body.error.code).toBe('PROJECT_CLOSED');
  });
});
