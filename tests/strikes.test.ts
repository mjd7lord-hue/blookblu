import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { strikes, users } from '../src/db/schema';
import { sweepStrikes } from '../src/modules/trust/strikes';
import { api, auth, makeGuarantor, makeProject, signBoth } from './helpers';

const trustOf = async (code: string) => (await api().get(`/api/profiles/${code}`)).body.profile;

describe('bad faith (بدقولی): report, reply, mutual/unilateral cancel, guarantor penalty', () => {
  it('no-show report → dispute → admin dismisses; accept → −10 and guarantor −5', async () => {
    const { boss, w, pid } = await makeProject();
    // قبل از امضای دوطرفه بدقولی ثبت نمی‌شود
    expect((await api().post(`/api/projects/${pid}/report`).set(auth(boss.token)).send({ kind: 'no_show', note: 'صبح دوشنبه نیامد' })).body.error.code).toBe('NOT_SIGNED');
    await signBoth(pid, boss, w);

    // قیم برای متخصص
    await makeGuarantor(boss.phone);
    const gq = await api().post('/api/guarantees').set(auth(w.token)).send({ name: 'پیمانکار', phone: boss.phone });
    expect(gq.status).toBe(201);
    const code = await api().post(`/api/guarantees/${gq.body.guarantee.id}/code`).set(auth(boss.token));
    await api().patch(`/api/guarantees/${gq.body.guarantee.id}`).set(auth(boss.token)).send({ status: 'accepted', code: code.body.devCode }).expect(200);
    const t0 = (await trustOf(w.profile.code)).trust;
    expect(t0.adj).toBe(5);
    const g0 = (await trustOf(boss.profile.code)).trust.total;

    const rep = await api().post(`/api/projects/${pid}/report`).set(auth(boss.token)).send({ kind: 'no_show', note: 'صبح دوشنبه نیامد و جواب نداد' });
    expect(rep.status).toBe(201);
    expect(rep.body.strike.status).toBe('pending');
    expect((await api().post(`/api/projects/${pid}/report`).set(auth(boss.token)).send({ kind: 'no_show', note: 'دوباره' })).body.error.code).toBe('STRIKE_EXISTS');

    const mine = await api().get('/api/strikes').set(auth(w.token));
    expect(mine.body.against).toHaveLength(1);
    // اعتراض بدون توضیح قبول نیست
    expect((await api().post(`/api/strikes/${rep.body.strike.id}/respond`).set(auth(w.token)).send({ accept: false })).body.error.code).toBe('REPLY_REQUIRED');
    // غریبه نمی‌تواند جواب دهد
    expect((await api().post(`/api/strikes/${rep.body.strike.id}/respond`).set(auth(boss.token)).send({ accept: true })).status).toBe(404);
    await api().post(`/api/strikes/${rep.body.strike.id}/respond`).set(auth(w.token)).send({ accept: true, reply: 'ماشینم خراب شد' }).expect(200);

    const p1 = await trustOf(w.profile.code);
    expect(p1.strikes).toBe(1);
    expect(p1.trust.adj).toBe(5 - 10);
    // قیم هم ۵ امتیاز از دست داد
    expect((await trustOf(boss.profile.code)).trust.total).toBe(Math.max(0, g0 - 5));

    // بعد از بدقولی ثابت‌شده، کارفرما بدون اخطار لغو می‌کند
    const c = await api().post(`/api/projects/${pid}/cancel`).set(auth(boss.token)).send({ reason: 'نیرو نیامد' });
    expect(c.body.project.status).toBe('cancelled');
    expect(c.body.strike).toBe(false);
  });

  it('signed contract: cancel = request; other accepts = no strike; force = strike on canceller', async () => {
    const a = await makeProject();
    await signBoth(a.pid, a.boss, a.w);
    const req = await api().post(`/api/projects/${a.pid}/cancel`).set(auth(a.w.token)).send({ reason: 'کار دیگری گرفتم' });
    expect(req.status).toBe(202);
    expect(req.body.project.cancelReq.mine).toBe(true);
    const seen = await api().get(`/api/projects/${a.pid}`).set(auth(a.boss.token));
    expect(seen.body.project.cancelReq.mine).toBe(false);
    const ok = await api().post(`/api/projects/${a.pid}/cancel/answer`).set(auth(a.boss.token)).send({ accept: true });
    expect(ok.body.mutual).toBe(true);
    expect(ok.body.project.status).toBe('cancelled');
    expect((await trustOf(a.w.profile.code)).strikes).toBe(0);

    const b = await makeProject();
    await signBoth(b.pid, b.boss, b.w);
    await api().post(`/api/projects/${b.pid}/cancel`).set(auth(b.w.token)).send({ reason: 'نمی‌آیم' }).expect(202);
    // کارفرما رد می‌کند ← درخواست پاک می‌شود
    const no = await api().post(`/api/projects/${b.pid}/cancel/answer`).set(auth(b.boss.token)).send({ accept: false });
    expect(no.body.project.cancelReq).toBeNull();
    const f = await api().post(`/api/projects/${b.pid}/cancel`).set(auth(b.w.token)).send({ reason: 'نمی‌آیم', force: true });
    expect(f.body.strike).toBe(true);
    expect((await trustOf(b.w.profile.code)).strikes).toBe(1);
  });

  it('silence for 24h = confirmed; 3 strikes in 60 days = no ready-to-work; admin can dismiss', async () => {
    const a = await makeProject();
    await signBoth(a.pid, a.boss, a.w);
    const rep = await api().post(`/api/projects/${a.pid}/report`).set(auth(a.boss.token)).send({ kind: 'breach', note: 'کار را نیمه رها کرد' });
    await db.update(strikes).set({ respondBy: new Date(Date.now() - 1000) }).where(eq(strikes.id, rep.body.strike.id));
    await sweepStrikes();
    expect((await trustOf(a.w.profile.code)).strikes).toBe(1);

    // کارفرما بعد از بدقولی، بدون اخطار لغو می‌کند؛ بعد اخطار دوم برای همان متخصص در پروژهٔ دیگر
    expect((await api().post(`/api/projects/${a.pid}/cancel`).set(auth(a.boss.token)).send({ reason: 'کار رها شد' })).body.strike).toBe(false);
    const boss2 = a.boss;
    // اخطار دوم و سوم: لغو یک‌طرفهٔ دو قرارداد امضاشدهٔ دیگر
    const forceCancel = async (job: string) => {
      const c = await api().post('/api/conversations').set(auth(boss2.token)).send({ profileCode: a.w.profile.code });
      const deal = await api()
        .post(`/api/conversations/${c.body.conversation.id}/deals`)
        .set(auth(a.w.token))
        .send({ job, price: '۵٬۰۰۰٬۰۰۰ تومان', amount: '۵٬۰۰۰٬۰۰۰', start: 'شنبه', durationDays: 2, plan: [{ title: 'پایان کار', pct: 100 }] });
      if (!deal.body.message) throw new Error(JSON.stringify(deal.body));
      const acc = await api().post(`/api/messages/${deal.body.message.id}/answer`).set(auth(boss2.token)).send({ status: 'accepted' });
      const pid = acc.body.project.id;
      await signBoth(pid, boss2, a.w);
      await api().post(`/api/projects/${pid}/cancel`).set(auth(a.w.token)).send({ reason: 'نمی‌رسم', force: true }).expect(200);
    };
    await forceCancel('کاشی‌کاری');
    // ۲ اخطار هنوز «آماده به کار» را نمی‌بندد
    const ok2 = await api().post('/api/ads').set(auth(a.w.token)).send({ type: 'work', title: 'آماده به کار آرماتور', province: 'هرمزگان', city: 'قشم', audience: ['contractor'] });
    expect(ok2.status).toBe(201);
    await api().patch(`/api/ads/${ok2.body.ad.id}`).set(auth(a.w.token)).send({ status: 'closed' }).expect(200);
    await forceCancel('سنگ‌کاری');

    const ready = await api().post('/api/ads').set(auth(a.w.token)).send({ type: 'work', title: 'آماده به کار کاشی', province: 'هرمزگان', city: 'قشم', audience: ['contractor'] });
    expect(ready.body.error.code).toBe('RESTRICTED');

    // مدیر اخطار اول را رد می‌کند
    const [o] = await db.update(users).set({ isAdmin: true }).where(eq(users.id, a.boss.profile.userId)).returning();
    expect(o.isAdmin).toBe(true);
    const snap = await api().get('/api/admin/panel/snapshot').set(auth(a.boss.token));
    expect(snap.body.strikes.length).toBeGreaterThanOrEqual(3);
    await api().post(`/api/admin/panel/strikes/${rep.body.strike.id}/decide`).set(auth(a.boss.token)).send({ confirm: false, note: 'مدرک کافی نبود' }).expect(200);
    expect((await trustOf(a.w.profile.code)).strikes).toBe(2);
  });

  it('my contracts archive and locked main info', async () => {
    const { boss, w, pid } = await makeProject();
    await api().get(`/api/projects/${pid}/contract`).set(auth(boss.token)).expect(200);
    await signBoth(pid, boss, w);
    const list = await api().get('/api/me/contracts').set(auth(w.token));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ status: 'active', myRole: 'provider', signed: { client: true, provider: true } });
    expect(list.body.items[0].printUrl).toContain('/print?');

    const ren = await api().patch('/api/me/roles/specialist').set(auth(w.token)).send({ data: { fn: 'علی' } });
    expect(ren.body.error.code).toBe('FIELD_LOCKED');
    // فیلد فرعی آزاد است
    expect((await api().patch('/api/me/roles/specialist').set(auth(w.token)).send({ data: { city: 'قشم' } })).status).toBe(200);
  });
});
