/**
 * آزمایش خودکار فرانت (blookblu-front: index.html + live.js) در برابر همین بک‌اند، در مرورگر شبیه‌سازی‌شده (jsdom).
 * دو کاربر: ورود با کد، ثبت‌نام، ثبت آگهی، کاوش، پاسخ، چت، پیشنهاد و تأیید توافق، اعلان، پروفایل، خروج.
 *   npm run test:db      (یک بار؛ PostgreSQL تست)
 *   npm test             (یک بار؛ جدول‌های دیتابیس تست را می‌سازد)
 *   npm run front:smoke  (مخزن فرانت باید کنار این پوشه باشد: ../blookblu-front)
 * روی دیتابیس تست کار می‌کند، نه Supabase.
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
const html = fs.readFileSync(FRONT + 'index.html', 'utf8').replace('<script src="live.js"></script>', () => '<script>' + fs.readFileSync(FRONT + 'live.js', 'utf8') + '</script>');
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
          for (const [k, v] of opt.body.entries()) fd.append(k, typeof v === 'string' ? v : new Blob([Buffer.from(await v.arrayBuffer())], { type: v.type }), v.name);
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

(async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  API = 'http://localhost:' + server.address().port;
  const log = (...a) => console.log('✓', ...a);
  // --- کاربر ۱: پیمانکار
  const A = browser('A');
  await until(() => A.LIVE && A.LIVE.on, 'boot A');
  log('بوت: متصل به سرور، دادهٔ نمایشی کنار رفت؛ آگهی‌ها:', ev(A, 'ADS.length'));
  await login(A, '12' + String(Date.now()).slice(-7));
  await register(A, 'contractor', { fn: 'مجید', ln: 'یحیایی', nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم', range: 'کل استان', kinds: ['اسکلت بتنی', 'سفت‌کاری'], exp: 'بیش از ۱۰ سال', contract: ['متری'], max: '۴ تا ۶ طبقه', lic: 'ندارم', pub: true, days: [0, 2] });
  log('ورود و ثبت‌نام پیمانکار:', ev(A, 'LIVE.pub.code'), ev(A, 'ME().name'), 'نقش', ev(A, 'S.role'));

  ev(A, "openWizard();Object.assign(S.w,{type:'job',title:'۳ کارگر برای بلوک‌چینی طبقهٔ دوم',desc:'حدود ۱۰ روز کار',aud:['worker'],place:'قشم',range:'استان',wageType:'روزانه',wage:'۱٬۸۰۰٬۰۰۰',start:'فوری',need:3});publish()");
  await until(() => ev(A, 'S.w.step') === 4, 'publish');
  const adId = ev(A, 'S.w.newId');
  log('ثبت آگهی واقعی:', adId, ev(A, 'ADS[0].wage'));

  // --- کاربر ۲: کارگر
  const B = browser('B');
  await until(() => B.LIVE && B.LIVE.on, 'boot B');
  await login(B, '35' + String(Date.now()).slice(-7));
  await register(B, 'worker', { fn: 'رضا', ln: 'بهمنی', nat: 'ایرانی', prov: 'هرمزگان', city: 'درگهان', range: 'کل استان', skills: ['بنایی و دیوارچینی', 'بتن‌ریزی'], exp: '۵ تا ۱۰ سال', wage: '۱٬۸۰۰٬۰۰۰', team: 'تنها', days: [0, 2, 3], hours: 'تمام روز' });
  log('ورود و ثبت‌نام کارگر:', ev(B, 'LIVE.pub.code'));
  ev(B, "S.provF=null;exploreMode('jobs')");
  await until(() => ev(B, `ADS.some(a=>a.id==='${adId}')`), 'ad visible in explore');
  log('کاوش: آگهی پیمانکار دیده شد؛ کارت‌ها در صفحه:', ev(B, "document.querySelectorAll('#results .acard').length"));

  ev(B, `openAd('${adId}')`);
  ev(B, `openRespond('${adId}')`);
  await until(() => B.document.getElementById('rsp'), 'respond sheet');
  ev(B, "document.getElementById('rsp').value='سلام، از فردا با دو همکار می‌آیم'");
  ev(B, "sent('x')");
  await until(() => ev(B, 'S.convs.length') > 0, 'conversation created');
  log('پاسخ به آگهی ← گفت‌وگو ساخته شد:', ev(B, 'S.convs[0].ctx && S.convs[0].ctx.title'));

  const cid = ev(B, 'S.convs[0].id');
  ev(B, `openChat('${cid}')`);
  await until(() => ev(B, 'S.cur') === 'chat', 'chat open B');
  ev(B, "sendText('ساعت ۷ صبح کارگاه هستیم')");
  await until(() => ev(B, `S.convs.find(c=>c.id==='${cid}').msgs.some(m=>m.me&&m.id&&m.t==='ساعت ۷ صبح کارگاه هستیم')`), 'text sent with id');
  log('ارسال پیام متنی (با شناسهٔ سرور)');

  await ev(A, 'LIVE.openConv(' + JSON.stringify(cid) + ')');
  await until(() => ev(A, 'S.cur') === 'chat', 'chat open A');
  const seen = ev(A, `S.convs.find(c=>c.id==='${cid}').msgs.filter(m=>m.k==='text').map(m=>m.t).join(' | ')`);
  log('پیمانکار پیام‌ها را می‌بیند:', seen);

  ev(A, "pushMsg({me:1,k:'deal',d:{job:'بلوک‌چینی طبقهٔ دوم',qty:'۱۲۰ متر',price:'۱٬۸۰۰٬۰۰۰ تومان روزانه',start:'شنبه ۱۲ مهر، ۷ صبح',dur:'۱۰ روز',plan:[['پیش‌پرداخت',30],['پایان کار',70]]},st:null},true)");
  await until(() => ev(A, `S.convs.find(c=>c.id==='${cid}').msgs.some(m=>m.k==='deal'&&m.id)`), 'deal sent');
  log('پیشنهاد توافق فرستاده شد');

  await sleep(300);
  B.eval(`S.convs.find(c=>c.id==='${cid}')._loaded=false`);
  ev(B, `openChat('${cid}')`);
  await until(() => ev(B, `S.convs.find(c=>c.id==='${cid}').msgs.some(m=>m.k==='deal')`), 'B sees deal');
  const di = ev(B, `S.convs.find(c=>c.id==='${cid}').msgs.findIndex(m=>m.k==='deal')`);
  ev(B, `ansDeal(${di},'ok')`);
  await until(() => ev(B, `S.convs.find(c=>c.id==='${cid}').msgs.some(m=>m.k==='sys'&&/توافق ثبت شد/.test(m.t))`), 'deal accepted');
  const proj = await ev(B, "LIVE.api('GET','/projects')");
  log('تأیید توافق ← پروژهٔ واقعی ساخته شد:', proj.items.length, proj.items[0] && proj.items[0].title, 'مرحله:', proj.items[0] && proj.items[0].stageName);

  await ev(A, 'LIVE.api("GET","/notifications").then(d=>{S.notifs=[];return d})');
  ev(A, "go('notif')");
  await sleep(200);
  const notifs = await ev(A, "LIVE.api('GET','/notifications')");
  log('اعلان‌های پیمانکار:', notifs.items.map((n) => n.title).join(' | '));

  ev(B, "openProfile('" + ev(A, 'LIVE.pub.code') + "')");
  await until(() => ev(B, 'S.cur') === 'profile', 'profile open');
  log('پروفایل پیمانکار از دید کارگر:', ev(B, `P['${ev(A, 'LIVE.pub.code')}'].name`), '· شهر', ev(B, `P['${ev(A, 'LIVE.pub.code')}'].place`));

  ev(A, "go('set')");
  log('تنظیمات:', ev(A, "[...document.querySelectorAll('#s-set .hint')].pop().textContent"));
  ev(A, 'logout()');
  await sleep(200);
  log('خروج:', ev(A, 'S.auth') === false ? 'انجام شد' : 'نشد', '· توکن ذخیره‌شده:', A.localStorage.getItem('blk-tok'));

  if (errors.length) { console.log('\n⚠️ خطاهای صفحه:\n' + errors.join('\n---\n')); process.exit(1); }
  console.log('\nهمه چیز درست کار کرد.');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); if (errors.length) console.log('\nخطاهای صفحه:\n' + errors.join('\n---\n')); process.exit(1); });
