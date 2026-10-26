/**
 * آزمایش خودکار پنل ادمین (../blookblu-admin) در مرورگر شبیه‌سازی‌شده (jsdom) در برابر همین API روی دیتابیس تست.
 * ورود مدیر با کد پیامکی، دادهٔ واقعی، تأیید هویت، تعلیق کاربر، ساخت مدیر تازه، تغییر دسترسی نقش.
 *   npm run test:db   (یک بار)   ·   npm test   (یک بار؛ جدول‌ها)   ·   npm run admin:smoke
 */
const path = require('path');
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://blook:blook@localhost:5432/blook_test',
  DIRECT_URL: '',
  DB_SSL: 'false',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: path.join(require('os').tmpdir(), 'blook-smoke-uploads'),
  OTP_DEV_ECHO: 'true',
  OTP_RESEND_SECONDS: '0',
  OTP_MAX_PER_HOUR: '100',
  SMS_PROVIDER: 'console',
  CORS_ORIGINS: '*',
  LOG_LEVEL: 'silent',
});
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { eq } = require('drizzle-orm');
const { createApp } = require('../src/app');
const { db } = require('../src/db');
const { users, adminRoles } = require('../src/db/schema');

const ADMIN = path.resolve(__dirname, '../../blookblu-admin') + '/';
const html = fs
  .readFileSync(ADMIN + 'index.html', 'utf8')
  .replace(/<script src="([^"]+)"><\/script>/g, (_, src) => '<script>' + fs.readFileSync(ADMIN + src, 'utf8') + '</script>')
  .replace(/<link[^>]+>/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let API = '';

async function until(fn, what, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(50); }
  throw new Error('منتظر ماند و نشد: ' + what);
}
async function call(method, p, body, token) {
  const isForm = body instanceof FormData;
  const r = await fetch(API + '/api' + p, { method, headers: Object.assign(isForm || !body ? {} : { 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: isForm ? body : body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p + ' → ' + JSON.stringify(d));
  return d;
}
async function user(phone, role, data) {
  const s = await call('POST', '/auth/otp/send', { phone });
  const v = await call('POST', '/auth/otp/verify', { phone, code: s.devCode });
  const r = await call('POST', '/me/roles', { role, data }, v.accessToken);
  return { phone, token: v.accessToken, profile: r.profile };
}

(async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  API = 'http://localhost:' + server.address().port;
  const h = await fetch(API + '/api/health').then((r) => r.json());
  if (h.db !== 'up') throw new Error('دیتابیس تست روشن نیست؛ اول بزن: npm run test:db');
  const log = (...a) => console.log('✓', ...a);
  const n = () => String(Date.now()).slice(-7);

  // مدیر ارشد و یک کارگر با درخواست احراز هویت
  const ownerPhone = '0912' + n();
  const owner = await user(ownerPhone, 'general', { fn: 'حسین', ln: 'صالحی', nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم', need: 'بازسازی و تعمیرات', land: 'ساختمان موجود', budget: 'زیر ۵۰ میلیون' });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.profile.userId));
  const w = await user('0935' + n(), 'worker', { fn: 'رضا', ln: 'بهمنی', nat: 'ایرانی', prov: 'هرمزگان', city: 'درگهان', range: 'کل استان', skills: ['بتن‌ریزی'], exp: '۵ تا ۱۰ سال', wage: '۱٬۸۰۰٬۰۰۰', team: 'تنها', days: [0, 2], hours: 'تمام روز' });
  const JPEG = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])], { type: 'image/jpeg' });
  const fd = new FormData(); fd.append('card', JPEG, 'card.jpg'); fd.append('selfie', JPEG, 'selfie.jpg');
  await call('POST', '/me/kyc', fd, w.token);

  // پنل
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented|Could not parse CSS/.test(e.message)) errors.push(e.message + '\n' + ((e.detail && e.detail.stack) || '').slice(0, 400)); });
  const dom = new JSDOM(html, {
    url: 'http://localhost:5501/?api=' + API,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
      win.scrollTo = () => {};
      win.fetch = (u, o = {}) => { const x = Object.assign({}, o); delete x.signal; return fetch(u, x); };
    },
  });
  const W = dom.window, ev = (c) => W.eval(c), $ = (id) => W.document.getElementById(id);
  await until(() => $('lgPh'), 'login screen');
  $('lgPh').value = ownerPhone;
  $('lgGo').click();
  await until(() => /[۰-۹]{5}/.test($('lgHint').textContent), 'otp sent');
  $('lgCode').value = $('lgHint').querySelector('b').textContent.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  $('lgOk').click();
  await until(() => W.ADMIN_LIVE.on && ev("S.page") === 'dash' && $('page').innerHTML.length > 500, 'dashboard');
  log('ورود مدیر با کد پیامکی ← داشبورد · مدیر:', ev('ME().n'), '· نقش:', ev('AROLES[ME().role].n'));
  log('دادهٔ واقعی: کاربران', ev('U.length'), '· نقش‌ها', ev('Object.keys(AROLES).length'), '· بخش‌های منو', ev("document.querySelectorAll('#side .sb-it:not([disabled])').length"));

  // داشبورد واقعی: بازدید، قیف، رویدادها
  await fetch(API + '/api/app/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 'smoke' + Date.now(), view: true }) });
  await W.ADMIN_LIVE.reload(); ev("go('dash')");
  await until(() => $('hero50') && W.document.querySelectorAll('#page .hcard').length === 1 && $('page').textContent.includes('اعلام آمادگی / پاسخ') && $('feed') && /ثبت‌نام کرد/.test($('feed').textContent), 'real dashboard');
  log('داشبورد واقعی (یک کارت):', $('hero50').querySelector('h2').textContent, '· بازدید امروز', $('hero50').querySelectorAll('.h50box')[1].querySelectorAll('b')[1].textContent, '· رویداد:', $('feed').querySelector('.t').textContent.slice(0, 50));

  // احراز هویت: تأیید مدرک کارگر
  const wid = w.profile.userId;
  ev("go('kyc')");
  await until(() => $('page').textContent.includes('رضا بهمنی'), 'kyc queue');
  // دیدن تصویر مدرک داخل پنل (لینک یک بار آدرس سرور داشته باشد، نه دو بار)
  await ev(`docShow('${wid}',0,'card')`);
  await until(() => $('mBody').querySelector('img'), 'document image modal');
  const src = $('mBody').querySelector('img').getAttribute('src');
  if ((src.match(/https?:\/\//g) || []).length !== 1 || !/\/api\/files\//.test(src)) throw new Error('لینک تصویر مدرک خراب است: ' + src);
  const img = await fetch(src);
  if (!img.ok) throw new Error('تصویر مدرک باز نشد: ' + img.status);
  log('تصویر مدرک داخل پنل باز شد (لینک امضاشدهٔ درست)');
  ev('closeModal()');
  ev(`docSet('${wid}',0,'ok')`);
  await until(async () => (await call('GET', '/me', null, w.token)).user.kycStatus === 'verified', 'kyc approved');
  await until(() => ev(`uById('${wid}').kyc`) === 'ok', 'panel refreshed');
  log('احراز هویت کارگر از پنل تأیید شد (نشان آبی)');
  // بعد از تأیید: کارت مدرک عکس واقعی دارد (نه کارت نمایشی تیره) و دوباره باز می‌شود
  ev(`openUser('${wid}','docs')`);
  await until(() => W.document.querySelector('.docimg img'), 'real document thumbnail');
  if (W.document.querySelector('.docth')) throw new Error('کارت نمایشی تیرهٔ مدرک هنوز هست');
  const th = W.document.querySelector('.docimg img').getAttribute('src');
  if (!(await fetch(th)).ok) throw new Error('عکس مدرک تأییدشده باز نشد');
  log('بازبینی دوباره: عکس کارت و سلفی بعد از تأیید هم دیده می‌شود ·', W.document.querySelectorAll('.docimg img').length, 'عکس');

  // تعلیق و فعال‌سازی
  ev(`userAct('${wid}','susp')`);
  await until(() => $('lvGo'), 'reason modal');
  $('lvGo').click();
  await until(() => ev(`uById('${wid}').st`) === 'susp', 'suspended');
  const blocked = await fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + w.token } });
  if (blocked.status !== 403) throw new Error('کاربر تعلیق‌شده هنوز دسترسی دارد');
  ev(`userAct('${wid}','ok')`);
  await until(() => ev(`uById('${wid}').st`) === 'ok', 'unsuspended');
  log('تعلیق کاربر (دسترسی قطع شد) و فعال‌سازی دوباره');

  // مدیر تازه با نقش «کارشناس احراز» در هرمزگان
  ev("go('admins')");
  ev('adminEdit()');
  const newPhone = '0936' + n();
  const nm = 'کارشناس آزمایشی ' + newPhone.slice(-4);
  ev(`document.getElementById('ff-n').value='${nm}';document.getElementById('ff-phone').value='${newPhone}';document.getElementById('ff-role').value='kyc';document.getElementById('ff-scope').value='هرمزگان'`);
  W.document.querySelector('#mBody .mf .btn.pri').click();
  await until(() => ev(`ADMINS.some(a=>a.n==='${nm}')`), 'admin created');
  const scope = ev(`ADMINS.find(a=>a.n==='${nm}').scope`);
  if (scope !== 'هرمزگان') throw new Error('محدودهٔ استان مدیر تازه درست ذخیره نشد: ' + scope);
  log('مدیر تازه ساخته شد:', ev(`AROLES[ADMINS.find(a=>a.n==='${nm}').role].n`), '·', scope);

  // تغییر دسترسی نقش
  const before = (await db.select().from(adminRoles).where(eq(adminRoles.key, 'kyc')))[0].perms.ads;
  ev("pmCycle('kyc','ads')");
  await until(async () => (await db.select().from(adminRoles).where(eq(adminRoles.key, 'kyc')))[0].perms.ads === (before + 1) % 3, 'role perms');
  log('دسترسی نقش «کارشناس احراز» به «آگهی‌ها» تغییر کرد:', before, '←', (before + 1) % 3);

  ev("go('audit')");
  await until(() => ev('AUDIT.length') >= 4, 'audit');
  log('گزارش فعالیت:', ev('AUDIT.slice(0,3).map(x=>x.t.split(" — ")[0]).join(" | ")'));

  /* ---------- بخش ب ---------- */
  const reload = () => ev('ADMIN_LIVE.reload().then(()=>rerender())');
  // گفت‌وگو: پیام مشکوک ← پنهان کردن ← پیام پشتیبانی
  const cv = await call('POST', '/conversations', { profileCode: w.profile.code }, owner.token);
  const cid = cv.conversation.id;
  await call('POST', `/conversations/${cid}/messages`, { kind: 'text', body: 'نصف دستمزد را کارت به کارت کن' }, w.token);
  await reload();
  ev("go('chats')");
  ev(`S.chat='${cid}';AFTER.chats()`);
  await until(() => ev(`convOf('${cid}')._loaded`), 'chat messages loaded');
  const fi = ev(`convOf('${cid}').msgs.findIndex(m=>m.flag)`);
  if (fi < 0) throw new Error('پیام مشکوک علامت نخورده');
  ev(`msgOp('${cid}',${fi},'hid')`);
  await until(async () => (await call('GET', `/conversations/${cid}/messages`, null, owner.token)).items.some((m) => m.kind === 'del'), 'message hidden');
  await until(() => $('admMsg'), 'admin composer');
  $('admMsg').value = 'پیش‌پرداخت خارج از توافق مجاز نیست.';
  ev('admSend()');
  await until(async () => (await call('GET', `/conversations/${cid}/messages`, null, w.token)).items.some((m) => m.admin), 'admin message');
  log('گفت‌وگو: پیام مشکوک پنهان شد و پیام پشتیبانی به هر دو طرف رسید');

  // پشتیبانی: کاربر می‌نویسد ← پاسخ از پنل
  const sup = await call('POST', '/app/support', {}, w.token);
  await call('POST', `/conversations/${sup.conversation.id}/messages`, { kind: 'text', body: 'کد تأیید پیامک دیر می‌رسد' }, w.token);
  await reload();
  ev("go('support')");
  const code = ev("TICKETS.find(t=>t.sub==='کد تأیید پیامک دیر می‌رسد').id");
  ev(`S.ticket='${code}';rerender()`);
  await until(() => $('tMsg'), 'ticket view');
  $('tMsg').value = 'سلام، بررسی شد؛ دوباره امتحان کن.';
  ev('tSend()');
  await until(async () => (await call('GET', `/conversations/${sup.conversation.id}/messages`, null, w.token)).items.some((m) => m.admin), 'ticket reply');
  await until(() => ev(`TICKETS.find(t=>t.id==='${code}').st`) === 'pending', 'ticket pending');
  log('پشتیبانی: تیکت', code, 'پاسخ گرفت (منتظر کاربر)');

  // اعلان همگانی به کارگرهای هرمزگان
  ev("go('notif')");
  ev("S.nd.t='آزمایش اعلان همگانی';S.nd.b='متن آزمایشی';S.nd.roles=['کارگر'];S.nd.provs=['هرمزگان'];rerender()");
  const est = W.document.querySelector('#page .num[style*="font-size:24px"]').textContent;
  ev('nSend(0)');
  await until(async () => JSON.stringify(await call('GET', '/notifications', null, w.token)).includes('آزمایش اعلان همگانی'), 'broadcast received');
  await until(() => ev('NOTIF_H.length') > 0 && ev('NOTIF_H[0].t') === 'آزمایش اعلان همگانی', 'broadcast history');
  log('اعلان همگانی رسید · گیرنده‌های تقریبی:', est, '· ارسال‌شده:', ev('NOTIF_H[0].sent'));

  // تنظیمات: خاموش/روشن کردن آکادمی (ذخیرهٔ خودکار)
  ev("go('settings')");
  ev("flagSet('academy')");
  await until(async () => (await call('GET', '/app/config')).flags.academy === false, 'flag saved');
  ev("flagSet('academy')");
  await until(async () => (await call('GET', '/app/config')).flags.academy === true, 'flag restored');
  // استوری تازه
  ev("go('stories')");
  ev("STORIES.push({t:'ایمنی گرما',s:'کار سنگین را به صبح ببر',p:'آب خنک و سایه لازم است',on:true,v:0});log('stories','استوری تازه ساخت');rerender()");
  await until(async () => (await call('GET', '/app/config')).stories.some((x) => x.t === 'ایمنی گرما'), 'story saved');
  // ضرایب: مبلغ پایهٔ داوری
  ev("go('coefs')");
  const base0 = (await call('GET', '/disputes/meta')).base;
  ev(`CFG.arb.base=${base0 + 100000};log('coefs','آزمایش');rerender()`);
  await until(async () => (await call('GET', '/disputes/meta')).base === base0 + 100000, 'coef saved');
  ev(`CFG.arb.base=${base0};log('coefs','برگشت');rerender()`);
  await until(async () => (await call('GET', '/disputes/meta')).base === base0, 'coef restored');
  log('تنظیمات، استوری و ضرایب داوری از پنل ذخیره شدند');

  // تازه‌های بلوک: انتشار نسخهٔ تازه + اعلان
  ev("go('settings')");
  await until(() => $('wnCard'), 'whats new card');
  const v0 = (await call('GET', '/app/config')).whatsNew.v;
  ev("ADMIN_LIVE.wnGet().items[0].t='رزرو بازدید مهندس';ADMIN_LIVE.wnSave(true)");
  await until(async () => (await call('GET', '/app/config')).whatsNew.v !== v0, 'whats new published');
  await until(async () => JSON.stringify(await call('GET', '/notifications', null, w.token)).includes('تازه‌های بلوک'), 'whats new notification');
  log('تازه‌های بلوک منتشر شد (نسخهٔ', (await call('GET', '/app/config')).whatsNew.v + ') و اعلانش به کاربران رسید');

  // دور ۳۴: درخواست تغییر نقش از اپ ← تأیید از پنل ← کاربر فرم نقش را پر می‌کند
  const rq = await call('POST', '/me/role-requests', { toRole: 'specialist', note: 'جوشکاری یاد گرفته‌ام' }, w.token);
  await W.ADMIN_LIVE.reload();
  ev("go('rolereq')");
  await until(() => $('page').textContent.includes('جوشکاری یاد گرفته‌ام') && $('page').querySelector('[onclick*="rrApprove"]'), 'role request page');
  ev(`rrApprove('${rq.request.id}')`);
  await until(() => $('rrGo'), 'approve modal');
  $('rrGo').click();
  await until(async () => (await call('GET', '/me', null, w.token)).user.roleUnlock === 'specialist', 'role unlocked');
  await call('POST', '/me/roles', { role: 'specialist', data: { fn: 'رضا', ln: 'بهمنی', nat: 'ایرانی', prov: 'هرمزگان', city: 'درگهان', range: 'کل استان', skills: ['جوشکاری و اسکلت فلزی'], exp: '۵ تا ۱۰ سال', cert: 'دارم', rateType: 'روزانه', rate: '۲.۵۰۰.۰۰۰', team: 'تنها', days: [0, 1] } }, w.token);
  const me2 = await call('GET', '/me', null, w.token);
  if (me2.user.activeRole !== 'specialist' || me2.profiles.find((p) => p.role === 'worker').isPublic) throw new Error('تغییر نقش کامل نشد');
  log('تغییر نقش: درخواست کارگر ← تأیید در پنل ← فرم متخصص ← نقش تازه فعال و نقش قبلی پنهان');
  // تغییر نقش مستقیم از کشوی کاربر
  ev(`openUser('${w.profile.userId}')`);
  await until(() => $('drBody') && $('drBody').querySelector('.ur-act'), 'user drawer role button');
  ev(`userRole('${w.profile.userId}')`);
  await until(() => $('urGo'), 'role unlock modal');
  W.document.querySelector('#urR button[data-v="general"]').click();
  $('urGo').click();
  await until(async () => !!(await call('GET', '/me', null, w.token)).user.roleUnlock, 'direct role unlock');
  log('تغییر نقش مستقیم از کشوی کاربر:', (await call('GET', '/me', null, w.token)).user.roleUnlock);

  // نیروی فوری و آماده به کار + محدودیت‌ها
  ev("go('urgent')");
  await until(() => $('page').textContent.includes('آماده به کار (روشن)'), 'urgent page');
  ev("S.f.ugt='ready';rerender()");
  ev("go('settings')");
  await until(() => $('lim_urgentHours'), 'limits card');
  ev("document.getElementById('lim_urgentHours').value='5';limSave()");
  await until(async () => (await call('GET', '/app/config')).limits.urgentHours === 5, 'limits saved');
  ev("document.getElementById('lim_urgentHours').value='3';limSave()");
  await until(async () => (await call('GET', '/app/config')).limits.urgentHours === 3, 'limits restored');
  log('نیروی فوری و آماده به کار در پنل؛ محدودیت‌ها ذخیره شد (اعتبار درخواست فوری ۵ ← ۳ ساعت)');
  if (!$('lim_guarMinTrust') || $('lim_guarMinTrust').value !== '70') throw new Error('شرط قیم در محدودیت‌ها نیست');

  // اخطار بدقولی (دور ۳۶)
  ev("S.f.stk='all';go('strikes')");
  await until(() => $('page').textContent.includes('اعتراض، منتظر تصمیم'), 'strikes page');
  log('صفحهٔ «اخطار بدقولی» و شرط قیم در تنظیمات');

  ev("go('status')");
  await until(() => $('page').textContent.includes('پایش شبانه‌روزی'), 'status page');
  ev("go('pay')");
  ev("go('audit')");
  log('وضعیت سرویس و صفحهٔ پرداخت بی‌خطا · آخرین فعالیت:', ev('AUDIT[0].t'));

  ev('openSwitch()');
  ev('ADMIN_LIVE.logout()');
  await until(() => $('lgPh'), 'logged out');
  log('خروج از پنل');

  if (errors.length) { console.log('\n⚠️ خطاهای صفحه:\n' + errors.join('\n---\n')); process.exit(1); }
  console.log('\nپنل ادمین درست کار کرد.');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); if (errors.length) console.log('\nخطاهای صفحه:\n' + errors.join('\n---\n')); process.exit(1); });
