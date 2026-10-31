import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { users } from '../src/db/schema';
import { api, auth, FORMS, login, registered } from './helpers';

async function invitedSignup(code: string) {
  const u = await login();
  const r = await api().post('/api/me/roles').set(auth(u.token)).send({ role: 'worker', data: { ...FORMS.worker, ref: code } });
  expect(r.status).toBe(201);
  return { ...u, profile: r.body.profile };
}
const pub = async (code: string) => (await api().get(`/api/profiles/${code}`)).body.profile;

describe('round 58: invite points, ambassador badge, support from panel, custom-item submitters', () => {
  it('every successful invite +5 trust up to 75; 10 invites = «سفیر بلوک»', async () => {
    const a = await registered('contractor');
    const base = (await pub(a.profile.code)).trust.adj;
    await invitedSignup(a.profile.code);
    await invitedSignup(a.profile.code);
    let p = await pub(a.profile.code);
    expect(p.invites).toBe(2);
    expect(p.trust.adj - base).toBe(10);
    expect(p.ambassador).toBe(false);
    for (let i = 0; i < 8; i++) await invitedSignup(a.profile.code);
    p = await pub(a.profile.code);
    expect(p).toMatchObject({ invites: 10, ambassador: true });
    expect(p.trust.adj - base).toBe(50);
    const nf = (await api().get('/api/notifications').set(auth(a.token))).body.items;
    expect(nf.some((x: { title: string }) => x.title.includes('سفیر بلوک'))).toBe(true);
    // سقف ۷۵
    for (let i = 0; i < 6; i++) await invitedSignup(a.profile.code);
    p = await pub(a.profile.code);
    expect(p.invites).toBe(16);
    expect(p.trust.adj - base).toBe(75);
    // دعوت از خود حساب نمی‌شود: کسی که کد خودش را بزند (ممکن نیست قبل از نقش) — حساب حذف‌شده هم شمرده نمی‌شود
    const gone = await invitedSignup(a.profile.code);
    await db.update(users).set({ status: 'deleted' }).where(eq(users.id, gone.profile.userId));
    expect((await pub(a.profile.code)).invites).toBe(16);
  });

  it('admin messages any user from the panel; «مورد دیگر» shows who submitted it', async () => {
    const adm = await registered('general');
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, adm.profile.userId));
    const w = await login();
    const odd = 'سنگ‌کاری آنتیک ' + Date.now().toString(36);
    const reg = await api().post('/api/me/roles').set(auth(w.token)).send({ role: 'worker', data: { ...FORMS.worker, skills: ['بنایی و دیوارچینی', odd] } });
    expect(reg.status).toBe(201);

    const snap = (await api().get('/api/admin/panel/snapshot').set(auth(adm.token))).body;
    const item = (snap.custom || []).find((x: { value: string }) => x.value === odd);
    expect(item.users.map((u: { userId: string }) => u.userId)).toContain(reg.body.profile.userId);
    expect(item.users[0]).toHaveProperty('phone');

    const s = await api().post(`/api/admin/panel/users/${reg.body.profile.userId}/support`).set(auth(adm.token)).send({ text: `منظورت از «${odd}» چیست؟`, subject: 'دربارهٔ مورد دیگر' });
    expect(s.status).toBe(201);
    expect(s.body.code).toMatch(/^T-\d+$/);
    const msgs = await api().get(`/api/conversations/${s.body.conversationId}/messages`).set(auth(w.token));
    expect(JSON.stringify(msgs.body)).toContain(odd);
    const nf = (await api().get('/api/notifications').set(auth(w.token))).body.items;
    expect(nf.some((x: { title: string }) => x.title.includes('پیام از پشتیبانی'))).toBe(true);
    // پیام دوم در همان گفت‌وگو
    const s2 = await api().post(`/api/admin/panel/users/${reg.body.profile.userId}/support`).set(auth(adm.token)).send({ text: 'منتظر جوابت هستیم' });
    expect(s2.body.conversationId).toBe(s.body.conversationId);
    // کاربر عادی اجازه ندارد
    expect((await api().post(`/api/admin/panel/users/${adm.profile.userId}/support`).set(auth(w.token)).send({ text: 'x' })).status).toBe(403);
    // کاربر بدون نقش ← خطای روشن
    const bare = await login();
    expect((await api().post(`/api/admin/panel/users/${bare.body.user.id}/support`).set(auth(adm.token)).send({ text: 'سلام' })).body.error.code).toBe('NO_PROFILE');
  });
});
