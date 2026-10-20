import { describe, it, expect } from 'vitest';
import { api, auth, login, registered } from './helpers';

describe('real account data: devices and referrals', () => {
  it('lists open sessions, marks this device, signs out the others', async () => {
    const a = await login();
    const b = await login(a.phone); // دستگاه دوم
    const list = await api().post('/api/me/sessions').set(auth(b.token)).send({ refreshToken: b.refresh });
    expect(list.body.items.length, JSON.stringify(list.body)).toBe(2);
    expect(b.refresh).toBeTruthy();
    expect(list.body.items.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
    const out = await api().post('/api/me/sessions/revoke-others').set(auth(b.token)).send({ refreshToken: b.refresh });
    expect(out.body.revoked).toBe(1);
    const left = await api().post('/api/me/sessions').set(auth(b.token)).send({ refreshToken: b.refresh });
    expect(left.body.items).toHaveLength(1);
    expect(left.body.items[0].current).toBe(true);
    // دستگاه اول دیگر نمی‌تواند تمدید کند (و چون توکن باطل‌شده است، بلوک همهٔ نشست‌ها را می‌بندد)
    expect((await api().post('/api/auth/refresh').send({ refreshToken: a.refresh })).status).toBe(401);
    const c = await login(a.phone);
    const one = await api().post('/api/me/sessions').set(auth(c.token)).send({ refreshToken: c.refresh });
    expect((await api().delete(`/api/me/sessions/${one.body.items[0].id}`).set(auth(c.token))).status).toBe(200);
  });

  it('shows who registered with my code', async () => {
    const a = await registered('contractor');
    const b = await registered('worker', { ref: a.profile.code.toLowerCase() });
    const r = await api().get('/api/me/referrals').set(auth(a.token));
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].code).toBe(b.profile.code);
    expect((await api().get('/api/me/referrals').set(auth(b.token))).body.items).toHaveLength(0);
  });
});
