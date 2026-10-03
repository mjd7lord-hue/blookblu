import { describe, it, expect } from 'vitest';
import { api, auth, makeProject } from './helpers';

// دو عکس متفاوت (هش متفاوت)
const img = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, n, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);

describe('payment receipts: documented transfers, anti-fake checks, contract appendix', () => {
  it('receipt + tracking number → other side confirms → documented; duplicates and future dates rejected', async () => {
    const { boss, w, pid } = await makeProject();
    const p1 = await api().post(`/api/projects/${pid}/payments`).set(auth(boss.token)).send({ amount: '۲٬۰۰۰٬۰۰۰', label: 'پیش‌پرداخت', milestoneIndex: 0, trackingNo: '۱۲۳-۴۵۶-۷۸۹' });
    expect(p1.status).toBe(201);
    expect(p1.body.payment.trackingNo).toBe('123456789');
    expect(p1.body.payment.checks).toEqual(expect.arrayContaining(['NO_RECEIPT', 'AMOUNT_MISMATCH']));
    expect(p1.body.payment.can.receipt).toBe(true);
    const id = p1.body.payment.id;

    // همان شمارهٔ پیگیری دوباره ← رد
    const dupT = await api().post(`/api/projects/${pid}/payments`).set(auth(boss.token)).send({ amount: 1_000_000, label: 'سایر', trackingNo: '123456789' });
    expect(dupT.body.error.code).toBe('DUP_TRACKING');
    // تاریخ آینده ← رد
    const fut = await api().post(`/api/projects/${pid}/payments`).set(auth(boss.token)).send({ amount: 1_000_000, label: 'سایر', paidOn: '2099-01-01' });
    expect(fut.body.error.code).toBe('FUTURE_PAYMENT');

    // رسید: فقط ثبت‌کننده
    expect((await api().post(`/api/payments/${id}/receipt`).set(auth(w.token)).attach('file', img(1), 'r.jpg')).body.error.code).toBe('NOT_OWNER');
    const r = await api().post(`/api/payments/${id}/receipt`).set(auth(boss.token)).field('bank', 'ملت').attach('file', img(1), 'r.jpg');
    expect(r.status).toBe(200);
    expect(r.body.payment.receiptUrl).toMatch(/\/api\/files\/.+sig=/);
    expect(r.body.payment.checks).not.toContain('NO_RECEIPT');

    // همان رسید برای پرداخت دیگر ← رد
    const p2 = await api().post(`/api/projects/${pid}/payments`).set(auth(boss.token)).send({ amount: 500_000, label: 'سایر' });
    const dupR = await api().post(`/api/payments/${p2.body.payment.id}/receipt`).set(auth(boss.token)).attach('file', img(1), 'r.jpg');
    expect(dupR.body.error.code).toBe('DUP_RECEIPT');

    // طرف مقابل رسید را می‌بیند و تأیید می‌کند ← «مستند»
    const list = await api().get(`/api/projects/${pid}/payments`).set(auth(w.token));
    const it1 = list.body.items.find((x: { id: string }) => x.id === id);
    expect(it1.receiptUrl).toBeTruthy();
    expect(it1.can.respond).toBe(true);
    const c = await api().post(`/api/payments/${id}/confirm`).set(auth(w.token));
    expect(c.body.payment).toMatchObject({ status: 'confirmed', documented: true });
    // بعد از تأیید، رسید عوض نمی‌شود
    expect((await api().post(`/api/payments/${id}/receipt`).set(auth(boss.token)).attach('file', img(2), 'r2.jpg')).body.error.code).toBe('PAYMENT_LOCKED');

    // پیوست قرارداد چاپی
    const ctr = await api().get(`/api/projects/${pid}/contract`).set(auth(boss.token));
    const pu = new URL(ctr.body.contract.printUrl, 'http://x');
    const html = await api().get(pu.pathname + pu.search);
    expect(html.text).toContain('پرداخت‌های ثبت‌شده');
    expect(html.text).toContain('123456789');
  });
});
