import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { appConfig, users } from '../src/db/schema';
import { resetConfigCache } from '../src/lib/appConfig';
import { api, auth, FORMS, login, registered } from './helpers';

async function owner() {
  const a = await registered('general');
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, a.profile.userId));
  return a;
}
const snap = async (t: string) => (await api().get('/api/admin/panel/snapshot').set(auth(t))).body;
const saveCfg = (t: string, key: string, value: unknown) => api().put(`/api/admin/panel/config/${key}`).set(auth(t)).send({ value, note: 'آزمایش' });

afterAll(async () => {
  await db.delete(appConfig);
  resetConfigCache();
});

describe('panel B: config, flags, coefficients', () => {
  it('coefs change arbitration fee formula; bad values rejected; maintenance mode', async () => {
    const o = await owner();
    const s = await snap(o.token);
    expect(s.config.values.coefs.arb.base).toBe(1_200_000);
    const coefs = s.config.values.coefs;

    expect((await saveCfg(o.token, 'coefs', { ...coefs, arb: { ...coefs.arb, base: -5 } })).body.error.code).toBe('BAD_CONFIG');
    await saveCfg(o.token, 'coefs', { ...coefs, arb: { ...coefs.arb, base: 1_500_000, talk: 24 } }).expect(200);
    const meta = await api().get('/api/disputes/meta');
    expect(meta.body.base).toBe(1_500_000);
    expect(meta.body.talkHours).toBe(24);
    await saveCfg(o.token, 'coefs', coefs).expect(200);

    // اپ: تنظیمات عمومی
    const pub = await api().get('/api/app/config');
    expect(pub.body.flags.maintenance).toBe(false);
    expect(pub.body.legal.terms.items.length).toBeGreaterThan(2);

    // حالت تعمیر: اپ بسته، ورود و پنل باز
    const u = await registered('worker');
    const settings = s.config.values.settings;
    await saveCfg(o.token, 'settings', { ...settings, flags: { ...settings.flags, maintenance: true } }).expect(200);
    expect((await api().get('/api/me').set(auth(u.token))).body.error.code).toBe('MAINTENANCE');
    expect((await api().get('/api/admin/panel/me').set(auth(o.token))).status).toBe(200);
    await saveCfg(o.token, 'settings', settings).expect(200);
    expect((await api().get('/api/me').set(auth(u.token))).status).toBe(200);

    // بستن ثبت‌نام یک نقش
    await saveCfg(o.token, 'catalog', { roles: { company: { on: false } }, custom: {} }).expect(200);
    const x = await login();
    expect((await api().post('/api/me/roles').set(auth(x.token)).send({ role: 'company', data: {} })).body.error.code).toBe('ROLE_DISABLED');
    await saveCfg(o.token, 'catalog', { roles: {}, custom: {} }).expect(200);

    // مدیر محدود نمی‌تواند تنظیمات را عوض کند
    const phone = '0935' + String(Date.now()).slice(-7);
    await api().post('/api/admin/panel/admins').set(auth(o.token)).send({ phone, name: 'پشتیبان آزمایشی', roleKey: 'support' }).expect(201);
    const sup = await login(phone);
    expect((await saveCfg(sup.token, 'coefs', coefs)).body.error.code).toBe('NO_PERMISSION');
    const ss = await snap(sup.token);
    expect(ss).toHaveProperty('tickets');
    expect(ss).not.toHaveProperty('tx');
  });

  it('stories, academy progress and "+ other" catalog values', async () => {
    const o = await owner();
    await saveCfg(o.token, 'stories', [{ id: 's1', t: 'ایمنی گرما', s: 'کار سنگین را به صبح ببر', on: true }, { id: 's2', t: 'خاموش', s: '—', on: false }]).expect(200);
    const pub = await api().get('/api/app/config');
    expect(pub.body.stories.map((x: { id: string }) => x.id)).toEqual(['s1']);
    await api().post('/api/app/stories/s1/view').expect(200);

    const u = await registered('worker');
    const cs = await api().get('/api/app/courses').set(auth(u.token));
    const first = cs.body.items[0];
    expect(first.done).toBe(0);
    await api().put(`/api/app/courses/${first.id}/progress`).set(auth(u.token)).send({ done: 2 }).expect(200);
    const done = await api().put(`/api/app/courses/${first.id}/progress`).set(auth(u.token)).send({ done: first.lessons });
    expect(done.body.completed).toBe(true);
    expect((await api().get('/api/app/courses').set(auth(u.token))).body.badges).toBe(1);

    const s = await snap(o.token);
    expect(s.content.views.find((v: { itemId: string }) => v.itemId === 's1').views).toBe(1);
    expect(s.content.courses.find((c: { courseId: string }) => c.courseId === first.id).completed).toBeGreaterThanOrEqual(1);

    // «+ مورد دیگر»: کارگر مهارت دستی نوشته
    const w = await login();
    await api()
      .post('/api/me/roles')
      .set(auth(w.token))
      .send({ role: 'worker', data: { ...FORMS.worker, skills: ['نصب کناف', 'بتن‌ریزی'] } })
      .expect(201);
    const c1 = (await snap(o.token)).custom.find((c: { value: string }) => c.value === 'نصب کناف');
    expect(c1).toMatchObject({ role: 'worker', field: 'skills', status: 'wait' });
    await api().post('/api/admin/panel/catalog/custom').set(auth(o.token)).send({ role: 'worker', field: 'skills', value: 'نصب کناف', action: 'ok' }).expect(200);
    const forms = await api().get('/api/meta/roles');
    const skills = forms.body.roles.find((r: { role: string }) => r.role === 'worker').steps.flatMap((s: { fields: { k: string; opts?: string[] }[] }) => s.fields).find((f: { k: string }) => f.k === 'skills');
    expect(skills.opts).toContain('نصب کناف');
  });
});

