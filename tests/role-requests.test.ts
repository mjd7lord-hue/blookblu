import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { users } from '../src/db/schema';
import { api, auth, registered, FORMS } from './helpers';

async function owner() {
  const a = await registered('general');
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, a.profile.userId));
  return a;
}

describe('role change requests (app → admin panel → app)', () => {
  it('worker asks to switch to contractor; admin approves; worker fills the form; old role hidden', async () => {
    const o = await owner();
    const w = await registered('worker');

    // بدون تأیید، نقش دوم قفل است
    expect((await api().post('/api/me/roles').set(auth(w.token)).send({ role: 'contractor', data: FORMS.contractor })).body.error.code).toBe('ROLE_LOCKED');

    const rq = await api().post('/api/me/role-requests').set(auth(w.token)).send({ toRole: 'contractor', note: 'تیم گرفته‌ام' });
    expect(rq.status).toBe(201);
    expect(rq.body.request).toMatchObject({ fromRole: 'worker', toRole: 'contractor', mode: 'switch', status: 'pending' });
    expect((await api().post('/api/me/role-requests').set(auth(w.token)).send({ toRole: 'specialist' })).body.error.code).toBe('ROLE_REQUEST_OPEN');
    expect((await api().post('/api/me/role-requests').set(auth(w.token)).send({ toRole: 'worker' })).body.error.code).toBe('ROLE_EXISTS');

    // پنل: فهرست و تأیید
    const snap = await api().get('/api/admin/panel/snapshot').set(auth(o.token));
    const row = snap.body.roleRequests.find((x: { id: string }) => x.id === rq.body.request.id);
    expect(row).toMatchObject({ status: 'pending', toRole: 'contractor', user: { phone: w.phone } });
    expect(snap.body).toHaveProperty('urgent');
    // کاربر عادی نمی‌تواند تأیید کند
    expect((await api().post(`/api/admin/panel/role-requests/${rq.body.request.id}/approve`).set(auth(w.token)).send({})).body.error.code).toBe('NOT_ADMIN');
    const ap = await api().post(`/api/admin/panel/role-requests/${rq.body.request.id}/approve`).set(auth(o.token)).send({ note: 'مدارک پیمانکاری را بعداً بفرست' });
    expect(ap.body.request.status).toBe('approved');
    expect((await api().post(`/api/admin/panel/role-requests/${rq.body.request.id}/approve`).set(auth(o.token)).send({})).body.error.code).toBe('NOT_PENDING');

    // اپ: نقش باز است، اعلان آمد
    const me = await api().get('/api/me').set(auth(w.token));
    expect(me.body.user.roleUnlock).toBe('contractor');
    const n = await api().get('/api/notifications').set(auth(w.token));
    expect(n.body.items[0].title).toContain('پیمانکار');

    // فرم نقش ← نقش تازه فعال، قبلی پنهان، درخواست انجام شد
    const add = await api().post('/api/me/roles').set(auth(w.token)).send({ role: 'contractor', data: FORMS.contractor });
    expect(add.status).toBe(201);
    const me2 = await api().get('/api/me').set(auth(w.token));
    expect(me2.body.user).toMatchObject({ activeRole: 'contractor', roleUnlock: null });
    expect(me2.body.profiles.find((p: { role: string }) => p.role === 'worker').isPublic).toBe(false);
    const list = await api().get('/api/me/role-requests').set(auth(w.token));
    expect(list.body.items[0].status).toBe('done');
    // باز شدن یک‌بار مصرف است
    expect((await api().post('/api/me/roles').set(auth(w.token)).send({ role: 'specialist', data: FORMS.specialist })).body.error.code).toBe('ROLE_LOCKED');
    // ردپای مدیر
    const audit = (await api().get('/api/admin/panel/snapshot').set(auth(o.token))).body.audit;
    expect(audit.some((x: { action: string }) => x.action === 'role_request_approve')).toBe(true);
  });

  it('reject with reason, and direct role unlock from the panel (add mode keeps the old role public)', async () => {
    const o = await owner();
    const w = await registered('specialist');
    const rq = await api().post('/api/me/role-requests').set(auth(w.token)).send({ toRole: 'engineer' });
    expect((await api().post(`/api/admin/panel/role-requests/${rq.body.request.id}/reject`).set(auth(o.token)).send({ reason: 'مدرک مهندسی نداری' })).body.request.status).toBe('rejected');
    expect((await api().get('/api/me').set(auth(w.token))).body.user.roleUnlock).toBeNull();

    const d = await api().post(`/api/admin/panel/users/${w.profile.userId}/role-unlock`).set(auth(o.token)).send({ role: 'general', mode: 'add' });
    expect(d.status).toBe(201);
    expect(d.body.request).toMatchObject({ status: 'approved', mode: 'add', toRole: 'general' });
    await api().post('/api/me/roles').set(auth(w.token)).send({ role: 'general', data: FORMS.general }).expect(201);
    const me = await api().get('/api/me').set(auth(w.token));
    expect(me.body.profiles.find((p: { role: string }) => p.role === 'specialist').isPublic).toBe(true);
    expect(me.body.user.activeRole).toBe('general');
  });
});
