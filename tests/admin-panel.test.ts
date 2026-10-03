import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { users } from '../src/db/schema';
import { multiRole, api, auth, login, registered, FORMS } from './helpers';
import { beforeAll, afterAll } from 'vitest';

async function owner() {
  const a = await registered('general');
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, a.profile.userId));
  return a;
}

describe('admin panel: roles, permissions, province scope, snapshot', () => {
  beforeAll(() => multiRole(true));
  afterAll(() => multiRole(false));
  it('owner sees everything; legacy is_admin becomes owner automatically', async () => {
    const o = await owner();
    const me = await api().get('/api/admin/panel/me').set(auth(o.token));
    expect(me.status).toBe(200);
    expect(me.body.admin).toMatchObject({ roleKey: 'owner', roleName: 'مدیر ارشد', provinces: [] });
    expect(me.body.admin.perms.audit).toBe(2);
    expect(me.body.roles.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['arbit', 'content', 'finance', 'kyc', 'owner', 'support']));

    const snap = await api().get('/api/admin/panel/snapshot').set(auth(o.token));
    for (const k of ['users', 'ads', 'reports', 'projects', 'disputes', 'arbiters', 'guarantees', 'admins', 'audit', 'stats']) expect(snap.body).toHaveProperty(k);
    expect(snap.body.stats.signups).toHaveLength(30);
    const meRow = snap.body.users.find((u: { id: string }) => u.id === o.profile.userId);
    expect(meRow.profile.code).toBe(o.profile.code);
    expect(meRow.isAdmin).toBe(true);

    // کاربر عادی
    const u = await registered('worker');
    expect((await api().get('/api/admin/panel/me').set(auth(u.token))).body.error.code).toBe('NOT_ADMIN');
  });

  it('role-limited admin with province scope; owner manages admins and roles', async () => {
    const o = await owner();
    const fars = await registered('engineer'); // FORMS.engineer در فارس
    const hormoz = await registered('worker'); // FORMS.worker در هرمزگان

    // مدیر تازه با نقش «کارشناس احراز» فقط برای فارس
    const phone = '0935' + String(Date.now()).slice(-7);
    const cr = await api().post('/api/admin/panel/admins').set(auth(o.token)).send({ phone, name: 'نرگس کاظمی', roleKey: 'kyc', provinces: ['فارس'] });
    expect(cr.status).toBe(201);
    expect((await api().post('/api/admin/panel/admins').set(auth(o.token)).send({ phone, name: 'دوباره', roleKey: 'kyc' })).body.error.code).toBe('ADMIN_EXISTS');

    const k = await login(phone);
    const me = await api().get('/api/admin/panel/me').set(auth(k.token));
    expect(me.body.admin).toMatchObject({ roleKey: 'kyc', provinces: ['فارس'], name: 'نرگس کاظمی' });

    const snap = await api().get('/api/admin/panel/snapshot').set(auth(k.token));
    expect(snap.body.users.some((u: { id: string }) => u.id === fars.profile.userId)).toBe(true);
    expect(snap.body.users.some((u: { id: string }) => u.id === hormoz.profile.userId)).toBe(false);
    expect(snap.body).not.toHaveProperty('ads');
    expect(snap.body).not.toHaveProperty('audit');
    expect(snap.body).toHaveProperty('guarantees');

    // مسیرهای ادمین با دسترسی بخش
    expect((await api().get('/api/admin/kyc').set(auth(k.token))).status).toBe(200);
    expect((await api().get('/api/admin/reports').set(auth(k.token))).body.error.code).toBe('NO_PERMISSION');
    expect((await api().get('/api/admin/actions').set(auth(k.token))).status).toBe(403);
    expect((await api().post(`/api/admin/users/${hormoz.profile.userId}/suspend`).set(auth(k.token)).send({ reason: 'آزمایش دسترسی' })).status).toBe(200); // users: 2
    await api().post(`/api/admin/users/${hormoz.profile.userId}/unsuspend`).set(auth(o.token)).send({}).expect(200);
    expect((await api().post('/api/admin/panel/admins').set(auth(k.token)).send({ phone: '09350000009', name: 'x', roleKey: 'kyc' })).body.error.code).toBe('NO_PERMISSION');

    // مدیر ارشد دسترسی نقش را عوض می‌کند
    await api().patch('/api/admin/panel/roles/kyc').set(auth(o.token)).send({ perms: { reports: 1 } }).expect(200);
    expect((await api().get('/api/admin/reports').set(auth(k.token))).status).toBe(200);
    expect((await api().patch('/api/admin/panel/roles/owner').set(auth(o.token)).send({ perms: { audit: 0 } })).body.error.code).toBe('ROLE_FIXED');

    // غیرفعال کردن مدیر
    await api().patch(`/api/admin/panel/admins/${cr.body.admin.id}`).set(auth(o.token)).send({ status: 'disabled' }).expect(200);
    expect((await api().get('/api/admin/panel/me').set(auth(k.token))).body.error.code).toBe('NOT_ADMIN');

    // مدیر ارشد: خودش را نمی‌تواند عوض کند؛ آخرین مدیر ارشد حذف نمی‌شود
    const oMe = (await api().get('/api/admin/panel/me').set(auth(o.token))).body.admin;
    expect((await api().patch(`/api/admin/panel/admins/${oMe.id}`).set(auth(o.token)).send({ status: 'disabled' })).body.error.code).toBe('SELF');

    const audit = await api().get('/api/admin/panel/snapshot').set(auth(o.token));
    const actions = audit.body.audit.map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.create', 'role.update', 'admin.update']));
    void FORMS;
  });

  it('ads status and guarantees from the panel', async () => {
    const o = await owner();
    const c = await registered('contractor');
    const ad = await api().post('/api/ads').set(auth(c.token)).send({ type: 'job', title: 'نیاز به ۲ قالب‌بند', province: 'هرمزگان', city: 'قشم', audience: ['worker'] });
    const id = ad.body.ad.id;
    const p = await api().patch(`/api/admin/panel/ads/${id}/status`).set(auth(o.token)).send({ status: 'paused', reason: 'عکس نامربوط' });
    expect(p.body.ad.status).toBe('paused');
    expect(JSON.stringify((await api().get('/api/notifications').set(auth(c.token))).body)).toContain('متوقف شد');

    const w = await registered('worker');
    const g = await api().post('/api/guarantees').set(auth(w.token)).send({ phone: c.phone, name: 'پیمانکار یحیایی', relation: 'کارفرمای قبلی' });
    const gid = g.body.guarantee?.id ?? (await api().get('/api/admin/panel/snapshot').set(auth(o.token))).body.guarantees[0].id;
    await api().patch(`/api/admin/panel/guarantees/${gid}`).set(auth(o.token)).send({ status: 'rejected' }).expect(200);
    await api().delete(`/api/admin/panel/guarantees/${gid}`).set(auth(o.token)).expect(200);
  });
});