describe('panel B: chats, support tickets, broadcast', () => {
  it('support chat: user writes → ticket → admin reply → close', async () => {
    const o = await owner();
    const u = await registered('specialist');
    const open = await api().post('/api/app/support').set(auth(u.token)).expect(200);
    const cid = open.body.conversation.id;
    // دوباره همان گفت‌وگو
    expect((await api().post('/api/app/support').set(auth(u.token))).body.conversation.id).toBe(cid);
    // تا کاربر چیزی ننوشته تیکتی نیست
    expect((await snap(o.token)).tickets.some((t: { conversationId: string }) => t.conversationId === cid)).toBe(false);

    await api().post(`/api/conversations/${cid}/messages`).set(auth(u.token)).send({ kind: 'text', body: 'کد تأیید پیامک نمی‌رسد' }).expect(201);
    const t = (await snap(o.token)).tickets.find((x: { conversationId: string }) => x.conversationId === cid);
    expect(t).toMatchObject({ status: 'open', subject: 'کد تأیید پیامک نمی‌رسد' });
    expect(t.code).toMatch(/^T-\d+$/);

    await api().post(`/api/admin/panel/tickets/${t.id}/reply`).set(auth(o.token)).send({ text: 'سلام، بررسی می‌کنم.' }).expect(201);
    const msgs = await api().get(`/api/conversations/${cid}/messages`).set(auth(u.token));
    const last = msgs.body.items[msgs.body.items.length - 1];
    expect(last).toMatchObject({ kind: 'text', body: 'سلام، بررسی می‌کنم.', mine: false, admin: expect.any(String) });
    const t2 = (await snap(o.token)).tickets.find((x: { id: string }) => x.id === t.id);
    expect(t2.status).toBe('pending');
    expect(t2.assigneeAdminId).toBeTruthy();
    expect(t2.messages.map((m: { from: string }) => m.from)).toEqual(['user', 'admin']);

    await api().patch(`/api/admin/panel/tickets/${t.id}`).set(auth(o.token)).send({ status: 'closed', priority: 'high' }).expect(200);
    await api().post(`/api/conversations/${cid}/messages`).set(auth(u.token)).send({ kind: 'text', body: 'باز هم نیامد' }).expect(201);
    expect((await snap(o.token)).tickets.find((x: { id: string }) => x.id === t.id).status).toBe('open');
  });

  it('chat moderation: hide message, admin message, lock, warn', async () => {
    const o = await owner();
    const a = await registered('contractor');
    const b = await registered('worker');
    const c = await api().post('/api/conversations').set(auth(a.token)).send({ profileCode: b.profile.code });
    const cid = c.body.conversation.id;
    const m = await api().post(`/api/conversations/${cid}/messages`).set(auth(b.token)).send({ kind: 'text', body: 'نصف پول را به کارت ۶۰۳۷۹۹۷۵۱۲۳۴۵۶۷۸ بریز' });
    expect(m.status).toBe(201);
    const s = await snap(o.token);
    const conv = s.conversations.find((x: { id: string }) => x.id === cid);
    expect(conv.flags, JSON.stringify(conv)).toBe(1);
    expect(conv.members).toHaveLength(2);

    const full = await api().get(`/api/admin/panel/conversations/${cid}`).set(auth(o.token));
    expect(full.body.items.some((x: { flagged: boolean }) => x.flagged)).toBe(true);

    await api().patch(`/api/admin/panel/messages/${m.body.message.id}`).set(auth(o.token)).send({ hidden: true }).expect(200);
    const seen = await api().get(`/api/conversations/${cid}/messages`).set(auth(a.token));
    const hid = seen.body.items.find((x: { id: string }) => x.id === m.body.message.id);
    expect(hid.kind).toBe('del');
    expect(hid.body).toBeNull();
    // مدیر متن را هنوز می‌بیند
    const adm = await api().get(`/api/admin/panel/conversations/${cid}`).set(auth(o.token));
    expect(adm.body.items.find((x: { id: string }) => x.id === m.body.message.id)).toMatchObject({ hidden: true, body: expect.stringContaining('کارت') });

    await api().post(`/api/admin/panel/conversations/${cid}/messages`).set(auth(o.token)).send({ text: 'پیش‌پرداخت خارج از توافق مجاز نیست.' }).expect(201);
    await api().patch(`/api/admin/panel/conversations/${cid}`).set(auth(o.token)).send({ locked: true }).expect(200);
    expect((await api().post(`/api/conversations/${cid}/messages`).set(auth(a.token)).send({ kind: 'text', body: 'سلام' })).body.error.code).toBe('CONV_LOCKED');
    await api().patch(`/api/admin/panel/conversations/${cid}`).set(auth(o.token)).send({ locked: false }).expect(200);
    await api().post(`/api/conversations/${cid}/messages`).set(auth(a.token)).send({ kind: 'text', body: 'سلام' }).expect(201);

    await api().post(`/api/admin/panel/users/${b.profile.userId}/warn`).set(auth(o.token)).send({ text: 'درخواست پیش‌پرداخت به کارت شخصی مجاز نیست', report: true }).expect(200);
    const n = await api().get('/api/notifications').set(auth(b.token));
    expect(JSON.stringify(n.body)).toContain('اخطار پشتیبانی');
    const audit = (await snap(o.token)).audit.map((x: { action: string }) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['message.hide', 'chat.message', 'chat.lock', 'user.warn']));
  });

  it('broadcast to roles/provinces with preview and open rate', async () => {
    const o = await owner();
    const w = await registered('worker'); // هرمزگان
    const e = await registered('engineer'); // فارس
    const pv = await api().post('/api/admin/panel/broadcasts/preview').set(auth(o.token)).send({ roles: ['worker'], provinces: ['هرمزگان'] });
    expect(pv.body.count).toBeGreaterThanOrEqual(1);
    const sent = await api()
      .post('/api/admin/panel/broadcasts')
      .set(auth(o.token))
      .send({ title: 'دورهٔ تازهٔ آکادمی', body: 'ایمنی کار در ارتفاع', roles: ['worker'], provinces: ['هرمزگان'], screen: 'learn' });
    expect(sent.status).toBe(201);
    expect(sent.body.sent).toBe(pv.body.count);
    const nw = await api().get('/api/notifications').set(auth(w.token));
    expect(JSON.stringify(nw.body)).toContain('دورهٔ تازهٔ آکادمی');
    const ne = await api().get('/api/notifications').set(auth(e.token));
    expect(JSON.stringify(ne.body)).not.toContain('دورهٔ تازهٔ آکادمی');
    const one = await api().post('/api/admin/panel/broadcasts').set(auth(o.token)).send({ title: 'پیام خصوصی', userIds: [e.profile.userId] });
    expect(one.body.sent).toBe(1);
    const b = (await snap(o.token)).broadcasts.find((x: { id: string }) => x.id === sent.body.broadcast.id);
    expect(b).toMatchObject({ sent: pv.body.count, opened: 0 });
  });

  it('status, sessions, new role, transactions and payouts', async () => {
    const o = await owner();
    const s = await snap(o.token);
    expect(s.status.db.ok).toBe(true);
    expect(s.status.requestsTotal).toBeGreaterThan(0);
    expect(s.sessions.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(s.tx)).toBe(true);
    const nr = await api().post('/api/admin/panel/roles').set(auth(o.token)).send({ name: 'ناظر استانی' });
    expect(nr.status).toBe(201);
    expect(nr.body.role.perms.dash).toBe(1);
    const arbs = s.arbiters as { id: string; pending: number }[];
    if (arbs.length) {
      const r = await api().post('/api/admin/panel/payouts').set(auth(o.token)).send({ arbiterId: arbs[0].id, amount: arbs[0].pending + 1000, ref: 'آزمایش ۱۲۳' });
      expect(r.body.error.code).toBe('OVER_BALANCE');
    }
    const other = s.sessions.find((x: { userId: string }) => x.userId === o.profile.userId);
    await api().delete(`/api/admin/panel/sessions/${other.id}`).set(auth(o.token)).expect(200);
  });
});

