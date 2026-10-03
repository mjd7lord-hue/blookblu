import { describe, it, expect } from 'vitest';
import { multiRole, api, auth, FORMS, registered } from './helpers';
import { beforeAll, afterAll } from 'vitest';

/* فایل‌های نمونهٔ کوچک (فقط سرآیند درست کافی است) */
function seg(marker: number, payload: Buffer) {
  const h = Buffer.alloc(4);
  h[0] = 0xff;
  h[1] = marker;
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}
// JPEG با بخش EXIF که «مختصات GPS» دارد
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
  seg(0xe1, Buffer.from('Exif\0\0GPS-LAT-26.95-LNG-56.27', 'latin1')),
  seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF', 'latin1');
const EXE = Buffer.from('MZ\x90\0 this is not an image', 'latin1');

describe('files: avatar, portfolio, documents, chat attachments', () => {
  beforeAll(() => multiRole(true));
  afterAll(() => multiRole(false));
  it('avatar: upload, EXIF stripped, public, replace removes old, validation', async () => {
    const w = await registered('worker');

    const none = await api().put('/api/me/roles/worker/avatar').set(auth(w.token));
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('NO_FILE');

    const bad = await api().put('/api/me/roles/worker/avatar').set(auth(w.token)).attach('file', EXE, { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('FILE_TYPE');

    // PDF برای عکس پروفایل قبول نیست
    const pdf = await api().put('/api/me/roles/worker/avatar').set(auth(w.token)).attach('file', PDF, 'a.pdf');
    expect(pdf.body.error.code).toBe('FILE_TYPE');

    // نقشی که ثبت نشده
    const nr = await api().put('/api/me/roles/engineer/avatar').set(auth(w.token)).attach('file', JPEG, 'me.jpg');
    expect(nr.status).toBe(404);

    const up = await api().put('/api/me/roles/worker/avatar').set(auth(w.token)).attach('file', JPEG, 'me.jpg');
    expect(up.status).toBe(200);
    const url1 = up.body.avatarUrl as string;
    expect(url1).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/);

    // عمومی: بدون ورود، با هدر مناسب <img> بین‌دامنه‌ای، بدون GPS
    const img = await api().get(url1).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.from(img.body).includes(Buffer.from('GPS-LAT'))).toBe(false);
    expect(Buffer.from(img.body).includes(Buffer.from([0x12, 0x34, 0x56]))).toBe(true);

    const pub = await api().get(`/api/profiles/${w.profile.code}`);
    expect(pub.body.profile.avatarUrl).toBe(url1);
    const me = await api().get('/api/me').set(auth(w.token));
    expect(me.body.profiles[0].avatarUrl).toBe(url1);

    // عوض کردن عکس → فایل قبلی پاک می‌شود
    const up2 = await api().put('/api/me/roles/worker/avatar').set(auth(w.token)).attach('file', PNG, 'me.png');
    expect(up2.body.avatarUrl).not.toBe(url1);
    expect((await api().get(url1)).status).toBe(404);
    expect((await api().get(up2.body.avatarUrl)).headers['content-type']).toBe('image/png');

    await api().delete('/api/me/roles/worker/avatar').set(auth(w.token)).expect(200);
    expect((await api().get(`/api/profiles/${w.profile.code}`)).body.profile.avatarUrl).toBeNull();
    expect((await api().get(up2.body.avatarUrl)).status).toBe(404);
  });

  it('portfolio: add, public view, edit, owner-only delete, limit', async () => {
    const s = await registered('specialist');
    const other = await registered('worker');

    const noTitle = await api().post('/api/me/roles/specialist/portfolio').set(auth(s.token)).attach('file', JPEG, 'a.jpg');
    expect(noTitle.status).toBe(400);

    const add = await api()
      .post('/api/me/roles/specialist/portfolio')
      .set(auth(s.token))
      .field('title', 'آرماتوربندی سقف ویلای ۲ طبقه')
      .field('place', 'قشم')
      .field('when', 'مهر ۱۴۰۵')
      .attach('file', JPEG, 'work.jpg');
    expect(add.status).toBe(201);
    // ارقام فارسی و نیم‌فاصله دست‌نخورده
    expect(add.body.item.title).toBe('آرماتوربندی سقف ویلای ۲ طبقه');
    expect(add.body.item.when).toBe('مهر ۱۴۰۵');
    const id = add.body.item.id;

    const pub = await api().get(`/api/profiles/${s.profile.code}`);
    expect(pub.body.profile.portfolio).toHaveLength(1);
    expect(pub.body.profile.portfolio[0].place).toBe('قشم');
    expect((await api().get(pub.body.profile.portfolio[0].url)).status).toBe(200);

    const edit = await api().patch(`/api/me/portfolio/${id}`).set(auth(s.token)).send({ title: 'بتن‌ریزی سقف', place: null });
    expect(edit.body.item.title).toBe('بتن‌ریزی سقف');
    expect(edit.body.item.place).toBeNull();

    // دیگری نمی‌تواند حذف یا ویرایش کند
    expect((await api().delete(`/api/me/portfolio/${id}`).set(auth(other.token))).status).toBe(404);
    expect((await api().patch(`/api/me/portfolio/${id}`).set(auth(other.token)).send({ title: 'هک' })).status).toBe(404);

    const list = await api().get('/api/me/roles/specialist/portfolio').set(auth(s.token));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.max).toBe(12);

    // سقف ۱۲ نمونه‌کار
    for (let i = 0; i < 11; i++) {
      const r = await api().post('/api/me/roles/specialist/portfolio').set(auth(s.token)).field('title', `کار شمارهٔ ${i}`).attach('file', PNG, 'p.png');
      expect(r.status).toBe(201);
    }
    const full = await api().post('/api/me/roles/specialist/portfolio').set(auth(s.token)).field('title', 'یکی بیشتر').attach('file', PNG, 'p.png');
    expect(full.body.error.code).toBe('PORTFOLIO_FULL');

    const fileUrl = pub.body.profile.portfolio[0].url;
    await api().delete(`/api/me/portfolio/${id}`).set(auth(s.token)).expect(200);
    expect((await api().get(fileUrl)).status).toBe(404);
    expect((await api().get(`/api/profiles/${s.profile.code}`)).body.profile.portfolio).toHaveLength(11);
  });

  it('documents: private, signed links only, never on public profile', async () => {
    const e = await registered('engineer');
    const stranger = await registered('worker');

    const up = await api()
      .post('/api/me/documents')
      .set(auth(e.token))
      .field('title', 'پروانهٔ اشتغال نظام مهندسی')
      .field('group', 'پروانه')
      .field('role', 'engineer')
      .attach('file', PDF, { filename: 'پروانه.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const d = up.body.document;
    expect(d.status).toBe('pending');
    expect(d.role).toBe('engineer');
    expect(d.file.mime).toBe('application/pdf');
    expect(d.file.name).toBe('پروانه.pdf');
    expect(d.file.url).toMatch(/\?exp=\d+&sig=[0-9a-f]{32}$/);

    // لینک امضاشده کار می‌کند
    const got = await api().get(d.file.url).buffer(true);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('application/pdf');

    const bare = d.file.url.split('?')[0];
    // بدون امضا: غریبه و مهمان «پیدا نشد»، صاحب مدرک با توکن اجازه دارد
    expect((await api().get(bare)).status).toBe(404);
    expect((await api().get(bare).set(auth(stranger.token))).status).toBe(404);
    expect((await api().get(bare).set(auth(e.token))).status).toBe(200);
    // امضای دست‌کاری‌شده یا منقضی
    expect((await api().get(d.file.url.replace(/sig=.{4}/, 'sig=0000'))).status).toBe(404);
    const sig = d.file.url.split('sig=')[1];
    expect((await api().get(`${bare}?exp=1000&sig=${sig}`)).status).toBe(404);

    // مدرک هرگز در پروفایل عمومی نیست
    const pub = await api().get(`/api/profiles/${e.profile.code}`).set(auth(stranger.token));
    expect(JSON.stringify(pub.body)).not.toContain(d.id);
    expect(JSON.stringify(pub.body)).not.toContain('پروانهٔ اشتغال');

    // تکراری در حال بررسی
    const dup = await api().post('/api/me/documents').set(auth(e.token)).field('title', 'پروانهٔ اشتغال نظام مهندسی').field('role', 'engineer').attach('file', JPEG, 'a.jpg');
    expect(dup.status).toBe(409);

    // مدرک هویتی مشترک (بدون نقش)
    const idc = await api().post('/api/me/documents').set(auth(e.token)).field('title', 'کارت ملی').field('group', 'هویت').attach('file', JPEG, 'id.jpg');
    expect(idc.body.document.role).toBeNull();

    const list = await api().get('/api/me/documents').set(auth(e.token));
    expect(list.body.items.map((x: { title: string }) => x.title)).toEqual(['کارت ملی', 'پروانهٔ اشتغال نظام مهندسی']);
    expect((await api().get('/api/me/documents').set(auth(stranger.token))).body.items).toHaveLength(0);

    expect((await api().delete(`/api/me/documents/${d.id}`).set(auth(stranger.token))).status).toBe(404);
    await api().delete(`/api/me/documents/${d.id}`).set(auth(e.token)).expect(200);
    expect((await api().get(d.file.url)).status).toBe(404);
  });

  it('chat attachments: members only, preview, delete removes file', async () => {
    const boss = await registered('contractor');
    const w = await registered('worker');
    const stranger = await registered('specialist');
    const c = await api().post('/api/conversations').set(auth(boss.token)).send({ profileCode: w.profile.code });
    const cid = c.body.conversation.id;

    // غریبه نمی‌تواند در گفت‌وگو فایل بفرستد
    const nope = await api().post(`/api/conversations/${cid}/attachments`).set(auth(stranger.token)).attach('file', JPEG, 'a.jpg');
    expect(nope.status).toBe(404);

    const sent = await api()
      .post(`/api/conversations/${cid}/attachments`)
      .set(auth(boss.token))
      .field('caption', 'نقشهٔ طبقهٔ دوم')
      .attach('file', JPEG, 'plan.jpg');
    expect(sent.status).toBe(201);
    expect(sent.body.message.kind).toBe('photo');
    expect(sent.body.message.body).toBe('نقشهٔ طبقهٔ دوم');
    expect(sent.body.message.payload.mime).toBe('image/jpeg');

    const pdf = await api().post(`/api/conversations/${cid}/attachments`).set(auth(w.token)).attach('file', PDF, 'estimate.pdf');
    expect(pdf.body.message.kind).toBe('file');
    expect(pdf.body.message.payload.name).toBe('estimate.pdf');

    // طرف مقابل لینک امضاشده می‌گیرد و فایل را می‌بیند
    const msgs = await api().get(`/api/conversations/${cid}/messages`).set(auth(w.token));
    const photo = msgs.body.items.find((m: { kind: string }) => m.kind === 'photo');
    expect(photo.payload.url).toMatch(/sig=/);
    expect((await api().get(photo.payload.url)).status).toBe(200);
    const bare = photo.payload.url.split('?')[0];
    expect((await api().get(bare).set(auth(w.token))).status).toBe(200);
    expect((await api().get(bare).set(auth(stranger.token))).status).toBe(404);

    const list = await api().get('/api/conversations').set(auth(boss.token));
    expect(list.body.items[0].last.text).toContain('📎 فایل');

    // حذف پیام → فایل هم پاک می‌شود
    await api().delete(`/api/messages/${photo.id}`).set(auth(boss.token)).expect(200);
    expect((await api().get(photo.payload.url)).status).toBe(404);
  });

  it('deleting a role or the account removes its files', async () => {
    const u = await registered('worker');
    await api().post('/api/me/roles').set(auth(u.token)).send({ role: 'specialist', data: FORMS.specialist }).expect(201);
    const av = await api().put('/api/me/roles/specialist/avatar').set(auth(u.token)).attach('file', JPEG, 'a.jpg');
    const pf = await api().post('/api/me/roles/specialist/portfolio').set(auth(u.token)).field('title', 'کاشی‌کاری').attach('file', PNG, 'p.png');
    await api().delete('/api/me/roles/specialist').set(auth(u.token)).expect(200);
    expect((await api().get(av.body.avatarUrl)).status).toBe(404);
    expect((await api().get(pf.body.item.url)).status).toBe(404);

    const av2 = await api().put('/api/me/roles/worker/avatar').set(auth(u.token)).attach('file', JPEG, 'a.jpg');
    const doc = await api().post('/api/me/documents').set(auth(u.token)).field('title', 'کارت ملی').attach('file', JPEG, 'id.jpg');
    await api().delete('/api/me').set(auth(u.token)).send({ confirm: 'DELETE' }).expect(200);
    expect((await api().get(av2.body.avatarUrl)).status).toBe(404);
    expect((await api().get(doc.body.document.file.url)).status).toBe(404);
  });
});
