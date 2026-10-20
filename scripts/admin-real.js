/**
 * «همه‌چیز واقعی» در پنل ادمین: مدیر واقعی وارد می‌شود، همهٔ صفحه‌های منو باز می‌شود و
 * هر نام/متن دادهٔ نمونه (assets/js/data/sample-data.js) که با اتصال به سرور دیده شود گزارش می‌شود.
 *   npm run test:db ; npm run admin:real
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
  const ownerPhone = '0913' + String(Date.now()).slice(-7);
  const owner = await user(ownerPhone, 'general', { fn: 'آزمون', ln: 'پنل', nat: 'ایرانی', prov: 'تهران', city: 'تهران', need: 'بازسازی و تعمیرات', land: 'ساختمان موجود', budget: 'زیر ۵۰ میلیون' });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.profile.userId));

  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented|Could not parse CSS/.test(e.message)) errors.push(e.message + '\n' + ((e.detail && e.detail.stack) || '').slice(0, 400)); });
  const dom = new JSDOM(html, {
    url: 'http://localhost:5501/?api=' + API, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
      win.scrollTo = () => {};
      win.fetch = (u, o = {}) => { const x = Object.assign({}, o); delete x.signal; return fetch(u, x); };
    },
  });
  const W = dom.window, ev = (c) => W.eval(c), $ = (id) => W.document.getElementById(id);
  await until(() => $('lgPh'), 'login screen');
  // دادهٔ نمونه (پیش از ورود هنوز در حافظه است)
  const demo = new Set();
  const add = (s) => { s = String(s || '').trim(); if (s.length >= 7 && /[آ-ی]/.test(s) && /\s/.test(s)) demo.add(s); };
  ev(`(()=>{const out=[],seen=new Set();const walk=(v,d)=>{if(d>4||v==null)return;if(typeof v==='string'){out.push(v);return}if(typeof v!=='object'||seen.has(v))return;seen.add(v);Object.values(v).forEach(x=>walk(x,d+1))};
    [U.map(u=>[u.name,u.bio]),ADS.map(a=>[a.title,a.desc]),PROJ.map(p=>p.t),CONVS.map(c=>[c.t,c.last,c.title,c.sub]),TICKETS.map(t=>[t.t,t.sub,t.title]),DISP.map(d=>d.sub),REPORTS.map(r=>r.why),ADMINS.map(a=>a.n),typeof FEED!=='undefined'?FEED.map(f=>f[1]):[]].forEach(x=>walk(x,0));return out})()`).forEach(add);
  console.log('متن‌های نمونه برای جست‌وجو:', demo.size);

  $('lgPh').value = ownerPhone;
  $('lgGo').click();
  await until(() => /[۰-۹]{5}/.test($('lgHint').textContent), 'otp sent');
  $('lgCode').value = $('lgHint').querySelector('b').textContent.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  $('lgOk').click();
  await until(() => W.ADMIN_LIVE.on && ev('S.page') === 'dash' && $('page').innerHTML.length > 500, 'dashboard');
  const pages = ev("NAV.flatMap(g=>g[1].map(x=>x[0]))");
  const found = new Map();
  for (const pg of pages) {
    try { ev(`go('${pg}')`); } catch (e) { continue; }
    await sleep(250);
    const tabs = [...W.document.querySelectorAll('#page .seg button, #page .tabs button')].slice(0, 8);
    const texts = [W.document.getElementById('page').textContent];
    for (const b of tabs) { try { b.click(); await sleep(120); texts.push(W.document.getElementById('page').textContent); } catch (e) {} }
    const txt = texts.join('\n') + '\n' + (W.document.getElementById('side') || {}).textContent;
    // نام‌ها و عنوان‌هایی که در دادهٔ واقعی سرور هم هست (مثلاً کاربر آزمایشی هم‌نام) نمونه نیستند
    const real = JSON.stringify(W.ADMIN_LIVE.snap || {});
    for (const s of demo) if (txt.includes(s) && !real.includes(s)) { if (!found.has(pg)) found.set(pg, new Set()); found.get(pg).add(s.slice(0, 60)); }
  }
  if (process.env.DUMP) for (const pg of process.env.DUMP.split(',')) { ev("go('" + pg + "')"); await sleep(300); console.log('\n[' + pg + ']', W.document.getElementById('page').textContent.replace(/\s+/g, ' ').slice(0, 900)); }
  server.close();
  if (errors.length) console.log('\nخطاهای صفحه:\n' + errors.slice(0, 5).join('\n---\n'));
  if (!found.size) { console.log('\nصفحه‌های پنل:', pages.length, '— هیچ دادهٔ نمونه‌ای با اتصال به سرور دیده نشد.'); process.exit(0); }
  console.log('\n⚠️ دادهٔ نمونه در پنل متصل:');
  for (const [k, v] of found) { console.log('-', k); [...v].slice(0, 8).forEach((x) => console.log('     ', x)); }
  process.exit(1);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
