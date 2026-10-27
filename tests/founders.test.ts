import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { founders, guarantees, users } from '../src/db/schema';
import { api, auth, FORMS, login, registered } from './helpers';

async function admin() {
  const a = await registered('general');
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, a.profile.userId));
  return a;
}
const verify = (userId: string) => db.update(users).set({ kycStatus: 'verified' }).where(eq(users.id, userId));
/** ثبت‌نام با کد دعوت (فیلد «معرف»؛ اپ از لینک blooko.ir/i/کد پرش می‌کند) */
async function invitedSignup(code: string) {
  const u = await login();
  const r = await api().post('/api/me/roles').set(auth(u.token)).send({ role: 'worker', data: { ...FORMS.worker, ref: code } });
  expect(r.status).toBe(201);
  return { ...u, profile: r.body.profile };
}
const setCfg = (adm: { token: string }, v: Record<string, unknown>) =>
  api().put('/api/admin/panel/config/founders').set(auth(adm.token)).send({ value: { on: true, cap: 100, perks: ['نشان بنیان‌گذار'], igUrl: 'https://instagram.com/blooko.ir', ...v } });

let adm: { token: string };
afterAll(async () => { if (adm) await setCfg(adm, {}); });

describe('founders campaign (round 54)', () => {
  it('3 steps → founder number, invite rules, guarantor request, badge', async () => {
    adm = await admin();
    const pub = (await api().get('/api/founders')).body;
    expect(pub).toMatchObject({ on: true, open: true, cap: 100 });
    expect(pub.me).toBeUndefined();

    const a = await registered('contractor');
    const s0 = (await api().get('/api/founders').set(auth(a.token))).body.me;
    expect(s0).toMatchObject({ done: 0, number: null, inviteCode: a.profile.code, steps: { follow: false, kyc: false, invite: false } });

    // ۱) فالو: بدون بررسی، زمان ذخیره می‌شود
    const f1 = (await api().post('/api/founders/follow').set(auth(a.token))).body.me;
    expect(f1.steps.follow).toBe(true);
    expect(new Date(f1.followedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // ۲) احراز هویت
    await verify(a.profile.userId);
    expect((await api().get('/api/founders').set(auth(a.token))).body.me).toMatchObject({ done: 2, number: null });

    // ۳) دوست با کد دعوت ثبت‌نام می‌کند ← شماره بنیان‌گذار
    const b = await invitedSignup(a.profile.code);
    const s3 = (await api().get('/api/founders').set(auth(a.token))).body.me;
    expect(s3).toMatchObject({ done: 3, invites: 1 });
    expect(s3.number).toBeGreaterThanOrEqual(1);
    const years = (new Date(s3.commissionFreeUntil).getTime() - new Date(s3.assignedAt).getTime()) / (365 * 86400_000);
    expect(years).toBeGreaterThan(1.99);
    expect(years).toBeLessThan(2.01);
    // دعوت‌کننده = پیشنهاد قیم دوست (با تأیید پیامکی خودش)
    const [g] = await db.select().from(guarantees).where(eq(guarantees.profileId, b.profile.id));
    expect(g).toMatchObject({ guarantorUserId: a.profile.userId, status: 'pending' });
    // دعوت تکراری از همان نفر حساب نمی‌شود: نقش دوم با کد دیگری، دعوت‌کننده عوض نمی‌شود
    const other = await registered('engineer');
    const [bu0] = await db.select({ inv: users.invitedBy }).from(users).where(eq(users.id, b.profile.userId));
    expect(bu0.inv).toBe(a.profile.userId);
    await api().post('/api/me/roles').set(auth(b.token)).send({ role: 'specialist', data: { ...FORMS.specialist, ref: other.profile.code } });
    expect((await db.select({ inv: users.invitedBy }).from(users).where(eq(users.id, b.profile.userId)))[0].inv).toBe(a.profile.userId);
    // شماره ثابت می‌ماند
    expect((await api().get('/api/founders').set(auth(a.token))).body.me.number).toBe(s3.number);

    // نشان روی پروفایل عمومی
    expect((await api().get(`/api/profiles/${a.profile.code}`)).body.profile.founder).toBe(s3.number);
    expect((await api().get(`/api/profiles/${b.profile.code}`)).body.profile.founder).toBeNull();

    // پنل: فهرست، دعوت‌کننده، آمار، لغو و اعطای دستی
    const list = await api().get('/api/admin/panel/founders').set(auth(adm.token));
    expect(list.status).toBe(200);
    const ra = list.body.items.find((x: { id: string }) => x.id === a.profile.userId);
    expect(ra).toMatchObject({ number: s3.number, invites: 1, steps: { follow: true, kyc: true, invite: true }, role: 'contractor' });
    const rb = list.body.items.find((x: { id: string }) => x.id === b.profile.userId);
    expect(rb.inviter).toMatchObject({ code: a.profile.code });
    expect(list.body.stats.done).toBeGreaterThanOrEqual(1);
    expect(list.body.stats.cap).toBe(100);

    await api().post(`/api/admin/panel/founders/${a.profile.userId}/revoke`).set(auth(adm.token)).expect(200);
    expect((await api().get('/api/founders').set(auth(a.token))).body.me).toMatchObject({ number: null, revoked: true });
    const gr = await api().post(`/api/admin/panel/founders/${b.profile.userId}/grant`).set(auth(adm.token));
    expect(gr.body.number).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(founders).where(eq(founders.userId, b.profile.userId)))[0].manual).toBe(true);
    const w = await registered('worker');
    expect((await api().get('/api/admin/panel/founders').set(auth(w.token))).status).toBe(403);
  });

  it('simultaneous completions get unique numbers; full ← campaign closes', async () => {
    const taken = (await api().get('/api/founders')).body.taken;
    // ۵ نفر همزمان آماده‌اند، ولی فقط ۳ جا مانده
    expect((await setCfg(adm, { cap: taken + 3 })).status).toBe(200);
    const people = [];
    for (let i = 0; i < 5; i++) {
      const p = await registered('worker');
      await api().post('/api/founders/follow').set(auth(p.token)).expect(200);
      await verify(p.profile.userId);
      await invitedSignup(p.profile.code);
      people.push(p);
    }
    const res = await Promise.all(people.map((p) => api().get('/api/founders').set(auth(p.token))));
    const nums = res.map((r) => r.body.me.number).filter((n) => n != null);
    expect(nums).toHaveLength(3);
    expect(new Set(nums).size).toBe(3);
    const st = (await api().get('/api/founders')).body;
    expect(st).toMatchObject({ open: false, left: 0 });
    // خاموش کردن کمپین
    await setCfg(adm, { on: false });
    expect((await api().get('/api/founders')).body).toMatchObject({ on: false, open: false });
  });
});