describe('team attendance and engineer visits', () => {
  it('team: add members, attendance, pay', async () => {
    const c = await registered('contractor');
    const a1 = await api().post('/api/me/team').set(auth(c.token)).send({ name: 'حسین کمالی', skill: 'بنا', dailyWage: '۲٬۲۰۰٬۰۰۰' });
    expect(a1.status).toBe(201);
    const a2 = await api().post('/api/me/team').set(auth(c.token)).send({ name: 'جواد رحیمی', skill: 'کارگر ساده', dailyWage: 1_500_000 });
    await api().post('/api/me/team/attendance/all-present').set(auth(c.token)).expect(200);
    await api().put(`/api/me/team/${a2.body.member.id}/attendance`).set(auth(c.token)).send({ status: 'a' }).expect(200);
    const t = await api().get('/api/me/team').set(auth(c.token));
    expect(t.body.totals).toMatchObject({ members: 2, presentToday: 1, pay: 2_200_000 });
    expect((await api().put(`/api/me/team/${a2.body.member.id}/attendance`).set(auth(c.token)).send({ day: '2099-01-01', status: 'p' })).body.error.code).toBe('FUTURE_DAY');
    const other = await registered('specialist');
    expect((await api().delete(`/api/me/team/${a1.body.member.id}`).set(auth(other.token))).status).toBe(404);
    await api().delete(`/api/me/team/${a1.body.member.id}`).set(auth(c.token)).expect(200);
  });

  it('visits: slots, book, taken slot, confirm, cancel rules, report', async () => {
    const eng = await registered('engineer');
    await api().put('/api/me/roles/engineer/week').set(auth(eng.token)).send({ week: ['a', 'a', 'a', 'a', 'a', 'a', 'a'] }).expect(200);
    const client = await registered('general');
    const sl = await api().get(`/api/visits/slots/${eng.profile.code}`);
    expect(sl.body.days).toHaveLength(7);
    expect(sl.body.days.every((d: { open: boolean }) => d.open)).toBe(true);
    const day = sl.body.days[2].day;
    const book = await api().post('/api/visits').set(auth(client.token)).send({ engineerCode: eng.profile.code, type: 1, day, slot: '۱۰:۰۰', address: 'قشم، درگهان، کوچهٔ ۱۲' });
    expect(book.status).toBe(201);
    expect(book.body.visit).toMatchObject({ status: 'requested', price: 4_500_000, as: 'client' });
    const again = await api().post('/api/visits').set(auth(client.token)).send({ engineerCode: eng.profile.code, type: 0, day, slot: '۱۰:۰۰', address: 'قشم، جای دیگر' });
    expect(again.body.error.code).toBe('SLOT_TAKEN');
    expect((await api().get(`/api/visits/slots/${eng.profile.code}`)).body.days[2].taken).toEqual(['۱۰:۰۰']);

    const id = book.body.visit.id;
    expect((await api().post(`/api/visits/${id}/confirm`).set(auth(client.token))).body.error.code).toBe('NOT_ENGINEER');
    await api().post(`/api/visits/${id}/confirm`).set(auth(eng.token)).expect(200);
    expect((await api().post(`/api/visits/${id}/done`).set(auth(eng.token)).send({ report: 'آرماتور طبق نقشه است', checklist: [] })).body.error.code).toBe('TOO_EARLY');
    const mine = await api().get('/api/visits').set(auth(eng.token));
    expect(mine.body.items[0]).toMatchObject({ as: 'engineer', status: 'confirmed', client: { code: client.profile.code } });
    await api().post(`/api/visits/${id}/cancel`).set(auth(client.token)).expect(200);

    // روز بسته
    await api().put('/api/me/roles/engineer/week').set(auth(eng.token)).send({ week: ['o', 'o', 'o', 'o', 'o', 'o', 'o'] }).expect(200);
    const closed = await api().post('/api/visits').set(auth(client.token)).send({ engineerCode: eng.profile.code, type: 0, day, slot: '۸:۰۰', address: 'قشم، درگهان' });
    expect(closed.body.error.code).toBe('DAY_CLOSED');
    const n = await api().get('/api/notifications').set(auth(eng.token));
    expect(JSON.stringify(n.body)).toContain('درخواست بازدید تازه');
  });
});
