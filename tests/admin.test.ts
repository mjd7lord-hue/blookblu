import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { documents, users } from '../src/db/schema';
import { recomputeVerified } from '../src/modules/admin/admin.service';
import { api, auth, registered , multiRole } from './helpers';
import { beforeAll, afterAll } from 'vitest';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF', 'latin1');

async function admin() {
  const a = await registered('general');
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, a.profile.userId));
  return a;
}

const sendKyc = (token: string, fields: Record<string, string> = {}) => {
  const q = api().post('/api/me/kyc').set(auth(token));
  for (const [k, v] of Object.entries(fields)) q.field(k, v);
  return q.attach('card', JPEG, 'card.jpg').attach('selfie', JPEG, 'selfie.jpg');
};

describe('KYC and admin panel', () => {
  beforeAll(() => multiRole(true));
  afterAll(() => multiRole(false));
  it('KYC: submit → admin reviews with signed images → verified, name locked, images removed', async () => {
    const w = await registered('worker');
    const adm = await admin();

    // فقط یک عکس
    const one = await api().post('/api/me/kyc').set(auth(w.token)).attach('card', JPEG, 'c.jpg');
    expect(one.body.error.code).toBe('NO_FILE');
    const badCode = await sendKyc(w.token, { idNumber: '1234567890' });
    expect(badCode.body.error.code).toBe('NATIONAL_CODE_INVALID');

    const sub = await sendKyc(w.token, { idNumber: '۰۰۴۹۳۱۲۱۳۸' });
    expect(sub.status).toBe(201);
    expect(sub.body.status).toBe('pending');
    expect(sub.body.request.idNumberMasked).toBe('004****138');
    expect((await sendKyc(w.token)).body.error.code).toBe('KYC_PENDING');
    expect((await api().get('/api/me/kyc').set(auth(w.token))).body.status).toBe('pending');

    // کاربر عادی به پنل دسترسی ندارد
    const deny = await api().get('/api/admin/stats').set(auth(w.token));
    expect(deny.status).toBe(403);
    expect(deny.body.error.code).toBe('NOT_ADMIN');

    const st = await api().get('/api/admin/stats').set(auth(adm.token));
    expect(st.body.pending.kyc).toBeGreaterThanOrEqual(1);

    const list = await api().get('/api/admin/kyc').set(auth(adm.token));
    const k = list.body.items.find((x: { user: { id: string } }) => x.user.id === w.profile.userId);
    expect(k.idNumber).toBe('0049312138');
    expect(k.firstName).toBe('رضا');
    expect((await api().get(k.cardUrl)).status).toBe(200);
    const bare = k.selfieUrl.split('?')[0];
    expect((await api().get(bare).set(auth(adm.token))).status).toBe(200);
    expect((await api().get(bare).set(auth(w.token))).status).toBe(200); // صاحب عکس
    const other = await registered('worker');
    expect((await api().get(bare).set(auth(other.token))).status).toBe(404);

    // تأیید با اصلاح نام خانوادگی مطابق کارت
    const ok = await api().post(`/api/admin/kyc/${k.id}/approve`).set(auth(adm.token)).send({ lastName: 'بهمنی‌نژاد' });
    expect(ok.status).toBe(200);
    expect((await api().post(`/api/admin/kyc/${k.id}/approve`).set(auth(adm.token)).send({})).body.error.code).toBe('NOT_PENDING');

    const me = await api().get('/api/me').set(auth(w.token));
    expect(me.body.user.kycStatus).toBe('verified');
    expect(me.body.user.lastName).toBe('بهمنی‌نژاد');
    const pub = await api().get(`/api/profiles/${w.profile.code}`);
    expect(pub.body.profile.identityVerified).toBe(true);
    expect(pub.body.profile.trust.identity).toBe(10);
    expect(pub.body.profile.name).toBe('رضا بهمنی‌نژاد');

    // عکس‌های کارت بعد از بررسی پاک شده‌اند
    expect((await api().get(k.cardUrl)).status).toBe(404);
    // نام بعد از تأیید قفل است
    const rename = await api().patch('/api/me/roles/worker').set(auth(w.token)).send({ data: { fn: 'علی' } });
    expect(rename.body.error.code).toBe('KYC_LOCKED');
    expect((await sendKyc(w.token)).body.error.code).toBe('KYC_DONE');

    const notifs = await api().get('/api/notifications').set(auth(w.token));
    expect(JSON.stringify(notifs.body)).toContain('هویت شما تأیید شد');
  });

  it('KYC: reject allows resubmit; duplicate national code needs force', async () => {
    const adm = await admin();
    const a = await registered('specialist');
    const b = await registered('contractor');

    await sendKyc(a.token, { idNumber: '1234567891' }).expect(201);
    let items = (await api().get('/api/admin/kyc').set(auth(adm.token))).body.items;
    const ka = items.find((x: { user: { id: string } }) => x.user.id === a.profile.userId);
    expect((await api().post(`/api/admin/kyc/${ka.id}/reject`).set(auth(adm.token)).send({ reason: 'x' })).status).toBe(400);
    await api().post(`/api/admin/kyc/${ka.id}/reject`).set(auth(adm.token)).send({ reason: 'تصویر کارت خوانا نیست' }).expect(200);
    const mine = await api().get('/api/me/kyc').set(auth(a.token));
    expect(mine.body.status).toBe('rejected');
    expect(mine.body.request.rejectReason).toBe('تصویر کارت خوانا نیست');

    // دوباره می‌فرستد و تأیید می‌شود
    await sendKyc(a.token, { idNumber: '1234567891' }).expect(201);
    items = (await api().get('/api/admin/kyc').set(auth(adm.token))).body.items;
    const ka2 = items.find((x: { user: { id: string } }) => x.user.id === a.profile.userId);
    await api().post(`/api/admin/kyc/${ka2.id}/approve`).set(auth(adm.token)).send({}).expect(200);

    // حساب دوم با همان کد ملی
    await sendKyc(b.token, { idNumber: '1234567891' }).expect(201);
    items = (await api().get('/api/admin/kyc').set(auth(adm.token))).body.items;
    const kb = items.find((x: { user: { id: string } }) => x.user.id === b.profile.userId);
    expect(kb.duplicates).toHaveLength(1);
    expect(kb.duplicates[0].phone).toBe(a.phone);
    const dup = await api().post(`/api/admin/kyc/${kb.id}/approve`).set(auth(adm.token)).send({});
    expect(dup.body.error.code).toBe('KYC_DUPLICATE');
    await api().post(`/api/admin/kyc/${kb.id}/approve`).set(auth(adm.token)).send({ force: true }).expect(200);

    // اتباع: شمارهٔ مدرک اقامت
    const f = await registered('worker');
    const fr = await sendKyc(f.token, { idType: 'foreign', idNumber: 'AF12345678' });
    expect(fr.status).toBe(201);
    expect(fr.body.request.idType).toBe('foreign');
  });

  it('documents: approve → verified badge; revoke and expiry remove it', async () => {
    const adm = await admin();
    const e = await registered('engineer');
    const up = await api()
      .post('/api/me/documents')
      .set(auth(e.token))
      .field('title', 'پروانهٔ اشتغال نظام مهندسی')
      .field('role', 'engineer')
      .attach('file', PDF, 'license.pdf');
    const docId = up.body.document.id;

    const list = await api().get('/api/admin/documents').set(auth(adm.token));
    const d = list.body.items.find((x: { id: string }) => x.id === docId);
    expect(d.profile.code).toBe(e.profile.code);
    expect(d.user.phone).toBe(e.phone);
    expect((await api().get(d.file.url)).status).toBe(200);

    expect((await api().post(`/api/admin/documents/${docId}/approve`).set(auth(adm.token)).send({ expiresAt: '2020-01-01' })).body.error.code).toBe('EXPIRED');
    await api().post(`/api/admin/documents/${docId}/approve`).set(auth(adm.token)).send({ expiresAt: '2099-01-01' }).expect(200);
    expect((await api().get(`/api/profiles/${e.profile.code}`)).body.profile.verified).toBe(true);
    const mine = (await api().get('/api/me/documents').set(auth(e.token))).body.items[0];
    expect(mine.status).toBe('approved');
    expect(mine.expiresAt).toContain('2099-01-01');
    expect((await api().delete(`/api/me/documents/${docId}`).set(auth(e.token))).body.error.code).toBe('DOCUMENT_APPROVED');

    // انقضا → نشان برداشته می‌شود
    await db.update(documents).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(documents.id, docId));
    await recomputeVerified();
    expect((await api().get(`/api/profiles/${e.profile.code}`)).body.profile.verified).toBe(false);

    // تأیید دوباره بدون انقضا، بعد لغو تأیید
    await db.update(documents).set({ status: 'pending' }).where(eq(documents.id, docId));
    await api().post(`/api/admin/documents/${docId}/approve`).set(auth(adm.token)).send({}).expect(200);
    expect((await api().get(`/api/profiles/${e.profile.code}`)).body.profile.verified).toBe(true);
    await api().post(`/api/admin/documents/${docId}/reject`).set(auth(adm.token)).send({ reason: 'پروانه باطل شده است' }).expect(200);
    expect((await api().get(`/api/profiles/${e.profile.code}`)).body.profile.verified).toBe(false);

    const acts = await api().get(`/api/admin/actions?targetId=${docId}`).set(auth(adm.token));
    expect(acts.body.items.map((a: { action: string }) => a.action)).toEqual(['document.revoke', 'document.approve', 'document.approve']);
  });

  it('reports, suspension, ad removal, user search', async () => {
    const adm = await admin();
    const bad = await registered('contractor');
    const victim = await registered('worker');

    const ad = await api()
      .post('/api/ads')
      .set(auth(bad.token))
      .send({ type: 'job', title: 'نیاز فوری به کارگر', province: 'هرمزگان', city: 'قشم', audience: ['worker'] });
    expect(ad.status).toBe(201);
    const adId = ad.body.ad.id;

    await api()
      .post('/api/reports')
      .set(auth(victim.token))
      .send({ profileCode: bad.profile.code, reason: 'کلاهبرداری یا درخواست پیش‌پرداخت', details: 'پیش‌پرداخت خواست' })
      .expect(201);
    await api().post('/api/reports').set(auth(victim.token)).send({ adId, reason: 'آگهی تکراری یا اسپم' }).expect(201);

    const reps = await api().get('/api/admin/reports').set(auth(adm.token));
    const mine = reps.body.items.filter((x: { target: { code: string } | null }) => x.target?.code === bad.profile.code);
    expect(mine).toHaveLength(2);
    expect(mine[0].target.reportsCount).toBe(2);
    expect(mine[0].reporter.phone).toBe(victim.phone);
    expect(mine.find((x: { ad: unknown }) => x.ad).ad.title).toBe('نیاز فوری به کارگر');

    const upd = await api().patch(`/api/admin/reports/${mine[0].id}`).set(auth(adm.token)).send({ status: 'resolved', note: 'حساب مسدود شد' });
    expect(upd.body.report.status).toBe('resolved');
    expect(JSON.stringify((await api().get('/api/notifications').set(auth(victim.token))).body)).toContain('گزارش شما بررسی شد');

    // حذف آگهی
    await api().post(`/api/admin/ads/${adId}/remove`).set(auth(adm.token)).send({ reason: 'آگهی تکراری' }).expect(200);
    expect((await api().get(`/api/ads/${adId}`)).status).toBe(404);

    // جست‌وجوی کاربر با کد، شماره و نام
    const byCode = await api().get(`/api/admin/users?q=${bad.profile.code}`).set(auth(adm.token));
    expect(byCode.body.items[0].id).toBe(bad.profile.userId);
    const byPhone = await api().get(`/api/admin/users?q=${bad.phone.slice(-7)}`).set(auth(adm.token));
    expect(byPhone.body.items.map((u: { id: string }) => u.id)).toContain(bad.profile.userId);

    // مسدودسازی: نشست‌ها بسته، دسترسی قطع
    await api().post(`/api/admin/users/${bad.profile.userId}/suspend`).set(auth(adm.token)).send({ reason: 'کلاهبرداری' }).expect(200);
    const blocked = await api().get('/api/me').set(auth(bad.token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('SUSPENDED');
    expect((await api().post('/api/auth/refresh').send({ refreshToken: bad.refresh })).status).not.toBe(200);
    expect((await api().get(`/api/profiles/${bad.profile.code}`)).status).toBe(404);

    // ادمین خودش یا ادمین دیگر را مسدود نمی‌کند
    expect((await api().post(`/api/admin/users/${adm.profile.userId}/suspend`).set(auth(adm.token)).send({ reason: 'آزمایش' })).body.error.code).toBe('SELF');

    const detail = await api().get(`/api/admin/users/${bad.profile.userId}`).set(auth(adm.token));
    expect(detail.body.user.status).toBe('suspended');
    expect(detail.body.reportsAgainst).toHaveLength(2);
    expect(detail.body.actions[0].action).toBe('user.suspend');

    await api().post(`/api/admin/users/${bad.profile.userId}/unsuspend`).set(auth(adm.token)).send({}).expect(200);
    expect((await api().get('/api/me').set(auth(bad.token))).status).toBe(200);
  });
});
