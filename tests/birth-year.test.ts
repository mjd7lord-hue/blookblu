import { describe, it, expect } from 'vitest';
import { api, auth, FORMS, login } from './helpers';

describe('registration: optional birth year', () => {
  it('accepts a Persian 4-digit year, rejects junk, and shows it on the public profile', async () => {
    const bad = await login();
    const r1 = await api().post('/api/me/roles').set(auth(bad.token)).send({ role: 'worker', data: { ...FORMS.worker, by: '65' } });
    expect(r1.status).toBe(400);

    const u = await login();
    const r = await api().post('/api/me/roles').set(auth(u.token)).send({ role: 'worker', data: { ...FORMS.worker, by: '۱۳۶۵' } });
    expect(r.status).toBe(201);
    const pub = await api().get(`/api/profiles/${r.body.profile.code}`);
    expect(pub.body.profile.data.by).toBe('1365');

    // بدون سال تولد هم ثبت‌نام کامل است
    const n = await login();
    expect((await api().post('/api/me/roles').set(auth(n.token)).send({ role: 'worker', data: FORMS.worker })).status).toBe(201);
  });
});
