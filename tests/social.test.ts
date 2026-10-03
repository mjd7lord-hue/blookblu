import { describe, it, expect } from 'vitest';
import { api, auth, login, registered , multiRole } from './helpers';
import { beforeAll, afterAll } from 'vitest';

describe('saved, guarantees, blocks, reports, meta', () => {
  beforeAll(() => multiRole(true));
  afterAll(() => multiRole(false));
  it('saves ads and profiles', async () => {
    const u = await registered('general');
    const w = await registered('worker');
    const put = await api().put(`/api/saved/profile/${w.profile.id}`).set(auth(u.token));
    expect(put.body.saved).toBe(true);
    await api().put(`/api/saved/profile/${w.profile.id}`).set(auth(u.token));
    const list = await api().get('/api/saved').set(auth(u.token));
    expect(list.body.profiles).toHaveLength(1);
    await api().delete(`/api/saved/profile/${w.profile.id}`).set(auth(u.token));
    expect((await api().get('/api/saved').set(auth(u.token))).body.profiles).toHaveLength(0);
  });

  it('guarantor flow (قیم)', async () => {
    const w = await registered('worker');
    const g = await registered('engineer');
    const self = await api().post('/api/guarantees').set(auth(w.token)).send({ name: 'خودم', phone: w.phone });
    expect(self.body.error.code).toBe('SELF_GUARANTEE');

    const req = await api()
      .post('/api/guarantees')
      .set(auth(w.token))
      .send({ name: 'مهندس کریمی', relation: 'ناظر ۶ ساله', phone: g.phone });
    expect(req.status).toBe(201);
    expect(req.body.invited).toBe(false);

    const inc = await api().get('/api/guarantees').set(auth(g.token));
    expect(inc.body.incoming).toHaveLength(1);
    const ans = await api().patch(`/api/guarantees/${inc.body.incoming[0].id}`).set(auth(g.token)).send({ status: 'accepted' });
    expect(ans.body.guarantee.status).toBe('accepted');
    // غریبه نمی‌تواند جواب دهد
    const other = await login();
    expect((await api().patch(`/api/guarantees/${inc.body.incoming[0].id}`).set(auth(other.token)).send({ status: 'rejected' })).status).toBe(404);

    const pub = await api().get(`/api/profiles/${w.profile.code}`);
    expect(pub.body.profile.guarantors).toEqual([{ name: 'مهندس کریمی', relation: 'ناظر ۶ ساله' }]);
    const notifs = await api().get('/api/notifications').set(auth(w.token));
    expect(notifs.body.items.some((n: { type: string }) => n.type === 'id')).toBe(true);
    await api().post('/api/notifications/read-all').set(auth(w.token));
    expect((await api().get('/api/notifications').set(auth(w.token))).body.unread).toBe(0);
  });

  it('blocking hides profile and ads both ways', async () => {
    const a = await registered('contractor');
    const b = await registered('worker');
    await api()
      .post('/api/ads')
      .set(auth(a.token))
      .send({ type: 'job', title: 'نیاز به کارگر ساده', province: 'هرمزگان', city: 'قشم', audience: ['worker'] });
    const blk = await api().post('/api/blocks').set(auth(b.token)).send({ profileCode: a.profile.code });
    expect(blk.body.blocked).toBe(true);
    expect((await api().get(`/api/profiles/${a.profile.code}`).set(auth(b.token))).status).toBe(404);
    expect((await api().get(`/api/profiles/${b.profile.code}`).set(auth(a.token))).status).toBe(404);
    const ex = await api().get('/api/ads').set(auth(b.token)).query({ mode: 'jobs', city: 'قشم' });
    expect(ex.body.items.every((x: { author: { code: string } }) => x.author.code !== a.profile.code)).toBe(true);
    expect((await api().get('/api/blocks').set(auth(b.token))).body.items).toHaveLength(1);
    await api().delete(`/api/blocks/${a.profile.code}`).set(auth(b.token));
    expect((await api().get(`/api/profiles/${a.profile.code}`).set(auth(b.token))).status).toBe(200);
  });

  it('reports', async () => {
    const a = await registered('worker');
    const b = await login();
    const r = await api()
      .post('/api/reports')
      .set(auth(b.token))
      .send({ profileCode: a.profile.code, reason: 'کلاهبرداری یا درخواست پیش‌پرداخت', details: 'درخواست کارت به کارت' });
    expect(r.status).toBe(201);
  });

  it('meta + health + 404', async () => {
    const m = await api().get('/api/meta/roles');
    expect(m.body.roles).toHaveLength(6);
    expect((await api().get('/api/meta/options')).body.provinces).toHaveLength(31);
    expect((await api().get('/api/health')).body.db).toBe('up');
    expect((await api().get('/api/nothing')).status).toBe(404);
  });
});
