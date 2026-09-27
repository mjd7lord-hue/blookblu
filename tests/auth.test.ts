import { describe, it, expect } from 'vitest';
import { api, auth, login, nextPhone } from './helpers';

describe('OTP auth', () => {
  it('accepts Persian digits and +98 format', async () => {
    const r = await api().post('/api/auth/otp/send').send({ phone: '+98 912 555 0001' });
    expect(r.status).toBe(200);
    expect(r.body.isNew).toBe(true);
    const r2 = await api().post('/api/auth/otp/send').send({ phone: '۰۹۱۲۵۵۵۰۰۰۲' });
    expect(r2.status).toBe(200);
  });

  it('rejects invalid phone', async () => {
    const r = await api().post('/api/auth/otp/send').send({ phone: '12345' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION');
  });

  it('wrong code counts attempts; right code logs in', async () => {
    const phone = nextPhone();
    const s = await api().post('/api/auth/otp/send').send({ phone });
    const wrong = s.body.devCode === '00000' ? '11111' : '00000';
    const bad = await api().post('/api/auth/otp/verify').send({ phone, code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.attemptsLeft).toBe(4);
    const ok = await api().post('/api/auth/otp/verify').send({ phone, code: s.body.devCode });
    expect(ok.status).toBe(200);
    expect(ok.body.needsRegistration).toBe(true);
    // کد مصرف‌شده دوباره کار نمی‌کند
    const again = await api().post('/api/auth/otp/verify').send({ phone, code: s.body.devCode });
    expect(again.body.error.code).toBe('OTP_EXPIRED');
  });

  it('locks after max attempts', async () => {
    const phone = nextPhone();
    const s = await api().post('/api/auth/otp/send').send({ phone });
    const wrong = s.body.devCode === '00000' ? '11111' : '00000';
    for (let i = 0; i < 5; i++) await api().post('/api/auth/otp/verify').send({ phone, code: wrong });
    const r = await api().post('/api/auth/otp/verify').send({ phone, code: s.body.devCode });
    expect(r.status).toBe(429);
  });

  it('refresh rotates and detects reuse', async () => {
    const u = await login();
    const r1 = await api().post('/api/auth/refresh').send({ refreshToken: u.refresh });
    expect(r1.status).toBe(200);
    const reuse = await api().post('/api/auth/refresh').send({ refreshToken: u.refresh });
    expect(reuse.body.error.code).toBe('REFRESH_REUSED');
    // بعد از تشخیص سرقت، توکن جدید هم باطل است
    const r2 = await api().post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });

  it('protects /me', async () => {
    expect((await api().get('/api/me')).status).toBe(401);
    expect((await api().get('/api/me').set(auth('garbage'))).status).toBe(401);
    const u = await login();
    const me = await api().get('/api/me').set(auth(u.token));
    expect(me.status).toBe(200);
    expect(me.body.needsRegistration).toBe(true);
  });
});
