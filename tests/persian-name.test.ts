import { describe, it, expect } from 'vitest';
import { api, auth, FORMS, login } from './helpers';

describe('registration: Persian-only names', () => {
  it('rejects Latin letters and digits in the name; accepts Persian with half-space', async () => {
    const u = await login();
    for (const fn of ['Ali', 'حسین2', 'حسین!']) {
      const r = await api().post('/api/me/roles').set(auth(u.token)).send({ role: 'worker', data: { ...FORMS.worker, fn } });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body.error)).toContain('فقط با حروف فارسی');
    }
    const ok = await api().post('/api/me/roles').set(auth(u.token)).send({ role: 'worker', data: { ...FORMS.worker, fn: 'علی‌رضا', ln: 'صالحی' } });
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.body.profile)).toContain('علی‌رضا');

    // نمایندهٔ شرکت هم
    const c = await login();
    const bad = await api().post('/api/me/roles').set(auth(c.token)).send({ role: 'company', data: { ...FORMS.company, fn: 'Hossein Salehi' } });
    expect(bad.status).toBe(400);
  });
});
