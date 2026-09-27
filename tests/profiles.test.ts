import { describe, it, expect } from 'vitest';
import { api, auth, FORMS, login, registered } from './helpers';

describe('role registration & profiles', () => {
  it('registers every role with its own form', async () => {
    for (const role of ['worker', 'contractor', 'engineer', 'general', 'company'] as const) {
      const u = await registered(role);
      expect(u.profile.role).toBe(role);
      expect(u.profile.code).toMatch(/^B-[A-Z0-9]{4}$/);
    }
  });

  it('returns field-level Persian errors', async () => {
    const u = await login();
    const r = await api()
      .post('/api/me/roles')
      .set(auth(u.token))
      .send({ role: 'worker', data: { ...FORMS.worker, skills: [], exp: 'نامعلوم', fn: '' } });
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.error.details.fields).sort()).toEqual(['exp', 'fn', 'skills']);
  });

  it('conditional fields: foreign nationals must give ID doc', async () => {
    const u = await login();
    const r = await api()
      .post('/api/me/roles')
      .set(auth(u.token))
      .send({ role: 'worker', data: { ...FORMS.worker, nat: 'اتباع خارجی' } });
    expect(r.body.error.details.fields).toHaveProperty('natc');
    expect(r.body.error.details.fields).toHaveProperty('idNo');
  });

  it('company national id must be 11 digits', async () => {
    const u = await login();
    const r = await api()
      .post('/api/me/roles')
      .set(auth(u.token))
      .send({ role: 'company', data: { ...FORMS.company, nid: '123' } });
    expect(r.body.error.details.fields.nid).toBeDefined();
  });

  it('multi-role: add second role, switch, week, public view hides private data', async () => {
    const u = await registered('worker');
    const add = await api().post('/api/me/roles').set(auth(u.token)).send({ role: 'contractor', data: FORMS.contractor });
    expect(add.status).toBe(201);
    const dup = await api().post('/api/me/roles').set(auth(u.token)).send({ role: 'contractor', data: FORMS.contractor });
    expect(dup.status).toBe(409);

    let me = await api().get('/api/me').set(auth(u.token));
    expect(me.body.user.activeRole).toBe('contractor');
    expect(me.body.profiles).toHaveLength(2);

    await api().post('/api/me/active-role').set(auth(u.token)).send({ role: 'worker' });
    me = await api().get('/api/me').set(auth(u.token));
    expect(me.body.user.activeRole).toBe('worker');

    const w = await api()
      .put('/api/me/roles/worker/week')
      .set(auth(u.token))
      .send({ week: ['a', 'a', 'o', 'o', 'o', 'o', 'o'] });
    expect(w.body.week).toEqual(['a', 'a', 'o', 'o', 'o', 'o', 'o']);

    const pub = await api().get(`/api/profiles/${u.profile.code}`);
    expect(pub.status).toBe(200);
    expect(pub.body.profile.phone).toBeNull();
    expect(pub.body.profile.skills.length).toBe(2);
    expect(pub.body.profile.skills[0].rateAmount).toBe(1800000);
    // نیم‌فاصله و ارقام فارسی دست‌نخورده می‌مانند
    expect(pub.body.profile.skills.map((s: { title: string }) => s.title)).toContain('بتن\u200cریزی');
    expect(pub.body.profile.data.exp).toBe('۵ تا ۱۰ سال');
    expect(pub.body.profile.trust.total).toBe(0);
  });

  it('private profile is hidden; showPhone reveals phone only to logged-in users', async () => {
    const u = await login();
    await api()
      .post('/api/me/roles')
      .set(auth(u.token))
      .send({ role: 'engineer', data: { ...FORMS.engineer, showPhone: true } });
    const me = await api().get('/api/me').set(auth(u.token));
    const code = me.body.profiles[0].code;
    expect((await api().get(`/api/profiles/${code}`)).body.profile.phone).toBeNull();
    const viewer = await login();
    expect((await api().get(`/api/profiles/${code}`).set(auth(viewer.token))).body.profile.phone).toBe(u.phone);

    await api().patch('/api/me/roles/engineer').set(auth(u.token)).send({ data: { pub: false } });
    expect((await api().get(`/api/profiles/${code}`)).status).toBe(404);
  });

  it('search profiles by skill text', async () => {
    await registered('worker');
    const r = await api().get('/api/profiles').query({ role: 'worker', q: 'بتن' });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
  });

  it('cannot delete last role; account deletion works', async () => {
    const u = await registered('general');
    const d = await api().delete('/api/me/roles/general').set(auth(u.token));
    expect(d.body.error.code).toBe('LAST_ROLE');
    const del = await api().delete('/api/me').set(auth(u.token)).send({ confirm: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await api().get('/api/me').set(auth(u.token))).status).toBe(401);
  });
});
