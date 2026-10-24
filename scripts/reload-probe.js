/**
 * بررسی «بعد از باز شدن دوبارهٔ اپ، خانه چند ثانیه بعد می‌پرد»: ورود، ساخت پروژه، بعد بار کردن دوبارهٔ اپ با همان توکن و
 * snapshot ذخیره‌شده (مثل رفرش واقعی) و ثبت هر ۲۵۰ میلی‌ثانیه: صفحهٔ فعلی، کارت‌های خانه، برگهٔ باز، پیام.
 *   npx tsx scripts/reload-probe.js
 */
const path = require('path');
Object.assign(process.env, {
  NODE_ENV: 'development', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://blook:blook@localhost:5432/blook_test', DIRECT_URL: '', DB_SSL: 'false',
  STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: path.join(require('os').tmpdir(), 'blook-smoke-uploads'), OTP_DEV_ECHO: 'true', OTP_RESEND_SECONDS: '0', OTP_MAX_PER_HOUR: '100', SMS_PROVIDER: 'console', CORS_ORIGINS: '*', LOG_LEVEL: 'silent',
});
const { createApp } = require('../src/app');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const FRONT = path.resolve(__dirname, '../../blookblu-front') + '/';
let html = fs.readFileSync(FRONT + 'index.html', 'utf8');
for (const f of ['flow.js', 'live.js', 'live-projects.js', 'live-more.js', 'work.js', 'hero46.js', 'hero47.js', 'urgent.js', 'explore.js', 'i18n-extra.js', 'trust36.js', 'real.js', 'desktop.js']) html = html.replace(`<script src="${f}"></script>`, '<script>' + fs.readFileSync(FRONT + f, 'utf8') + '</script>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let API = '';
function browser(store, delay) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) console.log('JSERR', e.message); });
  return new JSDOM(html, {
    url: 'http://localhost:5500/?api=' + API, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      Object.entries(store || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.fetch = async (u, o = {}) => { const x = Object.assign({}, o); delete x.signal; if (delay) await sleep(delay); return fetch(u, x); };
    },
  }).window;
}
async function call(m, p, b, t) { const r = await fetch(API + '/api' + p, { method: m, headers: Object.assign(b ? { 'Content-Type': 'application/json' } : {}, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined }); return r.json(); }
async function user(phone, role, data) { const s = await call('POST', '/auth/otp/send', { phone }); const v = await call('POST', '/auth/otp/verify', { phone, code: s.devCode }); const r = await call('POST', '/me/roles', { role, data }, v.accessToken); return { token: v.accessToken, refresh: v.refreshToken, profile: r.profile, user: v.user }; }

(async () => {
  const server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  API = 'http://localhost:' + server.address().port;
  const n = String(Date.now()).slice(-7);
  const w = await user('0935' + n, 'worker', { fn: 'رضا', ln: 'بهمنی', nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم', range: 'کل استان', skills: ['بتن‌ریزی'], exp: '۵ تا ۱۰ سال', wage: '1800000', team: 'تنها', days: [0, 1], hours: 'تمام روز' });
  const c = await user('0912' + n, 'contractor', { fn: 'حسین', ln: 'صالحی', nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم', range: 'کل استان', kinds: ['سفت‌کاری'], exp: 'بیش از ۱۰ سال', contract: ['متری'], max: '۴ تا ۶ طبقه', lic: 'ندارم', pub: true });
  for (const t of ['بلوک‌چینی طبقهٔ دوم']) {
    const cv = await call('POST', '/conversations', { profileCode: w.profile.code }, c.token);
    const d = await call('POST', `/conversations/${cv.conversation.id}/deals`, { job: t, price: '۲.۰۰۰.۰۰۰ تومان روزانه', amount: 10000000, start: 'شنبه', durationDays: 5, plan: [{ title: 'پایان کار', pct: 100 }], steps: ['روز ۱', 'روز ۲', 'روز ۳'] }, w.token);
    const a = await call('POST', `/messages/${d.message.id}/answer`, { status: 'accepted' }, c.token);
    if (!a.project) { console.log('deal fail', JSON.stringify(a).slice(0, 200)); break; }
    // پروژهٔ دوم در گفت‌وگوی جدا لازم است؛ همان گفت‌وگو پروژهٔ فعال دارد
    await call('POST', `/projects/${a.project.id}/start`, null, w.token);
  }
  // بار اول: ورود کامل در مرورگر تا snapshot ذخیره شود
  const W1 = browser({ 'blk-tok': JSON.stringify({ a: w.token, r: w.refresh }) });
  await sleep(6000);
  W1.eval("go('home')"); await sleep(3000);
  const store = {}; for (let i = 0; i < W1.localStorage.length; i++) { const k = W1.localStorage.key(i); store[k] = W1.localStorage.getItem(k); }
  console.log('W1 home:', W1.eval("S.cur"), '| hero:', !!W1.document.getElementById('phHero'), '| snapshot keys:', Object.keys(store).join(','));
  W1.close();
  // بار دوم = رفرش (با کمی تأخیر شبکه مثل ایران ← Render)
  for (const delay of [0, 600]) {
    console.log(`\n--- reload (network delay ${delay}ms) ---`);
    const W = browser(store, delay);
    let last = '';
    for (let t = 0; t < 40; t++) {
      await sleep(250);
      let st;
      try {
        st = W.eval(`JSON.stringify([S.cur, S.auth, S.role, !!document.getElementById('phHero'), (document.querySelector('#phHero h2')||{}).textContent||'', [...document.querySelectorAll('#s-home > *')].length, document.getElementById('sheet').classList.contains('on') ? (document.getElementById('sheetTitle')||{}).textContent : '', (S.projs[S.role]||[]).length, window.scrollY])`);
      } catch (e) { st = 'ERR ' + e.message; }
      if (st !== last) { console.log((t + 1) * 250 + 'ms', st); last = st; }
    }
    W.close();
  }
  server.close(); process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
