import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { users } from '../src/db/schema';
import { normSource, parseUA } from '../src/lib/presence';
import { api, auth, login, registered } from './helpers';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const ANDROID_TG = 'Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 Telegram-Android/10.9';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

describe('admin analytics (round 51): real visitors only, sources, devices, funnel', () => {
  it('parses user agent and entry source', () => {
    expect(parseUA(IPHONE)).toEqual({ device: 'mobile', os: 'ios', browser: 'safari' });
    expect(parseUA(ANDROID_TG)).toEqual({ device: 'mobile', os: 'android', browser: 'telegram' });
    expect(parseUA(WIN)).toEqual({ device: 'desktop', os: 'windows', browser: 'chrome' });
    expect(normSource('https://www.google.com/search?q=x', 'chrome')).toBe('google');
    expect(normSource('https://t.me/blooko', 'chrome')).toBe('telegram');
    expect(normSource('telegram', 'chrome')).toBe('telegram'); // utm_source
    expect(normSource('', 'instagram')).toBe('instagram');
    expect(normSource('https://blooko.ir/', 'chrome')).toBe('direct');
    expect(normSource('https://news.example.com/a', 'chrome')).toBe('news.example.com');
    expect(normSource(undefined, 'chrome')).toBe('direct');
  });

  it('counts real visitors; admins, sample accounts and bots are excluded; period comparison and chart', async () => {
    const adm = await registered('general');
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, adm.profile.userId));
    const get = async (range = 'today') => (await api().get('/api/admin/panel/live?range=' + range).set(auth(adm.token))).body;
    const a0 = (await get()).analytics;
    const src0 = (k: string) => (a0.sources.find((x: { k: string }) => x.k === k) || { n: 0 }).n;

    const t = Date.now().toString(36);
    await api().post('/api/app/ping').set('User-Agent', IPHONE).send({ v: 'ga' + t, view: true, src: 'https://www.google.com/', sa: true }).expect(200);
    await api().post('/api/app/ping').set('User-Agent', IPHONE).send({ v: 'ga' + t, view: true }).expect(200);
    await api().post('/api/app/ping').set('User-Agent', ANDROID_TG).send({ v: 'tg' + t, view: true }).expect(200);
    await api().post('/api/app/ping').set('User-Agent', BOT).send({ v: 'bt' + t, view: true }).expect(200);
    // خود مدیر و حساب نمونه
    await api().post('/api/app/ping').set('User-Agent', WIN).set(auth(adm.token)).send({ v: 'ad' + t, view: true }).expect(200);
    const sample = await login('09000007777');
    await api().post('/api/app/ping').set('User-Agent', WIN).set(auth(sample.token)).send({ v: 'sm' + t, view: true }).expect(200);
    // یک ثبت‌نام کامل امروز
    await registered('worker');

    const live = await get();
    const a = live.analytics;
    expect(a.range).toBe('today');
    expect(a.cur.visitors - a0.cur.visitors).toBe(2);
    expect(a.cur.views - a0.cur.views).toBe(3);
    expect(a.cur.installed - a0.cur.installed).toBe(1);
    expect(a.cur.signups - a0.cur.signups).toBe(1);
    expect((a.sources.find((x: { k: string }) => x.k === 'google') || { n: 0 }).n - src0('google')).toBe(1);
    expect((a.sources.find((x: { k: string }) => x.k === 'telegram') || { n: 0 }).n - src0('telegram')).toBe(1);
    expect(a.chart).toHaveLength(24);
    expect(a.prev).toHaveProperty('visitors');
    // آنلاین: مدیر و نمونه شمرده نمی‌شوند، ربات هم نه
    expect(live.online.now).toBe(live.online.members + live.online.guests);
    expect(live.online.now).toBeLessThanOrEqual(a.cur.visitors);

    const w = (await get('7d')).analytics;
    expect(w.chart).toHaveLength(7);
    expect(w.cur.visitors).toBeGreaterThanOrEqual(a.cur.visitors);
    expect((await get('30d')).analytics.chart).toHaveLength(30);
    const all = (await get('all')).analytics;
    expect(all.prev).toBeNull();
    expect(all.cur.visitors).toBeGreaterThanOrEqual(w.cur.visitors);
    const snap = await api().get('/api/admin/panel/snapshot').set(auth(adm.token));
    expect(snap.body.stats.analytics.cur.visitors).toBe(a.cur.visitors);
  });
});
