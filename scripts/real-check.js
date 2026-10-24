/**
 * «همه‌چیز واقعی»: هر ۶ نقش با کاربر تازه وارد اپ می‌شوند، همهٔ صفحه‌ها باز می‌شود و
 * هر نام/متن دادهٔ نمایشی (نمونه‌های index.html) که در حالت متصل دیده شود گزارش می‌شود.
 *   npm run test:db ; npm run front:real
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
});
process.env.LOG_LEVEL = 'silent';
const { createApp } = require('../src/app');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const FRONT = path.resolve(__dirname, '../../blookblu-front') + '/';
let API = '';
const inline = (f) => () => '<script>' + fs.readFileSync(FRONT + f, 'utf8') + '</script>';
const html = fs
  .readFileSync(FRONT + 'index.html', 'utf8')
  .replace('<script src="flow.js"></script>', inline('flow.js'))
  .replace('<script src="live.js"></script>', inline('live.js'))
  .replace('<script src="live-projects.js"></script>', inline('live-projects.js'))
  .replace('<script src="live-more.js"></script>', inline('live-more.js'))
  .replace('<script src="work.js"></script>', inline('work.js'))
  .replace('<script src="hero46.js"></script>', inline('hero46.js'))
  .replace('<script src="hero47.js"></script>', inline('hero47.js'))
  .replace('<script src="urgent.js"></script>', inline('urgent.js'))
  .replace('<script src="explore.js"></script>', inline('explore.js'))
  .replace('<script src="i18n-extra.js"></script>', inline('i18n-extra.js'))
  .replace('<script src="trust36.js"></script>', inline('trust36.js'))
  .replace('<script src="real.js"></script>', inline('real.js'))
  .replace('<script src="desktop.js"></script>', inline('desktop.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

function browser(name) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) errors.push(`[${name}] ${e.message}\n${(e.detail && e.detail.stack) || e.stack || ''}`.slice(0, 900)); });
  vc.on('error', (...a) => errors.push(`[${name}] console.error ${a.join(' ')}`.slice(0, 400)));
  const dom = new JSDOM(html, {
    url: 'http://localhost:5500/?api=' + API,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.fetch = async (u, o = {}) => {
        const opt = Object.assign({}, o);
        delete opt.signal;
        if (opt.body && opt.body.constructor && opt.body.constructor.name === 'FormData' && !(opt.body instanceof FormData)) {
          const fd = new FormData();
          for (const [k, v] of opt.body.entries()) {
            if (typeof v === 'string') fd.append(k, v);
            else {
              // File در jsdom متد arrayBuffer ندارد؛ با FileReader خود jsdom خوانده می‌شود
              const buf = await new Promise((res, rej) => { const r = new w.FileReader(); r.onload = () => res(Buffer.from(r.result)); r.onerror = rej; r.readAsArrayBuffer(v); });
              fd.append(k, new Blob([buf], { type: v.type }), v.name);
            }
          }
          opt.body = fd;
        }
        return fetch(u, opt);
      };
    },
  });
  return dom.window;
}
async function until(fn, what, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(50); }
  throw new Error('منتظر ماند و نشد: ' + what);
}
const ev = (w, code) => w.eval(code);

async function login(w, phone10) {
  ev(w, `startAuth();S.reg.phone='${phone10}';document.getElementById('agr').checked=true;chkPhone();sendOtp()`);
  await until(() => ev(w, 'S.reg.step') === 'otp' && ev(w, 'S.reg.devCode'), 'OTP sent');
  const code = ev(w, 'S.reg.devCode');
  ev(w, `(()=>{const ins=[...document.querySelectorAll('#otp input')];'${code}'.split('').forEach((d,i)=>{ins[i].value=d;otpIn(ins[i],i)})})()`);
}
async function register(w, role, data) {
  await until(() => ev(w, 'S.reg.step') === 'role', 'role step');
  ev(w, `pickRole('${role}');Object.assign(S.reg.d, ${JSON.stringify(data)});S.reg.i=REG['${role}'].length-1;renderRegStep()`);
  if (!ev(w, 'stepOK()')) ev(w, `REG['${role}'].forEach(st=>st.f.forEach(f=>{if(f.req&&vis(f,S.reg.d)&&!filled(f,S.reg.d))console.error('field missing',f.k)}))`);
  ev(w, 'regNext()');
  await until(() => ev(w, 'S.reg.step') === 'done', 'registration done').catch((e) => { throw new Error(e.message + ' · پیام: ' + w.document.getElementById('toast').textContent + ' · مرحله ' + ev(w,'S.reg.i') + ' · داده ' + ev(w,'JSON.stringify(S.reg.d)')); });
  ev(w, 'finishAuth()');
  await until(() => ev(w, 'S.auth && LIVE.pub && LIVE.pub.code'), 'enter app');
}

// est (برآورد) فقط ماشین‌حساب با گزینه‌های ثابت است؛ دادهٔ کاربر ندارد
const SCREENS = ['home', 'explore', 'msg', 'me', 'notif', 'req', 'proj', 'myads', 'saved', 'cal', 'disp', 'team', 'visit', 'safe', 'arbj', 'pf', 'guar', 'docs', 'learn', 'stats', 'set', 'invite', 'about', 'roles', 'strikes', 'ctrs', 'qa', 'cmp', 'boost', 'sec'];
// همان فرم‌های معتبر تست‌ها (tests/helpers.ts)، با نام «آزمون واقعی» تا با نام‌های نمایشی قاطی نشود
const ROLES = {
  worker: { nat: 'ایرانی', prov: 'تهران', city: 'تهران', range: 'کل استان', skills: ['بنایی و دیوارچینی', 'بتن‌ریزی'], exp: '۵ تا ۱۰ سال', wage: '۱٬۸۰۰٬۰۰۰', team: 'تنها', days: [0, 2, 3], hours: 'تمام روز' },
  specialist: { nat: 'ایرانی', prov: 'تهران', city: 'تهران', range: 'فقط شهر خودم', skills: ['آرماتوربندی'], exp: 'بیش از ۱۰ سال', cert: 'دارم', rateType: 'متری', rate: '۹۵۰۰۰۰۰', team: 'تیم کامل', days: [0, 1] },
  contractor: { nat: 'ایرانی', prov: 'تهران', city: 'تهران', range: 'کل استان', kinds: ['اسکلت بتنی', 'سفت‌کاری'], exp: 'بیش از ۱۰ سال', contract: ['متری'], max: '۴ تا ۶ طبقه', lic: 'ندارم' },
  engineer: { nat: 'ایرانی', prov: 'تهران', city: 'تهران', range: 'کل استان', field: ['عمران'], grade: 'پایه ۱', nezam: '23-10-0456', nprov: 'تهران', comp: ['نظارت'], services: ['نظارت ساختمان'], days: [1, 4] },
  general: { nat: 'ایرانی', prov: 'تهران', city: 'تهران', need: 'بازسازی و تعمیرات', land: 'ساختمان موجود', budget: 'زیر ۵۰ میلیون' },
  company: { cname: 'شرکت آزمون واقعی', ctype: 'سهامی خاص', nid: '۱۰۸۶۱۲۳۴۵۶۷', prov: 'تهران', city: 'تهران', rank: 'رتبه ۳', areas: ['مسکونی'], staff: '۱۰ تا ۵۰', pos: 'مدیر پروژه' },
};

(async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  // ۱) دادهٔ نمایشی: یک مرورگر بدون سرور
  API = 'http://127.0.0.1:1';
  const D = browser('demo');
  await sleep(1500);
  const demo = new Set();
  // فقط نام‌ها و عنوان‌های چندکلمه‌ای (کلمهٔ تکی مثل «آرماتوربند» مهارت است، نه دادهٔ نمایشی)
  const add = (s) => { s = String(s || '').trim(); if (s.length >= 7 && /[آ-ی]/.test(s) && /\s/.test(s) && !/(پیش|بعد)$|^(امروز|دیروز|همین)/.test(s)) demo.add(s); };
  ev(D, 'Object.values(P).map(p=>p.name)').forEach(add);
  ev(D, "Object.values(P).flatMap(p=>[p.bio,p.title])").forEach(add);
  ev(D, 'ADS.map(a=>a.title)').forEach(add);
  ev(D, "(S.notifs||[]).map(n=>n.t)").forEach(add);
  ev(D, "Object.values(S.req||{}).flat().map(r=>r&&r.t)").forEach(add);
  ev(D, "Object.values(S.projs||{}).flat().map(p=>p&&p.t)").forEach(add);
  ev(D, "(S.convs||[]).map(c=>c.name||'')").forEach(add);
  // انبارهای نمایشی دیگر: همهٔ رشته‌های داخلشان
  ev(D, `(()=>{const out=[],seen=new Set();const walk=(v,d)=>{if(d>5||v==null)return;if(typeof v==='string'){out.push(v);return}if(typeof v!=='object'||seen.has(v))return;seen.add(v);Object.values(v).forEach(x=>walk(x,d+1))};
    [S.invited,S.sess,S.team,S.cal,S.today,S.rec,S.arbQ,S.arbR,S.ans,S.hold,S.disp,S.arbJobs,S.out,typeof VISITS!=='undefined'&&VISITS,typeof KPRJ!=='undefined'&&KPRJ,typeof CPRJ!=='undefined'&&CPRJ,typeof EVIS!=='undefined'&&EVIS].forEach(x=>walk(x,0));return out})()`).forEach(add);
  // عنوان‌های عمومی اپ که در هر دو حالت هست، دادهٔ نمایشی نیستند
  for (const s of [...demo]) if (/^(کارگر|متخصص|مهندس|پیمانکار|کارفرما|شرکت ساختمانی)$/.test(s)) demo.delete(s);
  D.close();
  API = 'http://localhost:' + server.address().port;
  console.log('متن‌های نمایشی برای جست‌وجو:', demo.size);

  const found = new Map();
  // مهمان (واردنشده): خانه و کاوش هم نباید دادهٔ نمایشی داشته باشد
  {
    const G = browser('guest');
    await until(() => G.LIVE && G.LIVE.on, 'boot guest');
    for (const sc of ['home', 'explore']) {
      ev(G, `go('${sc}')`); await sleep(900);
      const txt = (G.document.querySelector('#s-' + sc) || {}).textContent || '';
      const realT = ev(G, "ADS.filter(a=>a._live).map(a=>a.title+' '+(a.desc||''))").join('\n');
      for (const s of demo) if (txt.includes(s) && !realT.includes(s)) { const k = 'guest · ' + sc; if (!found.has(k)) found.set(k, new Set()); found.get(k).add(s.slice(0, 50)); }
      if (process.env.DUMP && sc === 'home') { console.log('\n[guest] خانه:'); [...G.document.querySelectorAll('#s-home > *')].forEach((x) => console.log('   ', (x.id ? '#' + x.id + ' ' : '') + String(x.className).slice(0, 24), '|', x.textContent.replace(/\s+/g, ' ').trim().slice(0, 110))); }
    }
    G.close();
    console.log('✓ guest');
  }
  for (const [role, data] of Object.entries(ROLES)) {
    const W = browser(role);
    await until(() => W.LIVE && W.LIVE.on, 'boot ' + role);
    await login(W, '19' + String(Date.now()).slice(-7));
    const d = Object.assign({ fn: 'آزمون', ln: 'واقعی', pub: true }, data);
    await register(W, role, d);
    for (const sc of SCREENS) {
      try { ev(W, `go('${sc}')`); } catch (e) { continue; }
      await sleep(sc === 'home' || sc === 'explore' ? 900 : 350);
      const root = W.document.querySelector('#s-' + sc);
      const txt = root ? root.textContent : '';
      // آگهی‌های واقعی دیتابیس تست ممکن است عنوانی شبیه نمونه‌ها داشته باشند
      const realT = ev(W, "ADS.filter(a=>a._live).map(a=>a.title+' '+(a.desc||''))").join('\n');
      for (const s of demo) {
        if (!txt.includes(s) || realT.includes(s)) continue;
        // کجای صفحه؟ نزدیک‌ترین بخش با عنوان
        let where = '';
        const el = [...root.querySelectorAll('*')].reverse().find((e) => e.children.length < 40 && e.textContent.includes(s));
        const sec = el && el.closest('.section, .hcard, .card, section');
        if (sec) { const h = sec.querySelector('h1,h2,h3,b'); where = (sec.id ? '#' + sec.id + ' ' : '') + (sec.className || '').toString().slice(0, 30) + (h ? ' «' + h.textContent.trim().slice(0, 30) + '»' : ''); }
        const k = role + ' · ' + sc; if (!found.has(k)) found.set(k, new Set()); found.get(k).add(s.slice(0, 50) + '  ← ' + where);
      }
    }
    if (process.env.DUMP) {
      ev(W, "go('home')"); await sleep(900);
      console.log(`\n[${role}] خانه:`);
      [...W.document.querySelectorAll('#s-home > *')].forEach((x) => console.log('   ', (x.id ? '#' + x.id + ' ' : '') + String(x.className).slice(0, 24), '|', x.textContent.replace(/\s+/g, ' ').trim().slice(0, 110)));
    }
    W.close();
    console.log('✓', role);
  }
  server.close();
  if (!found.size) { console.log('\nهیچ دادهٔ نمایشی در حالت متصل دیده نشد.'); process.exit(0); }
  console.log('\n⚠️ دادهٔ نمایشی در حالت متصل:');
  for (const [k, v] of found) { console.log('-', k); [...v].slice(0, 8).forEach((x) => console.log('     ', x)); }
  process.exit(1);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
