import { describe, it, expect } from 'vitest';
import { eq, ne } from 'drizzle-orm';
import { db } from '../src/db';
import { arbiters, arbitrationCases, disputes, users } from '../src/db/schema';
import { api, auth, makeProject, registered } from './helpers';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF', 'latin1');

async function admin() {
  const a = await registered('general');
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, a.profile.userId));
  return a;
}
/** مهندس حل‌کنندهٔ تأییدشده (شیراز، هر جا بازدید می‌کند) */
async function arbiter(adm: { token: string }) {
  const e = await registered('engineer');
  const ap = await api()
    .post('/api/arbitration/apply')
    .set(auth(e.token))
    .field('fields', 'struct,qty')
    .field('range', 'neighbors')
    .field('pledge', 'true')
    .attach('file', PDF, 'nezam.pdf');
  expect(ap.status).toBe(201);
  const list = await api().get('/api/admin/arbitration/arbiters').set(auth(adm.token));
  const row = list.body.items.find((x: { profile: { code: string } }) => x.profile.code === e.profile.code);
  await api().post(`/api/admin/arbitration/arbiters/${row.id}/approve`).set(auth(adm.token)).send({}).expect(200);
  return { ...e, arbiterId: row.id as string };
}
/** فقط همین حل‌کننده فعال بماند (حل‌کننده‌های تست‌های قبلی در همین دیتابیس هستند) */
const onlyArbiter = (id: string) => db.update(arbiters).set({ status: 'suspended' }).where(ne(arbiters.id, id));
const endTalk = (id: string) => db.update(disputes).set({ talkUntil: new Date(Date.now() - 1000) }).where(eq(disputes.id, id));
async function jobOf(u: { token: string }, disputeId: string) {
  const j = await api().get('/api/arbitration/jobs').set(auth(u.token));
  return j.body.items.find((x: { dispute: { id: string }; status: string }) => x.dispute.id === disputeId && x.status !== 'matching');
}
const report = (u: { token: string }, caseId: string, n = 3, extra: Record<string, string> = {}) => {
  let q = api()
    .post(`/api/arbitration/jobs/${caseId}/report`)
    .set(auth(u.token))
    .field('measure', 'مقاومت بتن سقف با چکش اشمیت ۲۲ مگاپاسکال؛ قرارداد C25 خواسته.')
    .field('compare', 'مغایرت جزئی')
    .field('verdict', 'تقسیم مسئولیت')
    .field('remedy', 'مجری ۳۰٪ از مبلغ بتن‌ریزی سقف را کسر می‌کند؛ کارفرما باقی را ظرف ۷ روز می‌پردازد.');
  for (const [k, v] of Object.entries(extra)) q = q.field(k, v);
  for (let i = 0; i < n; i++) q = q.attach('photos', JPEG, `p${i}.jpg`);
  return q;
};

