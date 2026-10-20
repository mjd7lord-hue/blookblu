import { describe, it, expect } from 'vitest';
import { api, auth, FORMS, login } from './helpers';

describe('sample accounts (0900000xxxx) are hidden from public lists', () => {
  it('sample ads do not appear in explore unless the admin turns showSamples on', async () => {
    const phone = '0900000' + String(Date.now()).slice(-4);
    const s = await login(phone);
    await api().post('/api/me/roles').set(auth(s.token)).send({ role: 'worker', data: FORMS.worker }).expect(201);
    const title = 'نمونهٔ پنهان ' + Date.now();
    await api().post('/api/ads').set(auth(s.token)).send({ type: 'work', title, province: 'هرمزگان', city: 'قشم', audience: ['contractor'] }).expect(201);
    const list = async () => (await api().get('/api/ads?mode=workers&limit=50')).body.items.map((a: { title: string }) => a.title);
    expect(await list()).not.toContain(title);
    const { cfg, saveConfig } = await import('../src/lib/appConfig');
    const st = cfg('settings');
    const { db } = await import('../src/db');
    const { users } = await import('../src/db/schema');
    const [u] = await db.select({ id: users.id }).from(users).limit(1);
    await saveConfig('settings', { ...st, flags: { ...st.flags, showSamples: true } }, u.id);
    expect(await list()).toContain(title);
    await saveConfig('settings', { ...st, flags: { ...st.flags, showSamples: false } }, u.id);
  });
});
