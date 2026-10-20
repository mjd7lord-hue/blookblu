import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { users } from '../src/db/schema';
import { api, auth, registered } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n%%EOF', 'latin1');

describe('manual identity verification from a national-card document', () => {
  it('admin verifies identity when the user only uploaded «کارت ملی» in documents', async () => {
    const o = await registered('general');
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, o.profile.userId));
    const w = await registered('worker');
    const uid = w.profile.userId;
    // بدون مدرک هویتی ← خطای روشن
    expect((await api().post(`/api/admin/panel/users/${uid}/verify-identity`).set(auth(o.token)).send({})).body.error.code).toBe('NO_ID_DOCUMENT');
    await api().post('/api/me/documents').set(auth(w.token)).field('title', 'کارت ملی').field('group', 'هویت').field('role', 'worker').attach('file', PDF, 'id.pdf').expect(201);
    const before = (await api().get(`/api/profiles/${w.profile.code}`)).body.profile.trust.identity;
    expect(before).toBe(0);
    await api().post(`/api/admin/panel/users/${uid}/verify-identity`).set(auth(o.token)).send({}).expect(200);
    const me = await api().get('/api/me').set(auth(w.token));
    expect(me.body.user.kycStatus).toBe('verified');
    expect((await api().get(`/api/profiles/${w.profile.code}`)).body.profile.trust.identity).toBe(10);
    const docs = (await api().get('/api/me/documents').set(auth(w.token))).body.items;
    expect(docs[0].status).toBe('approved');
    expect((await api().post(`/api/admin/panel/users/${uid}/verify-identity`).set(auth(o.token)).send({})).body.error.code).toBe('ALREADY_VERIFIED');
    // کاربر عادی اجازه ندارد
    expect((await api().post(`/api/admin/panel/users/${uid}/verify-identity`).set(auth(w.token)).send({})).status).toBe(403);
  });
});