describe('on-site arbitration', () => {
  it('arbiter application rules', async () => {
    const adm = await admin();
    const w = await registered('worker');
    const s = await registered('specialist');
    const noRole = await api().post('/api/arbitration/apply').set(auth(w.token)).field('fields', 'mas').field('pledge', 'true').attach('file', PDF, 'a.pdf');
    expect(noRole.body.error.code).toBe('ROLE_NOT_ALLOWED');
    const badField = await api().post('/api/arbitration/apply').set(auth(s.token)).field('fields', 'struct').field('pledge', 'true').attach('file', PDF, 'a.pdf');
    expect(badField.body.error.code).toBe('BAD_FIELDS');
    const noPledge = await api().post('/api/arbitration/apply').set(auth(s.token)).field('fields', 'mas,fin').attach('file', PDF, 'a.pdf');
    expect(noPledge.status).toBe(400);

    const me0 = await api().get('/api/arbitration/me').set(auth(s.token));
    expect(me0.body.arbiter).toBeNull();
    expect(me0.body.allowedFields.map((f: { key: string }) => f.key)).toEqual(['mas', 'fin', 'iso']);
    expect(me0.body.checklist.find((c: { key: string }) => c.key === 'kyc').ok).toBe(false);

    const ok = await api().post('/api/arbitration/apply').set(auth(s.token)).field('fields', '["mas","iso"]').field('range', 'province').field('pledge', 'true').attach('file', PDF, 'cert.pdf');
    expect(ok.status).toBe(201);
    expect(ok.body.arbiter).toMatchObject({ status: 'pending', fields: ['mas', 'iso'], range: 'province' });
    expect((await api().post('/api/arbitration/apply').set(auth(s.token)).field('fields', 'mas').field('pledge', 'true').attach('file', PDF, 'a.pdf')).body.error.code).toBe('ARBITER_EXISTS');

    // ادمین: مدرک خصوصی را می‌بیند، رد می‌کند، دوباره درخواست ممکن است
    const list = await api().get('/api/admin/arbitration/arbiters').set(auth(adm.token));
    const row = list.body.items.find((x: { profile: { code: string } }) => x.profile.code === s.profile.code);
    expect((await api().get(row.docUrl)).status).toBe(200);
    expect((await api().get('/api/admin/arbitration/arbiters').set(auth(s.token))).status).toBe(403);
    await api().post(`/api/admin/arbitration/arbiters/${row.id}/reject`).set(auth(adm.token)).send({ reason: 'گواهی مهارت خوانا نیست' }).expect(200);
    const me1 = await api().get('/api/arbitration/me').set(auth(s.token));
    expect(me1.body.arbiter).toMatchObject({ status: 'rejected', rejectReason: 'گواهی مهارت خوانا نیست' });
    const again = await api().post('/api/arbitration/apply').set(auth(s.token)).field('fields', 'fin').field('pledge', 'true').attach('file', PDF, 'cert2.pdf');
    expect(again.body.arbiter.status).toBe('pending');
  });

  it('full flow: dispute → fee → escrow → impartial arbiter → reject once → report → appeal → final', async () => {
    const adm = await admin();
    const A = await arbiter(adm);
    const Bk = await arbiter(adm);
    const { boss, w, pid, cid } = await makeProject();
    const stranger = await registered('worker');

    const meta = await api().get('/api/disputes/meta');
    expect(meta.body.fields.find((f: { key: string }) => f.key === 'struct').factor).toBe(1.4);

    const op = await api()
      .post(`/api/projects/${pid}/disputes`)
      .set(auth(boss.token))
      .send({ reason: 'کیفیت کار', ask: 'اصلاح کار', description: 'بتن سقف انباری مطابق قرارداد نیست؛ ترک مویی دارد.' });
    expect(op.status).toBe(201);
    const d0 = op.body.dispute;
    expect(d0).toMatchObject({ mine: true, status: 'open', stage: 1, city: 'قشم', talkOver: false });
    expect(d0.can.requestArbitration).toBe(false);
    expect((await api().post(`/api/projects/${pid}/disputes`).set(auth(w.token)).send({ reason: 'تأخیر در پرداخت', ask: 'پرداخت باقی‌مانده', description: 'پرداخت مرحلهٔ دوم عقب افتاده است.' })).body.error.code).toBe('DISPUTE_OPEN');
    expect((await api().get(`/api/disputes/${d0.id}`).set(auth(stranger.token))).status).toBe(404);
    const msgs = await api().get(`/api/conversations/${cid}/messages`).set(auth(w.token));
    expect(JSON.stringify(msgs.body.items)).toContain('پروندهٔ اختلاف ثبت شد');

    const body = { field: 'struct', amountMillion: '۱۲۰', multi: false, agree: true };
    expect((await api().post(`/api/disputes/${d0.id}/arbitration`).set(auth(boss.token)).send(body)).body.error.code).toBe('TALK_WINDOW');
    await endTalk(d0.id);
    expect((await api().post(`/api/disputes/${d0.id}/arbitration`).set(auth(w.token)).send(body)).body.error.code).toBe('OPENER_ONLY');

    // هزینه: ۱٬۲۰۰٬۰۰۰ × ۱٫۴ × ۱٫۶ ← ۲٬۶۹۰٬۰۰۰؛ سازه = پیچیده ۲۰٪؛ حل‌کننده‌ها در شیراز ← رفت‌وآمد از استان دیگر
    const q = await api().get(`/api/disputes/${d0.id}/quote?field=struct&amountMillion=120`).set(auth(boss.token));
    expect(q.body.quote).toMatchObject({ fee: 2690000, commissionPct: 20, commission: 538000, travelKind: 'far', travel: 2000000, arbiterShare: 4152000, total: 4690000, available: 2 });
    const q2 = await api().get(`/api/disputes/${d0.id}/quote?field=fin&amountMillion=40`).set(auth(boss.token));
    expect(q2.body.quote).toMatchObject({ fee: 1200000, commissionPct: 15, commission: 180000, available: 0 });

    const rq = await api().post(`/api/disputes/${d0.id}/arbitration`).set(auth(boss.token)).send(body);
    expect(rq.status).toBe(201);
    expect(rq.body.payment).toMatchObject({ amount: 4690000, method: 'manual' });
    expect(rq.body.dispute).toMatchObject({ status: 'arbitration', stage: 2 });
    expect(rq.body.dispute.case).toMatchObject({ status: 'awaiting_payment', paymentStatus: 'unpaid', paidByMe: true, arbiter: null });
    const caseId = rq.body.dispute.case.id;

    // پرداخت امانی (ادمین تأیید می‌کند) ← پیشنهاد به یک حل‌کنندهٔ بی‌طرف
    const pay = await api().post(`/api/admin/arbitration/cases/${caseId}/confirm-payment`).set(auth(adm.token)).send({ ref: 'کارت‌به‌کارت ۱۲۳۴۵۶' });
    expect(pay.body.matched).toBe(true);
    expect((await api().get(`/api/disputes/${d0.id}`).set(auth(w.token))).body.dispute.case).toMatchObject({ status: 'offered', paymentStatus: 'paid', arbiter: null });
    expect((await api().post(`/api/disputes/${d0.id}/settle`).set(auth(boss.token))).body.error.code).toBe('ARB_IN_PROGRESS');

    const [first, second] = (await jobOf(A, d0.id)) ? [A, Bk] : [Bk, A];
    const job1 = await jobOf(first, d0.id);
    expect(job1).toMatchObject({ status: 'offered', arbiterShare: 4152000, can: { accept: true } });
    expect(job1.dispute.description).toContain('بتن سقف');
    expect((await api().post(`/api/arbitration/jobs/${job1.id}/accept`).set(auth(first.token)).send({ visitAt: 'دوشنبه ۷ مهر · ۸ صبح' })).status).toBe(400);
    await api().post(`/api/arbitration/jobs/${job1.id}/accept`).set(auth(first.token)).send({ visitAt: 'دوشنبه ۷ مهر · ۸ صبح', impartial: true }).expect(200);
    let dv = (await api().get(`/api/disputes/${d0.id}`).set(auth(boss.token))).body.dispute;
    expect(dv.case.status).toBe('assigned');
    expect(dv.case.arbiter.code).toBe(first.profile.code);
    expect(dv.case.visitText).toBe('دوشنبه ۷ مهر · ۸ صبح');

    // هر طرف یک بار حق رد
    await api().post(`/api/disputes/${d0.id}/reject-arbiter`).set(auth(boss.token)).expect(200);
    expect(await jobOf(first, d0.id)).toBeUndefined();
    const job2 = await jobOf(second, d0.id);
    expect(job2.status).toBe('offered');
    await api().post(`/api/arbitration/jobs/${job2.id}/accept`).set(auth(second.token)).send({ visitAt: 'سه‌شنبه ۸ مهر · ۹ صبح', impartial: true }).expect(200);
    expect((await api().post(`/api/disputes/${d0.id}/reject-arbiter`).set(auth(boss.token))).body.error.code).toBe('REJECT_USED');

    // گزارش: حداقل ۳ عکس
    expect((await report(second, job2.id, 2)).body.error.code).toBe('PHOTOS_REQUIRED');
    const rep = await report(second, job2.id, 3);
    expect(rep.status).toBe(201);
    expect(rep.body.job.status).toBe('reported');
    dv = (await api().get(`/api/disputes/${d0.id}`).set(auth(w.token))).body.dispute;
    expect(dv.stage).toBe(3);
    expect(dv.case.report).toMatchObject({ verdict: 'تقسیم مسئولیت', compare: 'مغایرت جزئی' });
    expect(dv.case.photos).toHaveLength(3);
    expect(dv.can).toMatchObject({ appeal: true, accept: true });
    expect((await api().get(dv.case.photos[0])).status).toBe(200);
    const bare = dv.case.photos[0].split('?')[0];
    expect((await api().get(bare).set(auth(boss.token))).status).toBe(200);
    expect((await api().get(bare).set(auth(stranger.token))).status).toBe(404);
    // عکس‌های داوری در فایل‌های پروژه نمی‌آیند
    expect((await api().get(`/api/projects/${pid}/files`).set(auth(boss.token))).body.items).toHaveLength(0);

    // اعتراض مجری ← بازبینی با نصف هزینه و حل‌کنندهٔ دیگر
    expect((await api().post(`/api/disputes/${d0.id}/appeal`).set(auth(w.token)).send({ reason: 'کوتاه' })).status).toBe(400);
    const ap = await api().post(`/api/disputes/${d0.id}/appeal`).set(auth(w.token)).send({ reason: 'نمونه‌برداری فقط از یک نقطه بوده و آزمایش مغزه انجام نشده.' });
    expect(ap.status).toBe(201);
    expect(ap.body.payment.amount).toBe(1350000);
    expect(ap.body.dispute.case).toMatchObject({ round: 2, status: 'awaiting_payment', fee: 1350000, travel: 0, commission: 270000, arbiterShare: 1080000 });
    expect(ap.body.dispute.history[0]).toMatchObject({ round: 1, status: 'appealed' });
    const c2 = ap.body.dispute.case.id;
    await api().post(`/api/admin/arbitration/cases/${c2}/confirm-payment`).set(auth(adm.token)).send({ ref: 'درگاه ۹۸۷۶۵' }).expect(200);
    // حل‌کنندهٔ دور اول در بازبینی نیست؛ حل‌کنندهٔ ردشده در دور اول می‌تواند بازبین باشد
    expect(await jobOf(second, d0.id)).toMatchObject({ round: 1 });
    const job3 = (await api().get('/api/arbitration/jobs').set(auth(first.token))).body.items.find((x: { id: string }) => x.id === c2);
    expect(job3.round).toBe(2);
    await api().post(`/api/arbitration/jobs/${c2}/accept`).set(auth(first.token)).send({ visitAt: 'پنجشنبه ۱۰ مهر', impartial: true }).expect(200);
    expect((await report(first, c2, 3)).body.error.code).toBe('UPHOLDS_REQUIRED');
    const rep2 = await report(first, c2, 3, { upholds: 'true' });
    expect(rep2.status).toBe(201);

    // رأی بازبینی نهایی است ← پرونده بسته و پول هر دو دور آزاد
    dv = (await api().get(`/api/disputes/${d0.id}`).set(auth(boss.token))).body.dispute;
    expect(dv).toMatchObject({ status: 'decided', stage: 4 });
    expect(dv.case).toMatchObject({ status: 'final', paymentStatus: 'released' });
    expect(dv.case.report.upholds).toBe(true);
    expect(dv.history[0].paymentStatus).toBe('released');
    const earn = await api().get('/api/arbitration/me').set(auth(second.token));
    expect(earn.body.stats).toMatchObject({ earned: 4152000, done: 1 });
    expect(earn.body.arbiter.casesDone).toBe(1);

    // امتیاز به حل‌کنندهٔ آخر
    await api().post(`/api/disputes/${d0.id}/rate`).set(auth(boss.token)).send({ rating: 5, impartial: true }).expect(201);
    expect((await api().post(`/api/disputes/${d0.id}/rate`).set(auth(boss.token)).send({ rating: 4, impartial: true })).body.error.code).toBe('ALREADY_RATED');
    expect((await api().get('/api/arbitration/me').set(auth(first.token))).body.arbiter).toMatchObject({ rating: 5, ratingCount: 1 });

    const notifs = await api().get('/api/notifications').set(auth(w.token));
    expect(JSON.stringify(notifs.body)).toContain('رأی بازبینی ثبت شد');
    const list = await api().get('/api/disputes').set(auth(w.token));
    expect(list.body.items[0]).toMatchObject({ id: d0.id, mine: false, status: 'decided' });
  });

  it('settle, refund and re-request, both-accept and appeal deadline', async () => {
    const adm = await admin();
    const A = await arbiter(adm);
    await onlyArbiter(A.arbiterId);

    // توافق پیش از پرداخت
    const p1 = await makeProject();
    const d1 = (await api().post(`/api/projects/${p1.pid}/disputes`).set(auth(p1.w.token)).send({ reason: 'تأخیر در پرداخت', ask: 'پرداخت باقی‌مانده', description: 'قسط دوم ۱۲ روز عقب افتاده است.' })).body.dispute;
    await endTalk(d1.id);
    await api().post(`/api/disputes/${d1.id}/arbitration`).set(auth(p1.w.token)).send({ field: 'qty', amountMillion: 30, agree: true }).expect(201);
    const st = await api().post(`/api/disputes/${d1.id}/settle`).set(auth(p1.boss.token));
    expect(st.body.dispute).toMatchObject({ status: 'settled', stage: 4, case: null });

    // حل‌کننده نیامد ← برگشت کامل پول و درخواست دوباره
    const p2 = await makeProject();
    const d2 = (await api().post(`/api/projects/${p2.pid}/disputes`).set(auth(p2.boss.token)).send({ reason: 'کیفیت کار', ask: 'اصلاح کار', description: 'آرماتوربندی سقف مطابق نقشه نیست.' })).body.dispute;
    await endTalk(d2.id);
    const r2 = await api().post(`/api/disputes/${d2.id}/arbitration`).set(auth(p2.boss.token)).send({ field: 'struct', amountMillion: 60, agree: true });
    const k2 = r2.body.dispute.case.id;
    expect((await api().post(`/api/admin/arbitration/cases/${k2}/refund`).set(auth(adm.token)).send({ reason: 'x-y' })).body.error.code).toBe('NOT_REFUNDABLE');
    await api().post(`/api/admin/arbitration/cases/${k2}/confirm-payment`).set(auth(adm.token)).send({ ref: 'ref-1' }).expect(200);
    const j = await jobOf(A, d2.id);
    await api().post(`/api/arbitration/jobs/${j.id}/accept`).set(auth(A.token)).send({ visitAt: 'شنبه ۵ مهر', impartial: true }).expect(200);
    await api().post(`/api/admin/arbitration/cases/${k2}/refund`).set(auth(adm.token)).send({ reason: 'حل‌کننده سر قرار نیامد' }).expect(200);
    let dv = (await api().get(`/api/disputes/${d2.id}`).set(auth(p2.boss.token))).body.dispute;
    expect(dv).toMatchObject({ status: 'open', case: null, can: { requestArbitration: true } });
    expect(dv.history[0]).toMatchObject({ status: 'refunded', paymentStatus: 'refunded' });
    const again = await api().post(`/api/disputes/${d2.id}/arbitration`).set(auth(p2.boss.token)).send({ field: 'struct', amountMillion: 60, agree: true });
    expect(again.status).toBe(201);
    const k3 = again.body.dispute.case.id;
    await api().post(`/api/admin/arbitration/cases/${k3}/confirm-payment`).set(auth(adm.token)).send({ ref: 'ref-2' }).expect(200);
    // حل‌کننده‌ای که سر قرار نیامد برای همین پرونده دوباره انتخاب نمی‌شود ← منتظر حل‌کنندهٔ دیگر
    expect((await api().get(`/api/disputes/${d2.id}`).set(auth(p2.boss.token))).body.dispute.case.status).toBe('matching');
    const B = await arbiter(adm); // با تأیید حل‌کنندهٔ تازه، پرونده‌های منتظر دوباره تطبیق داده می‌شوند
    const j3 = await jobOf(B, d2.id);
    expect(j3.id).toBe(k3);
    await api().post(`/api/arbitration/jobs/${j3.id}/accept`).set(auth(B.token)).send({ visitAt: 'یکشنبه ۶ مهر', impartial: true }).expect(200);
    await report(B, j3.id, 3).expect(201);

    // یک طرف قبول ← هنوز باز؛ هر دو ← نهایی
    await api().post(`/api/disputes/${d2.id}/accept`).set(auth(p2.boss.token)).expect(200);
    dv = (await api().get(`/api/disputes/${d2.id}`).set(auth(p2.w.token))).body.dispute;
    expect(dv.case.status).toBe('reported');
    expect(dv.can.accept).toBe(true);
    await api().post(`/api/disputes/${d2.id}/accept`).set(auth(p2.w.token)).expect(200);
    dv = (await api().get(`/api/disputes/${d2.id}`).set(auth(p2.w.token))).body.dispute;
    expect(dv).toMatchObject({ status: 'decided', case: { status: 'final', paymentStatus: 'released' } });

    // مهلت اعتراض تمام ← خودکار نهایی
    const p3 = await makeProject();
    const d3 = (await api().post(`/api/projects/${p3.pid}/disputes`).set(auth(p3.boss.token)).send({ reason: 'ترک کار', ask: 'بازگشت پیش‌پرداخت', description: 'مجری سه روز است سر کار نیامده.' })).body.dispute;
    await endTalk(d3.id);
    const r3 = await api().post(`/api/disputes/${d3.id}/arbitration`).set(auth(p3.boss.token)).send({ field: 'qty', amountMillion: 10, agree: true });
    await api().post(`/api/admin/arbitration/cases/${r3.body.dispute.case.id}/confirm-payment`).set(auth(adm.token)).send({ ref: 'ref-3' }).expect(200);
    // دو حل‌کنندهٔ فعال؛ هر کدام که پرونده را گرفته (با سابقهٔ بیشتر جلوتر است)
    const who = (await jobOf(A, d3.id)) ? A : B;
    const j4 = await jobOf(who, d3.id);
    await api().post(`/api/arbitration/jobs/${j4.id}/accept`).set(auth(who.token)).send({ visitAt: 'دوشنبه', impartial: true }).expect(200);
    await report(who, j4.id, 3).expect(201);
    await db.update(arbitrationCases).set({ appealUntil: new Date(Date.now() - 1000) }).where(eq(arbitrationCases.id, j4.id));
    const late = await api().post(`/api/disputes/${d3.id}/appeal`).set(auth(p3.w.token)).send({ reason: 'اعتراض بعد از پایان مهلت اعتراض' });
    expect(late.status).toBe(409);
    dv = (await api().get(`/api/disputes/${d3.id}`).set(auth(p3.w.token))).body.dispute;
    expect(dv.status).toBe('decided');

    const stats = await api().get('/api/admin/arbitration/stats').set(auth(adm.token));
    expect(stats.body).toHaveProperty('arbitersPending');
  });

  it('impartiality: an arbiter who worked with a party is never offered the case', async () => {
    const adm = await admin();
    const A = await arbiter(adm);
    await onlyArbiter(A.arbiterId);
    const { boss, w, pid } = await makeProject();
    // حل‌کننده قبلاً با کارفرما گفت‌وگو داشته
    await api().post('/api/conversations').set(auth(A.token)).send({ profileCode: boss.profile.code }).expect(201);
    const d = (await api().post(`/api/projects/${pid}/disputes`).set(auth(w.token)).send({ reason: 'کیفیت کار', ask: 'اصلاح کار', description: 'کیفیت قالب‌بندی ستون‌ها پایین است.' })).body.dispute;
    await endTalk(d.id);
    const q = await api().get(`/api/disputes/${d.id}/quote?field=struct&amountMillion=20`).set(auth(w.token));
    const before = q.body.quote.available;
    const r = await api().post(`/api/disputes/${d.id}/arbitration`).set(auth(w.token)).send({ field: 'struct', amountMillion: 20, agree: true });
    await api().post(`/api/admin/arbitration/cases/${r.body.dispute.case.id}/confirm-payment`).set(auth(adm.token)).send({ ref: 'ref-4' }).expect(200);
    // تنها حل‌کنندهٔ فعال با کارفرما گفت‌وگو داشته ← در دسترس نیست و پرونده منتظر تعیین دستی ادمین می‌ماند
    expect(before).toBe(0);
    expect(await jobOf(A, d.id)).toBeUndefined();
    const waiting = await api().get('/api/admin/arbitration/cases?status=matching').set(auth(adm.token));
    expect(waiting.body.items.some((c: { dispute: { id: string } }) => c.dispute.id === d.id)).toBe(true);
  });
});
