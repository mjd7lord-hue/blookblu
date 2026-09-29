import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { appConfig, users } from '../src/db/schema';
import { resetConfigCache } from '../src/lib/appConfig';
import { api, auth, registered } from './helpers';

afterAll(async () => {
  await db.delete(appConfig).where(eq(appConfig.key, 'whatsNew'));
  resetConfigCache();
});

describe('whats new after each update', () => {
  it('default notes are public; admin publishes a new version; off hides it', async () => {
    const pub = await api().get('/api/app/config');
    expect(pub.body.whatsNew.items.length).toBeGreaterThan(0);
    expect(pub.body.whatsNew.v).toBeTruthy();

    const o = await registered('general');
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, o.profile.userId));
    const put = (value: unknown) => api().put('/api/admin/panel/config/whatsNew').set(auth(o.token)).send({ value });
    expect((await put({ on: true, v: '', title: 'x', items: [] })).body.error.code).toBe('BAD_CONFIG');
    await put({ on: true, v: '1405-07-08-a', title: 'تازه‌های بلوک', items: [{ t: 'رزرو بازدید مهندس', d: 'از پروفایل مهندس «رزرو بازدید» را بزن' }] }).expect(200);
    const after = await api().get('/api/app/config');
    expect(after.body.whatsNew).toMatchObject({ v: '1405-07-08-a', items: [{ t: 'رزرو بازدید مهندس' }] });

    await put({ on: false, v: '1405-07-08-a', title: 'تازه‌های بلوک', items: [{ t: 'رزرو بازدید مهندس', d: '' }] }).expect(200);
    expect((await api().get('/api/app/config')).body.whatsNew).toBeNull();
  });
});
