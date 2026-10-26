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
const inline = (f) => () => '<script>' + fs.readFileSync(FRONT + f, 'utf8') + '</script>';
const html = fs
  .readFileSync(FRONT + 'index.html', 'utf8')
  .replace('<script src="flow.js"></script>', inline('flow.js'))
  .replace('<script src="live.js"></script>', inline('live.js'))
  .replace('<script src="live-projects.js"></script>', inline('live-projects.js'))
  .replace('<script src="live-more.js"></script>', inline('live-more.js'))
  .replace('<script src="work.js"></script>', inline('work.js'))
  .replace('<script src="hero46.js"></script>', inline('hero46.js'))
  .replace('<script src="urgent.js"></script>', inline('urgent.js'))
  .replace('<script src="explore.js"></script>', inline('explore.js'))
  .replace('<script src="i18n-extra.js"></script>', inline('i18n-extra.js'))
  .replace('<script src="trust36.js"></script>', inline('trust36.js'))
  .replace('<script src="real.js"></script>', inline('real.js'))
  .replace('<script src="pay.js"></script>', inline('pay.js'))
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
  // مثل پر شدن خودکار آیفون: کل کد در خانهٔ اول (باید بین ۵ خانه پخش شود)
  await until(() => ev(w, "document.querySelector('#otp input[autocomplete=one-time-code]')"), 'otp autofill field');
  ev(w, `(()=>{const f=document.querySelector('#otp input');f.value='${code}';otpIn(f,0)})()`);
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
  await until(() => A.LIVE && A.LIVE.on, 'boot A').catch(async (e) => {
    const h = await fetch(API + '/api/health').then((r) => r.json()).catch(() => ({}));
    throw new Error(e.message + (h.db === 'down' ? ' — دیتابیس تست روشن نیست؛ اول بزن: npm run test:db' : ''));
  });
  log('بوت: متصل به سرور، دادهٔ نمایشی کنار رفت؛ آگهی‌ها:', ev(A, 'ADS.length'));
  await login(A, '12' + String(Date.now()).slice(-7));
  await register(A, 'contractor', { fn: 'حسین', ln: 'صالحی', nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم', range: 'کل استان', kinds: ['اسکلت بتنی', 'سفت‌کاری'], exp: 'بیش از ۱۰ سال', contract: ['متری'], max: '۴ تا ۶ طبقه', lic: 'ندارم', pub: true, days: [0, 2] });
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

  /* ---------------- بخش ۲: پروژه (A کارفرما = پیمانکار، B مجری = کارگر) ---------------- */
  const click = (w, sel) => ev(w, `document.querySelector(${JSON.stringify(sel)}).click()`);
  for (const w of [A, B]) {
    ev(w, "go('proj')");
    await until(() => ev(w, 'S.projs[S.role] && S.projs[S.role].length && S.projs[S.role][0]._live'), 'projects list');
  }
  log('پروژه‌های من:', ev(A, 'S.projs[S.role][0].t'), '·', ev(A, 'PSTG[S.projs[S.role][0].stage]'));

  // قرارداد: هر دو با کد پیامکی امضا می‌کنند
  for (const w of [A, B]) {
    ev(w, 'openContract(0)');
    await until(() => ev(w, "S.cur==='ctr' && S.ctr[S.role+':0'] && S.ctr[S.role+':0']._c"), 'contract open');
    ev(w, "ctrSign(S.role+':0')");
    await until(() => /[۰-۹]{5}/.test(ev(w, "document.querySelector('#sb .sub').textContent")), 'sign code');
    const code = ev(w, "document.querySelector('#sb .sub b').textContent");
    ev(w, `document.getElementById('sigC').value='${code}'`);
    click(w, '#sb .cta');
    await until(() => ev(w, "S.ctr[S.role+':0'].me"), 'signed');
  }
  await until(() => ev(B, "S.ctr[S.role+':0']._c.status") === 'active', 'contract active');
  log('قرارداد با امضای پیامکی هر دو طرف فعال شد:', ev(B, "S.ctr[S.role+':0']._c.number"));
  const printed = await fetch(API + ev(B, "S.ctr[S.role+':0']._c.printUrl")).then((r) => r.text());
  if (!printed.includes('امضاشده و فعال')) throw new Error('نسخهٔ چاپی قرارداد درست نیست');

  ev(B, 'openProjPage(0)');
  await until(() => ev(B, "S.cur==='pdet'"), 'project page B');
  // پیشرفت کار: مجری فهرست «واحد ۱ تا ۳» می‌سازد و یکی را تیک می‌زند؛ کارفرما در کارت خانه می‌بیند
  if (!B.document.querySelector('#pgSec')) throw new Error('بخش «پیشرفت کار» در صفحهٔ پروژه نیست');
  ev(B, "pgEdit(0);stepPick('pg','units');stepN('pg',-1)");
  click(B, '#pgGo');
  await until(() => ev(B, "(S.projs[S.role][0]._x.progress||[]).length") === 3, 'progress list saved');
  ev(B, 'pgTick(0,0)');
  await until(async () => (await ev(B, "LIVE.api('GET','/projects/'+S.projs[S.role][0]._id)")).project.progress.filter((x) => x.done).length === 1, 'progress ticked on server');
  await ev(A, 'LIVE.loadProjects(true)');
  ev(A, "go('home')");
  await until(() => /۳۳٪/.test((A.document.querySelector('#phHero') || {}).textContent || '') && A.document.querySelector('#phHero .ph-art'), 'home project hero').catch((e) => {
    throw new Error(e.message + ' · ' + JSON.stringify(ev(A, "[S.cur,S.role,(S.projs[S.role]||[]).map(p=>[p.stage,p.status,(p._x&&p._x.progress||[]).length])]")) + ' · ' + [...A.document.querySelectorAll('#s-home > *')].map((x) => x.className + ':' + x.textContent.trim().slice(0, 30)).join(' | '));
  });
  log('پیشرفت کار: مجری تیک زد ← کارت اصلی خانهٔ کارفرما (با انیمیشن):', A.document.querySelector('#phHero .ph-who').textContent.trim(), '·', A.document.querySelector('#phHero .ph-kpi b').textContent);
  // دور ۴۶: طرح مهارت روی کارت و ویرایش فهرست کار از برگهٔ «مدیریت پروژه»
  if (!A.document.querySelector('#phHero .h46[data-k="mason"]')) throw new Error('طرح مهارت (بنایی) روی کارت خانه نیست');
  ev(B, "go('home')");
  await until(() => B.document.querySelector('#phHero .h46'), 'B hero');
  ev(B, 'h46Manage(0)');
  ev(B, "document.getElementById('m46In').value='نظافت پایان کار';m46Add()");
  ev(B, 'm46Save()');
  await until(async () => (await ev(B, "LIVE.api('GET','/projects/'+S.projs[S.role][0]._id)")).project.progress.length === 4, 'task added from manage sheet');
  log('مدیریت پروژه از کارت خانه: کار تازه به فهرست اضافه و روی سرور ذخیره شد');
  // دور ۴۹: «ابزارک‌ها» جای «ثبت آگهی» در دسترسی سریع؛ محاسبهٔ بتن و کاشی
  ev(B, 'closeSheet()');
  const qa = B.document.querySelector('#qa42');
  if (!qa || /ثبت آگهی/.test(qa.textContent) || !/ابزارک‌ها/.test(qa.textContent)) throw new Error('دسترسی سریع: «ابزارک‌ها» نیست یا «ثبت آگهی» مانده');
  [...qa.querySelectorAll('button')].find((b) => /ابزارک‌ها/.test(b.textContent)).click();
  await until(() => B.document.querySelector('#sb .tl-grid'), 'tools sheet');
  ev(B, "tlOpen('conc');['tlL','tlW','tlH'].forEach((k,i)=>document.getElementById(k).value=['۵','۴','۱۰'][i]);tlCalc()");
  const conc = B.document.getElementById('tlOut').textContent;
  if (!/۱۵ کیسه/.test(conc)) throw new Error('محاسبهٔ بتن اشتباه است: ' + conc);
  ev(B, "TS49.tile=2;tlOpen('tile');document.getElementById('tlL').value='۴';document.getElementById('tlW').value='۳/۵';tlCalc()");
  const tile = B.document.getElementById('tlOut').textContent;
  if (!/۴۲ عدد/.test(tile)) throw new Error('محاسبهٔ کاشی اشتباه است: ' + tile);
  ev(B, 'closeSheet()');
  // دور ۵۰: شماره فقط ۱۱ رقم؛ +98 و بدون صفر به ۰۹… تبدیل می‌شود
  const ph = (v) => ev(B, `(()=>{const el=document.createElement('input');el.value='${v}';const r0=S.reg;S.reg={...r0};phIn(el);const out=[el.value,S.reg.phOk];S.reg=r0;return out.join('|')})()`);
  for (const [v, want] of [['+989121234567', '09121234567|true'], ['۰۹۱۲۱۲۳۴۵۶۷۸۹', '09121234567|true'], ['9121234567', '09121234567|true'], ['0912', '0912|false']]) {
    if (ph(v) !== want) throw new Error(`شماره «${v}» ← ${ph(v)} (باید ${want})`);
  }
  log('ورود شماره: فقط ۱۱ رقم، +98 و بدون صفر درست تبدیل می‌شود');
  log('ابزارک‌ها: بتن ۵×۴×۱۰ ← ۱۵ کیسه سیمان؛ کاشی ۶۰×۶۰ برای ۴×۳٫۵ متر ← ۴۲ عدد');
  // پرداخت: فقط کارفرما ثبت می‌کند؛ مجری دریافت را تأیید می‌کند
  if (B.document.querySelector('#s-pdet .sec-head button[onclick^="addPay"]')) throw new Error('مجری نباید دکمهٔ «ثبت پرداخت» ببیند');
  ev(A, 'openProjPage(0)');
  await until(() => ev(A, "S.cur==='pdet'"), 'project page A');
  ev(A, "addPay(S.role+':0')");
  ev(A, "document.getElementById('payA').value='۲.۰۰۰.۰۰۰'");
  ev(A, `document.getElementById('payT').value='${String(Date.now()).slice(-10)}'`);
  click(A, '#sb .cta');
  await until(() => ev(A, "(S.pays[S.role+':0']||[]).length") === 1, 'payment recorded');
  ev(B, 'openProjPage(0)');
  await until(() => ev(B, "S.cur==='pdet' && document.querySelector('#s-pdet [data-act=confirm]')"), 'confirm button');
  click(B, '#s-pdet [data-act=confirm]');
  await until(() => B.document.getElementById('pyGo'), 'confirm receipt sheet');
  ev(B, "document.getElementById('pyOk').checked=true;document.getElementById('pyGo').click()");
  await until(() => ev(B, "S.pays[S.role+':0'][0]._x.status") === 'confirmed', 'payment confirmed');
  log('دفترچهٔ پرداخت: کارفرما با شمارهٔ پیگیری ثبت کرد، مجری دریافت را تأیید کرد —', ev(B, "S.pays[S.role+':0'][0].f"), '· مستند:', ev(B, "S.pays[S.role+':0'][0]._x.documented"));

  // شروع کار
  ev(B, 'advProj(0)');
  await until(() => ev(B, 'S.projs[S.role][0].stage') === 2, 'work started');
  log('شروع کار ← مرحله:', ev(B, 'PSTG[S.projs[S.role][0].stage]'));

  /* ---- دور ۳۶: خوش‌قولی، قراردادهای من، آموزش، قفل اطلاعات اصلی، قیم ---- */
  ev(B, 'openProjPage(0)');
  await until(() => B.document.querySelector('#s-pdet .pj36') && B.document.querySelector('#s-pdet .bar .hq'), 'reliability section on project page');
  // درخواست لغو با توافق ← طرف مقابل بنر را می‌بیند و «ادامهٔ قرارداد» می‌زند
  ev(A, 'openProjPage(0)');
  await until(() => A.document.querySelector('#s-pdet .pj36'), 'A project page');
  ev(A, 'pjCancel()');
  ev(A, "document.getElementById('pjC').value='نقشه عوض شد'");
  ev(A, 'pjCancelGo(false)');
  await until(() => ev(A, 'S.projs[S.role][0]._x.cancelReq && S.projs[S.role][0]._x.cancelReq.mine'), 'cancel requested');
  await ev(B, 'LIVE.loadProjects(true)');
  ev(B, 'openProjPage(0)');
  await until(() => B.document.querySelector('#s-pdet .cq-ban .y'), 'cancel banner for the other side');
  ev(B, 'pjCancelAns(false)');
  await until(() => ev(B, 'S.projs[S.role][0]._x.cancelReq === null && S.projs[S.role][0].status === "active"'), 'cancel declined');
  log('لغو با توافق: درخواست پیمانکار ← کارگر بنر را دید و «ادامهٔ قرارداد» زد');
  // بدقولی: کارفرما ثبت می‌کند، کارگر اعتراض می‌کند
  ev(A, 'openProjPage(0)');
  await until(() => A.document.querySelector('#s-pdet .pj36'), 'A project page 2');
  ev(A, 'pjReport()');
  ev(A, "document.getElementById('pjN').value='دیروز سر کار نیامد'");
  ev(A, 'pjReportGo()');
  await until(async () => (await ev(A, "LIVE.api('GET','/strikes')")).byMe.length === 1, 'strike reported');
  ev(B, "S.stk.at=0;go('strikes')");
  await until(() => B.document.querySelector('#s-strikes .stk .acts'), 'strike to answer');
  const sid = (await ev(B, "LIVE.api('GET','/strikes')")).against[0].id;
  ev(B, `stkAnswer('${sid}',false,'ماشین خراب شد و خبر دادم')`);
  await until(async () => (await ev(B, "LIVE.api('GET','/strikes')")).against[0].status === 'disputed', 'strike disputed');
  log('بدقولی: پیمانکار ثبت کرد ← کارگر در «خوش‌قولی و اخطارها» اعتراض زد');
  // قراردادهای من
  ev(B, "S.ctrs.items=null;go('ctrs')");
  await until(() => B.document.querySelectorAll('#s-ctrs .ctr-card').length === 1, 'contracts archive');
  log('قراردادهای من:', B.document.querySelector('#s-ctrs .ctr-card .no').textContent, '·', B.document.querySelector('#s-ctrs .ctr-card .tag').textContent);
  // منوی «من»، آموزش، قفل اطلاعات اصلی، قیم
  ev(B, "go('me')");
  await until(() => B.document.querySelectorAll('#s-me .m36').length === 3, 'me tiles');
  ev(B, "tutOpen('home')");
  if (!B.document.querySelector('#sb .tut-ph .scr')) throw new Error('آموزش متحرک باز نشد');
  ev(B, 'tutGo(1);closeSheet()');
  ev(B, 'openEditAll()');
  await until(() => B.document.querySelectorAll('#s-edit .lkf').length >= 2, 'locked main info');
  if (B.document.querySelector('#s-edit #rf_fn')) throw new Error('نام نباید در ویرایش قابل تغییر باشد');
  ev(B, "go('guar')");
  await until(() => B.document.querySelector('#s-guar .elig36 .elig i.n'), 'guarantor eligibility');
  log('منوی «من» (قراردادها، خوش‌قولی، راهنما)، آموزش «؟»، قفل نام، شرط قیم: درست');

  // صورت‌وضعیت: مجری ردیف اضافه و ارسال می‌کند، کارفرما تأیید
  ev(B, 'openSov(0)');
  await until(() => ev(B, "S.cur==='sov' && document.getElementById('sovAdd2')"), 'sov open');
  if (!B.document.querySelector('#s-sov .sov-guide')) throw new Error('راهنمای صورت‌وضعیت نیست');
  // صورت‌وضعیت ساده: کار + مبلغ + درصد انجام‌شده (بدون مقدار کل و فی)
  click(B, '#sovAdd2');
  ev(B, "document.getElementById('svN').value='بلوک‌چینی دیوار طبقهٔ دوم';document.getElementById('svA').value='۵۰.۴۰۰.۰۰۰';document.querySelector('#svP [data-v=\"50\"]').click()");
  click(B, '#svGo');
  ev(B, "sovQ(S.role+':0',0,1)");
  if (ev(B, "S.sov[S.role+':0'].items[0].done") !== 60) throw new Error('دکمهٔ + درصد را ۱۰ تا بالا نبرد');
  ev(B, "sovSend(S.role+':0')");
  await until(() => ev(B, "S.sov[S.role+':0'].st") === 'sent', 'sov sent');
  ev(A, 'openSov(0)');
  await until(() => ev(A, "document.getElementById('sovOk')"), 'approve button');
  click(A, '#sovOk');
  await until(() => ev(A, "S.sov[S.role+':0'].st") === 'ok', 'sov approved');
  log('صورت‌وضعیت ساده (۶۰٪ از ۵۰.۴۰۰.۰۰۰): ارسال مجری و تأیید کارفرما —', ev(A, "S.sov[S.role+':0']._s.totals.payable"), 'تومان قابل پرداخت');
  if (A.document.querySelector('#s-sov .sv-pay') == null) throw new Error('خلاصهٔ «قابل پرداخت» ساده نیست');

  // گزارش روزانه
  ev(B, 'openProjPage(0)');
  await until(() => ev(B, "S.cur==='pdet'"), 'project page again');
  ev(B, "addDaily(S.role+':0')");
  ev(B, "document.getElementById('dDone').value='بلوک‌چینی دیوار شمالی طبقهٔ دوم';document.getElementById('crewN').value='۵'");
  click(B, '#sb .cta');
  await until(() => ev(B, "(S.daily[S.role+':0']||[]).length") === 1, 'daily saved').catch((e) => { throw new Error(e.message + ' · ' + B.document.getElementById('toast').textContent); });
  log('گزارش روزانه ثبت شد:', ev(B, "S.daily[S.role+':0'][0].done"));

  // حل اختلاف ← درخواست داوری حضوری (مهلت گفت‌وگو را در دیتابیس تست تمام می‌کنیم)
  ev(A, "go('disp')");
  await until(() => ev(A, "S.cur==='disp'"), 'disp page');
  ev(A, 'dispNew()');
  await until(() => ev(A, "document.getElementById('dpD')"), 'dispute form');
  ev(A, "document.getElementById('dpD').value='کیفیت ملات دیوار مطابق قرارداد نیست.'");
  ev(A, 'dispSave()');
  await until(() => ev(A, 'S.disp.length') === 1, 'dispute saved');
  const { db } = require('../src/db');
  const { disputes } = require('../src/db/schema');
  const { eq } = require('drizzle-orm');
  await db.update(disputes).set({ talkUntil: new Date(Date.now() - 1000) }).where(eq(disputes.id, ev(A, 'S.disp[0].id')));
  await ev(A, 'LIVE.loadDisputes(true)');
  ev(A, "arbAsk(S.disp[0].id);S.arbQ.field='mas';S.arbQ.ok=true;arbPay()");
  await until(() => ev(A, "S.disp[0].arb && S.disp[0].arb._c.status") === 'awaiting_payment', 'arbitration requested');
  log('داوری حضوری درخواست شد؛ منتظر پرداخت امانی:', ev(A, 'S.disp[0].arb._c.total'), 'تومان');

  /* ---------------- بخش ۳: آگهی‌های من، پاسخ‌ها، درخواست‌ها، ذخیره‌ها، تقویم ---------------- */
  ev(A, "go('myads')");
  await until(() => ev(A, `ADS.some(a=>a.id==='${adId}'&&a.who==='me'&&a.st==='active')`), 'my ads');
  ev(A, `adSt('${adId}','paused')`);
  await until(() => ev(A, `ADS.find(a=>a.id==='${adId}').st`) === 'paused', 'ad paused');
  ev(A, `adSt('${adId}','active')`);
  await until(() => ev(A, `ADS.find(a=>a.id==='${adId}').st`) === 'active', 'ad active');
  ev(A, `respList('${adId}')`);
  await until(() => ev(A, "document.querySelectorAll('#sb .rs').length") === 1, 'responses list');
  ev(A, `acceptResp('${adId}','${ev(B, 'LIVE.pub.code')}')`);
  await until(async () => (await ev(A, "LIVE.api('GET','/responses?dir=in')")).items[0].status === 'accepted', 'response accepted');
  log('آگهی‌های من: توقف و فعال‌سازی، پذیرش پاسخ کارگر');

  // دور ۵۳: درگاه پرداخت — دکمهٔ پرداخت آنلاین داوری، قیمت ارتقا از سرور، پرداخت آزمایشی ← نشان «ویژه»
  if (!/پرداخت آنلاین هزینهٔ داوری/.test(ev(A, 'arbBox(S.disp[0])'))) throw new Error('دکمهٔ «پرداخت آنلاین» روی پروندهٔ داوری نیست');
  ev(A, `openBoost('${adId}')`);
  await until(() => ev(A, "S.cur==='boost' && BOOST.find(x=>x[0]==='star')[3]===149000"), 'boost page with server prices');
  ev(A, "S.bst.pick='star';payBoost()");
  await until(() => ev(A, "document.getElementById('pyGo')"), 'boost pay sheet');
  const ps = await ev(A, `LIVE.api('POST','/pay',{purpose:'boost',targetId:'${adId}',plan:'star'})`);
  const r1 = await fetch(ps.url, { method: 'POST', redirect: 'manual' });
  const r2 = await fetch(new URL(r1.headers.get('location'), ps.url), { redirect: 'manual' });
  if (!/\?pay=/.test(r2.headers.get('location') || '')) throw new Error('برگشت از درگاه به اپ نیامد');
  const pr = await ev(A, `LIVE.api('GET','/pay/${ps.id}')`);
  if (pr.payment.status !== 'paid') throw new Error('پرداخت آزمایشی ثبت نشد: ' + JSON.stringify(pr.payment));
  ev(A, 'closeSheet()');
  await ev(A, 'LIVE.loadMyAds(true)');
  const badge = ev(A, `(()=>{const a=ADS.find(x=>x.id==='${adId}'&&x._mine);return a&&a.boost==='star'&&/bst-badge star/.test(adCard(a,P[a.who]||ME()))})()`);
  if (!badge) throw new Error('نشان «ویژه» بعد از پرداخت روی آگهی نیامد');
  log('درگاه: قیمت ارتقا از سرور، پرداخت آزمایشی موفق · کد پیگیری', pr.payment.refId, '· نشان «ویژه» روی آگهی');

  ev(B, "LIVE.loaded.req=0;S.rtab='out';go('req')");
  await until(() => ev(B, "S.out.length && S.out[0].st==='ok' && S.out[0].to.startsWith('B-')"), 'outgoing requests');
  log('مرکز درخواست‌های کارگر: درخواست ارسالی «پذیرفته شد» ·', ev(B, 'S.out[0].t'));

  ev(B, `togSave('ad:${adId}')`);
  await until(async () => (await ev(B, "LIVE.api('GET','/saved')")).ads.length === 1, 'saved on server');
  B.LIVE.loaded.saved = 0;
  ev(B, "S.svt='ads';go('saved')");
  await until(() => ev(B, "document.querySelectorAll('#s-saved .acard').length") === 1, 'saved page');
  log('ذخیره‌ها: آگهی روی سرور ذخیره و در صفحهٔ ذخیره‌ها نمایش داده شد');

  ev(B, "go('cal')");
  const wk0 = ev(B, 'LIVE.pub.week.join("")');
  ev(B, 'calTog(S.cal.sel)');
  await until(() => ev(B, 'LIVE.pub.week.join("")') !== wk0, 'week toggled');
  log('تقویم:', ev(B, "document.querySelector('#s-cal .cal-h b').textContent"), '· روزهای آزاد هفته', wk0, '←', ev(B, 'LIVE.pub.week.join("")'));

  // مدارک و نمونه‌کار (فایل واقعی در مرورگر)
  const mkFile = (w, name, type, bytes) => new w.File([new w.Uint8Array(bytes)], name, { type });
  const PDFB = [...Buffer.from('%PDF-1.4\n%%EOF', 'latin1')];
  const JPGB = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];
  ev(A, "go('docs')");
  await until(() => ev(A, "S.cur==='docs' && S.docs[S.role] && S.docs[S.role].length"), 'docs page');
  ev(A, 'docAdd()');
  Object.defineProperty(A.document.querySelector('#sb input[type=file]'), 'files', { value: [mkFile(A, 'hse.pdf', 'application/pdf', PDFB)] });
  click(A, '#sb .cta');
  await until(() => ev(A, "S.docs[S.role].some(d=>d.st==='rev')"), 'document pending').catch((e) => { throw new Error(e.message + ' · ' + A.document.getElementById('toast').textContent + ' · ' + ev(A, 'S.cur') + ' · ' + ev(A, 'JSON.stringify(S.docs[S.role].map(d=>d.n+":"+d.st))')); });
  log('مدرک بارگذاری شد و در صف بررسی است:', ev(A, "S.docs[S.role].find(d=>d.st==='rev').n"));

  ev(A, "go('pf')");
  ev(A, 'pfAdd()');
  A.LIVE.pfFile = mkFile(A, 'work.jpg', 'image/jpeg', JPGB);
  ev(A, "document.getElementById('pfT').value='سفت‌کاری ویلای درگهان'");
  click(A, '#sb .cta');
  await until(() => ev(A, 'S.pfItems.length') === 1 && ev(A, 'ME().pf.length') === 1, 'portfolio saved');
  log('نمونه‌کار با عکس واقعی:', ev(A, 'S.pfItems[0].t'), '·', ev(A, 'ME().pf.length'), 'مورد در شناسنامه');

  // مهندس: درخواست حل‌کنندهٔ حضوری
  const C = browser('C');
  await until(() => C.LIVE && C.LIVE.on, 'boot C');
  await login(C, '17' + String(Date.now()).slice(-7));
  await register(C, 'engineer', { fn: 'علی', ln: 'کریمی', nat: 'ایرانی', prov: 'فارس', city: 'شیراز', range: 'کل استان', field: 'عمران', grade: 'پایه ۱', nezam: '23-10-0456', nprov: 'فارس', comp: ['نظارت'], services: ['نظارت ساختمان'], days: [1, 4] });
  ev(C, "go('arbj')");
  await until(() => ev(C, "S.cur==='arbj' && S.arbQ2 && document.querySelector('#s-arbj .arbj-up')"), 'arbiter form');
  C.LIVE.arbDoc = mkFile(C, 'nezam.pdf', 'application/pdf', PDFB);
  ev(C, 'S.arbQ2.doc=true;S.arbQ2.pledge=true;arbJoin()');
  await until(() => ev(C, 'S.arbMe && S.arbMe.st') === 'review', 'arbiter applied', 15000).catch((e) => { throw new Error(e.message + ' · ' + C.document.getElementById('toast').textContent + ' · ' + ev(C, 'JSON.stringify(S.arbQ2)')); });
  log('مهندس درخواست حل‌کنندگی داد؛ وضعیت: در حال بررسی · حوزه‌ها', ev(C, 'S.arbMe.fields.join(",")'));

  /* ---------- بخش ۴: بازدید مهندس، تیم، پشتیبانی، آکادمی، استوری و قوانین ---------- */
  const cCode = ev(C, 'LIVE.pub.code');
  await ev(C, "LIVE.api('PUT','/me/roles/engineer/week',{week:['a','a','a','a','a','a','a']})");
  await ev(A, `LIVE.api('GET','/profiles/${cCode}').then(d=>LIVE.fillPerson(d.profile))`);
  ev(A, `openVisit('${cCode}')`);
  await until(() => ev(A, "S.cur==='visit' && LIVE.vs && document.querySelector('#s-visit .vdays')"), 'visit page');
  const vdi = ev(A, 'LIVE.vs.days.findIndex(d=>d.open)');
  ev(A, `vPick('t',1);vPick('d',${vdi});vPick('s',1);S.visit.addr='قشم، درگهان، کوچهٔ ۱۲';vConfirm()`);
  await until(() => ev(A, "(LIVE.visits||[]).some(v=>v.status==='requested')"), 'visit booked');
  log('رزرو بازدید مهندس:', ev(A, 'LIVE.visits[0].typeName'), '·', ev(A, 'LIVE.visits[0].dayLabel'), ev(A, 'LIVE.visits[0].slot'));
  await ev(C, 'LIVE.loadRequests(true)');
  ev(C, "S.rtab='in';go('req')");
  await until(() => ev(C, "(S.req.engineer||[]).some(r=>r._visit)"), 'engineer sees visit request');
  ev(C, "rqAns(S.req.engineer.findIndex(r=>r._visit),'ok')");
  await until(async () => (await ev(A, "LIVE.api('GET','/visits')")).items[0].status === 'confirmed', 'visit confirmed');
  log('مهندس درخواست بازدید را از مرکز درخواست‌ها تأیید کرد');

  ev(A, "go('team')");
  await until(() => ev(A, "S.cur==='team' && LIVE.team"), 'team loaded');
  ev(A, "addMember()");
  ev(A, "document.getElementById('tmN').value='حسین کمالی';document.getElementById('tmW').value='۲٬۲۰۰٬۰۰۰';saveMember()");
  await until(() => ev(A, 'S.team.length') === 1 && ev(A, 'S.team[0]._id'), 'member added');
  ev(A, 'tmToggle(0)');
  await until(async () => { const t = await ev(A, "LIVE.api('GET','/me/team')"); return t.items[0].days[t.today] === ev(A, 'S.today[0]') && ev(A, 'S.today[0]') !== 'p'; }, 'attendance saved');
  log('تیم و حضور: نیرو اضافه شد، حضور امروز', ev(A, 'TST[S.today[0]][0]'), '· دستمزد روزانه', ev(A, 'S.team[0].w'));

  ev(B, "openChat('c-support')");
  await until(() => ev(B, "S.cur==='chat' && (S.convs.find(c=>c.id===S.cid)||{}).type==='support'"), 'support chat');
  await ev(B, "LIVE.api('POST','/conversations/'+S.cid+'/messages',{kind:'text',body:'سلام، کد تأیید دیر می‌رسد'})");
  log('گفت‌وگوی «پشتیبانی بلوک» باز شد و پیام کاربر به تیکت رفت');

  ev(B, "go('learn')");
  await until(() => ev(B, "S.cur==='learn' && COURSES[0] && COURSES[0][5]"), 'courses loaded');
  ev(B, 'S.learn.p[0]=2;renderLearn()');
  await until(async () => (await ev(B, "LIVE.api('GET','/app/courses')")).items[0].done === 2, 'course progress');
  log('آکادمی: دوره‌ها از سرور و پیشرفت ذخیره شد ·', ev(B, 'COURSES[0][0]'));

  const { saveConfig } = require('../src/lib/appConfig');
  const uid = ev(A, 'LIVE.me.user.id');
  await saveConfig('stories', [{ id: 'heat', t: 'ایمنی گرما', s: '۱۱ تا ۱۵ کار سنگین نکن', p: 'آب خنک و سایه لازم است', on: true }], uid);
  await ev(B, 'LIVE.loadCfg()');
  ev(B, 'openStory(0)');
  await until(() => B.document.querySelector('#sv h2') && B.document.querySelector('#sv h2').textContent.includes('۱۱ تا ۱۵'), 'panel story shown');
  ev(B, 'closeStory()');
  ev(B, "openLegal('terms')");
  log('استوری پنل در اپ نمایش داده شد · قوانین:', B.document.querySelector('#sb .sub').textContent);
  ev(B, 'closeSheet()');
  await saveConfig('stories', [], uid);

  const DOCSEL = 'button[onclick="go(\'docs\')"] .blk-red';
  // بخش ۵: راهنمای امتیاز، نشان مدارک ناقص، راهنمای قرارداد، شهر کشویی، سال تولد
  ev(B, "openTrust('me')");
  await until(() => B.document.querySelector('#blkSteps'), 'trust steps');
  log('شناسنامهٔ کاری · راهنمای بالا بردن امتیاز:', B.document.querySelectorAll('#blkSteps .tstep').length, 'قدم ·', B.document.querySelector('#blkSteps .tstep b').textContent);
  ev(B, "go('me')");
  await until(() => B.document.querySelector(DOCSEL), 'docs red badge');
  ev(B, "go('docs')");
  await until(() => B.document.querySelector('#blkDocNeed'), 'docs checklist');
  log('نشان قرمز مدارک ناقص:', B.document.querySelector(DOCSEL) ? 'روی «مدارک من»' : '—', '·', B.document.querySelector('#blkDocNeed b:last-child').textContent);
  ev(B, 'openHelp()');
  await until(() => B.document.querySelector('#blkCtrQ'), 'contract help');
  ev(B, 'closeSheet()');
  ev(B, "S.reg={step:'form',role:'worker',i:0,d:{prov:'هرمزگان'}};const h=fieldHTML({k:'city',t:'city',label:'شهر'},S.reg.d);window.__c=h");
  if (!/<select[^>]*id="rf_city"/.test(ev(B, 'window.__c'))) throw new Error('شهر کشویی نیست');
  if (!ev(B, "REG.worker[0].f.some(f=>f.k==='by')")) throw new Error('سال تولد در فرم نیست');
  log('ثبت‌نام: شهر فهرست کشویی و سال تولد (اختیاری) در فرم');

  /* ---------------- دور ۲۷: جست‌وجوی کد، درخواست همکاری، آگهی رایگان، رأی، برآورد ← نیرو، قرارداد از چت ---------------- */
  const codeA = ev(A, 'LIVE.pub.code'), codeB = ev(B, 'LIVE.pub.code');
  ev(A, "closeSheet();exploreMode('workers')");
  ev(A, `S.q='${codeB.toLowerCase().replace('-', '')}';renderResults()`);
  await until(() => ev(A, `S.cur==='profile' && S.pid==='${codeB}'`), 'code search opens profile');
  log('جست‌وجوی کد کاربری بدون خط تیره و با حروف کوچک ← پروفایل', codeB, 'باز شد');
  ev(A, 'S.q=""');

  ev(A, `collabReq('${codeB}')`);
  await until(() => ev(A, "S.cur==='chat'") && (A.document.getElementById('cIn') || {}).value, 'collab → chat with draft');
  log('پیشنهاد کار در چت ← پیام آماده:', A.document.getElementById('cIn').value.slice(0, 40) + '…');
  ev(A, "sendText(document.getElementById('cIn').value)");
  await until(() => ev(A, "S.convs.find(c=>c.id===S.cid).msgs.some(m=>m.me&&m.id&&/وقت داری/.test(m.t||''))"), 'draft sent');
  const acid = ev(A, 'S.cid');
  await ev(B, 'LIVE.loadConvs()');
  ev(B, `openChat('${acid}')`);
  await until(() => ev(B, "S.cur==='chat'"), 'B opens chat');
  log('کارگر چت را باز کرد:', ev(B, "convName(S.convs.find(c=>c.id===S.cid))"));

  // قرارداد از داخل چت: دکمهٔ «ثبت قرارداد» و ۳ گام
  if (!B.document.querySelector('#s-chat .qr-ctr')) throw new Error('دکمهٔ «ثبت قرارداد» در چت نیست');
  // کارگر: قرارداد ساده (یک صفحه، جمع خودکار و مبلغ به حروف)
  ev(B, 'ctrWizard()');
  await until(() => B.document.getElementById('csJ'), 'simple contract');
  ev(B, "document.getElementById('csJ').value='بتن‌ریزی سقف ویلای طولا';const r=document.getElementById('csR');r.value='2200000';r.dispatchEvent(new Event('input',{bubbles:true}));csN(1)");
  const words = B.document.getElementById('csTot').textContent;
  if (!words.includes("۱۳.۲۰۰.۰۰۰") || !/سیزده میلیون و دویست هزار/.test(words)) throw new Error('جمع قرارداد ساده درست نیست: ' + words);
  ev(B, 'csSend()');
  await until(() => ev(B, "S.convs.find(c=>c.id===S.cid).msgs.some(m=>m.k==='deal'&&m.id)"), 'contract proposal sent');
  const dm = await ev(B, "LIVE.api('GET','/conversations/'+S.cid+'/messages').then(d=>d.items.find(m=>m.kind==='deal').payload)");
  if (dm.amount !== 13200000 || dm.durationDays !== 6 || dm.steps.length !== 6) throw new Error('پیشنهاد قرارداد ساده روی سرور درست نیست: ' + JSON.stringify(dm));
  log('قرارداد سادهٔ کارگر:', dm.price, '× ۶ روز =', words.replace(/\s+/g, ' ').trim());

  // آگهی رایگان: پیمانکار یک آگهی فعال دارد
  ev(A, "closeSheet();go('home');LIVE.loaded['myads:'+S.role]=Date.now();openWizard()");
  await until(() => /یک آگهی فعال داری/.test((A.document.getElementById('sheetTitle') || {}).textContent || ''), 'free ad limit sheet');
  log('محدودیت آگهی رایگان:', [...A.document.querySelectorAll('#sb button')].map((b) => b.textContent.trim()).slice(0, 3).join(' | '));
  ev(A, 'closeSheet()');

  // پرسش تخصصی: کارگر هم پاسخ می‌دهد؛ مفید بود
  const q = await ev(A, "LIVE.api('POST','/ads',{type:'consult',title:'فاصلهٔ خاموت ستون چقدر باشد؟',province:'هرمزگان',city:'قشم',audience:['engineer']})");
  await ev(B, `LIVE.api('POST','/ads/${q.ad.id}/responses',{message:'در ناحیهٔ بحرانی نزدیک‌تر، حدود ۱۰ سانتی‌متر.'})`);
  await ev(A, `LIVE.loadAds('consult',true)`);
  ev(A, `openAd('${q.ad.id}')`);
  await until(() => ev(A, `S.cur==='qa' && (S.ans['${q.ad.id}']||[]).length===1`), 'qa answers');
  ev(A, `voteAns('${q.ad.id}',0,1)`);
  await until(() => ev(A, `(S.ans['${q.ad.id}'][0]||{}).up===1 && S.ans['${q.ad.id}'][0].my===1`), 'vote saved');
  if (A.document.getElementById('s-qa').innerHTML.includes('درخواست بازدید')) throw new Error('«درخواست بازدید» هنوز در پرسش تخصصی است');
  log('پرسش تخصصی: پاسخ کارگر + «مفید بود» روی سرور:', ev(A, `document.querySelector('#s-qa .vt.on .num').textContent`));

  // برآورد ← نیروی این پروژه (حمام)؛ آگهی فعال دیگری هست ← فقط درخواست‌ها
  ev(A, "go('est');estType('bath');estGo()");
  await until(() => ev(A, "S.cur==='estgo'") && A.document.getElementById('egT'), 'estimate → workforce page');
  await until(() => ev(A, `!!P['${codeB}'] && egCands().some(c=>c.id==='${codeB}')`), 'candidates').catch((e) => { throw new Error(e.message + ' · P? ' + ev(A, `!!P['${codeB}']`) + ' · ' + JSON.stringify(ev(A, "egCands().map(c=>c.id).slice(0,8)")) + ' · role ' + ev(A,`P['${codeB}']&&[P['${codeB}'].role,P['${codeB}'].place,P['${codeB}'].week]`)); });
  log('برآورد ← آگهی آماده:', ev(A, "document.getElementById('egT').value"), '· نقش‌ها:', ev(A, "S.eg.roles.map(r=>ROLES[r].n).join('، ')"));
  ev(A, `egPick('${codeB}');estPublish()`);
  await until(() => /درخواست/.test((A.document.getElementById('sheetTitle') || {}).textContent || ''), 'estimate publish');
  const inv = await ev(B, "LIVE.api('GET','/invites?dir=in')");
  log('«انتشار و ارسال»:', A.document.getElementById('sheetTitle').textContent, '· درخواست‌های کارگر:', inv.items.length);
  ev(A, 'closeSheet()');

  // نیروی فوری: کارگر «آماده به کار» است ← پیمانکار درخواست فوری می‌فرستد ← کارگر قبول می‌کند ← پروژه
  const UGS = 'سنگ‌کاری ' + String(Date.now()).slice(-5); // یکتا: دیتابیس تست بین اجراها می‌ماند
  await ev(B, `LIVE.api('POST','/ads',{type:'work',title:'سنگ‌کار آماده به کار',province:'هرمزگان',city:'قشم',wageType:'روزانه',wageAmount:'2000000',startWhen:'فوری',range:'city',audience:['contractor','general'],skills:['${UGS}']})`)
    .catch(async () => {
      // آگهی رایگان پر است ← آگهی‌های قبلی کارگر بسته شود
      const m = await ev(B, "LIVE.api('GET','/ads/mine')");
      for (const a of m.items.filter((x) => x.status === 'active')) await ev(B, `LIVE.api('PATCH','/ads/${'${a.id}'}',{status:'closed'})`.replace("${a.id}", a.id));
      return ev(B, `LIVE.api('POST','/ads',{type:'work',title:'سنگ‌کار آماده به کار',province:'هرمزگان',city:'قشم',wageType:'روزانه',wageAmount:'2000000',startWhen:'فوری',range:'city',audience:['contractor','general'],skills:['${UGS}']})`);
    });
  ev(A, "go('home')");
  await until(() => A.document.querySelector('#ugBtnSec .ug-btn'), 'urgent button on home');
  ev(A, 'urgSheet()');
  await until(() => A.document.getElementById('ugW'), 'urgent sheet');
  ev(A, `S.ugf.skill='${UGS}';document.getElementById('ugT').value='سنگ‌کاری نمای ویلا';const w=document.getElementById('ugW');w.value='2500000';w.dispatchEvent(new Event('input',{bubbles:true}));urgSet('days',1)`);
  await until(() => /به ۱ نیروی آماده/.test((A.document.getElementById('ugCnt') || {}).textContent || ''), 'urgent preview count').catch(async (e) => { throw new Error(e.message + ' · ' + A.document.getElementById('ugCnt').textContent + ' · ' + JSON.stringify(await ev(B, "LIVE.api('GET','/ads/mine')").then(d=>d.items.map(x=>[x.type,x.status,x.province,x.skills])))+' · A '+JSON.stringify(ev(A,'[S.role,S.ugf]'))); });
  ev(A, 'urgSend()');
  await until(() => ev(A, "S.cur==='urg' && S.ug.mine.length && S.ug.mine[0].status==='open'"), 'urgent sent');
  await sleep(5200);
  ev(B, "go('home')");
  await until(() => ev(B, 'S.ug.inbox && S.ug.inbox.length === 1') && B.document.getElementById('ugYes'), 'worker urgent offer');
  click(B, '#ugYes');
  await until(() => ev(B, "S.cur==='chat'"), 'urgent accepted → chat');
  await until(async () => { await ev(A, "LIVE.api('GET','/urgent/mine').then(d=>{S.ug.mine=d.items})"); return ev(A, "S.ug.mine[0].status") === 'filled'; }, 'urgent filled');
  ev(A, "go('urg')");
  await until(() => /نیروهای تو/.test(A.document.getElementById('s-urg').textContent), 'urgent page shows worker');
  log('نیروی فوری: درخواست ← کارگر آماده قبول کرد ← پروژه:', ev(A, "S.ug.mine[0].title"), '·', ev(A, "S.ug.mine[0].accepted[0].person.name"), '· پروژه', !!ev(A, 'S.ug.mine[0].accepted[0].projectId'));

  // آماده به کار: بعد از قرارداد خاموش شد ← کارگر از خانه ویرایش و روشن می‌کند ← کارفرما در کاوش می‌بیند
  ev(B, "closeSheet();go('home')");
  await until(() => ev(B, "!!myReady() && myReady().st==='closed'") && B.document.querySelector('#rdSec .rd-prev'), 'ready card (closed after contract)').catch(async (e) => { throw new Error(e.message + ' · ' + JSON.stringify(ev(B, "[S.cur,S.role,ADS.filter(a=>a.who==='me').map(a=>[a.type,a.st]),!!document.getElementById('rdSec')]")) + ' · server ' + JSON.stringify((await ev(B, "LIVE.api('GET','/ads/mine')")).items.map((x) => [x.type, x.status])) + ' · rd ' + ev(B, 'renderHome._rd') + ' · afterLoad ' + JSON.stringify(await ev(B, "LIVE.loadMyAds(true).then(()=>ADS.filter(a=>a.who==='me').map(a=>[a.type,a.st,!!a._mine]))"))); });
  ev(B, 'readySheet()');
  await until(() => B.document.getElementById('rsW'), 'ready edit sheet');
  ev(B, "const w=document.getElementById('rsW');w.value='2800000';w.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('rsX').value='ابزار کامل دارم';document.getElementById('rsGo').click()");
  await until(async () => { const m = await ev(B, "LIVE.api('GET','/ads/mine')"); const a = m.items.find((x) => x.type === 'work'); return a && a.wageAmount === 2800000 && a.description === 'ابزار کامل دارم'; }, 'ready ad edited on server');
  await until(() => ev(B, "!B_SHEET_OPEN()".replace('B_SHEET_OPEN()', "document.getElementById('sheet').classList.contains('on')")), 'edit sheet closed');
  ev(B, 'readyToggle()');
  await until(async () => (await ev(B, "LIVE.api('GET','/ads/mine')")).items.find((x) => x.type === 'work').status === 'active', 'ready ad switched on');
  const readyId = (await ev(B, "LIVE.api('GET','/ads/mine')")).items.find((x) => x.type === 'work').id;
  ev(A, "LIVE.loaded['ads:work']=0;S.provF=null;S.cat=null;S.cityF=null;go('explore');setMode('workers')");
  await until(() => ev(A, `listFor().some(x=>x.a.id==='${readyId}')`) && A.document.querySelector(`#s-explore .acard[data-id="${readyId}"] .rd-type`), 'employer sees ready worker in explore');
  ev(B, "go('explore');setMode('workers')");
  await until(() => B.document.getElementById('rdMine'), 'worker sees own pinned card');
  log('آماده به کار: ویرایش (۲.۸۰۰.۰۰۰ روزانه) و روشن شد ← کارفرما در کاوش با نشان سبز می‌بیند؛ کارگر «این تویی» بالای کاوش');

  // صفحهٔ «من»: کلید «پروفایل عمومی» روی سرور ذخیره شود (قبلاً فقط در حافظه بود)
  const pubOf = async () => (await ev(A, "LIVE.api('GET','/me')")).profiles.find((p) => p.role === 'contractor').isPublic;
  ev(A, "go('me')");
  await until(() => A.document.querySelector('#s-me .tog[aria-label="پروفایل عمومی"]'), 'me privacy toggle');
  click(A, '#s-me .tog[aria-label="پروفایل عمومی"]');
  await until(async () => (await pubOf()) === false, 'profile private saved');
  click(A, '#s-me .tog[aria-label="پروفایل عمومی"]');
  await until(async () => (await pubOf()) === true, 'profile public saved');
  log('صفحهٔ «من»: کلید پروفایل عمومی روی سرور ذخیره شد (خاموش ← روشن)');

  // دور ۳۴: درخواست تغییر نقش از اپ به پنل (نه پیام پشتیبانی) + کارت وضعیت + لغو
  ev(B, "closeSheet();go('roles')");
  await until(() => ev(B, "S.cur==='roles'"), 'roles page');
  ev(B, 'roleChangeReq()');
  await until(() => B.document.getElementById('rqGo'), 'role request sheet');
  ev(B, "document.querySelector('#rqR .chip[data-v=\"specialist\"]').click();document.getElementById('rqN').value='جوشکاری هم بلدم';document.getElementById('rqGo').click()");
  await until(async () => ((await ev(B, "LIVE.api('GET','/me/role-requests')")).items[0] || {}).status === 'pending', 'role request on server');
  ev(B, "S.rreq.at=0;renderRoles()");
  await until(() => /در حال بررسی/.test(B.document.getElementById('s-roles').textContent), 'pending card');
  const rrId = (await ev(B, "LIVE.api('GET','/me/role-requests')")).items[0].id;
  ev(B, `cancelRoleReq('${rrId}')`);
  await until(async () => (await ev(B, "LIVE.api('GET','/me/role-requests')")).items[0].status === 'cancelled', 'role request cancelled');
  log('تغییر نقش از اپ: درخواست به پنل رفت، کارت «در حال بررسی» و لغو');

  // حساب نمونه (0900000…): پنهان؛ با «نمایش حساب‌های نمونه» دیده می‌شود ولی با برچسب «نمونه»
  {
    const sp = '09000004' + String(Date.now()).slice(-3);
    const s1 = await fetch(API + '/api/auth/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: sp }) }).then((r) => r.json());
    const v1 = await fetch(API + '/api/auth/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: sp, code: s1.devCode }) }).then((r) => r.json());
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v1.accessToken };
    await fetch(API + '/api/me/roles', { method: 'POST', headers: H, body: JSON.stringify({ role: 'worker', data: { fn: 'نمونه', ln: 'آزمون', nat: 'ایرانی', prov: 'یزد', city: 'یزد', range: 'کل استان', skills: ['کارگر ساده'], exp: '۳ تا ۵ سال', team: 'تنها', days: [0, 1], hours: 'تمام روز' } }) });
    const ad = await fetch(API + '/api/ads', { method: 'POST', headers: H, body: JSON.stringify({ type: 'work', title: 'کارگر ساده آماده کار در یزد', province: 'یزد', city: 'یزد', audience: ['contractor'] }) }).then((r) => r.json());
    const { cfg, saveConfig } = require('../src/lib/appConfig');
    const st0 = cfg('settings');
    await saveConfig('settings', { ...st0, flags: { ...st0.flags, showSamples: true } }, v1.user.id);
    await ev(A, "LIVE.loadAds('work', true)");
    ev(A, "S.provF=null;exploreMode('workers')");
    await until(() => A.document.querySelector(`.acard[data-id="${ad.ad.id}"] .smp`), 'sample badge in explore').catch((e) => { throw new Error(e.message + ' · ' + JSON.stringify(ev(A, `[S.mode, S.cur, ADS.filter(a=>a.id==='${ad.ad.id}').map(a=>[a._sample,a.who,P[a.who]&&P[a.who].sample]), !!document.querySelector('.acard[data-id="${ad.ad.id}"]'), ADS.length]`)) + ' ad:' + JSON.stringify(ad).slice(0,200)); });
    await saveConfig('settings', { ...st0, flags: { ...st0.flags, showSamples: false } }, v1.user.id);
    log('حساب نمونه با «نمایش حساب‌های نمونه» در کاوش با برچسب «نمونه» دیده شد');
  }

  ev(A, "go('set')");
  log('تنظیمات:', ev(A, "[...document.querySelectorAll('#s-set .hint')].pop().textContent"));
  ev(A, 'logout()');
  await sleep(200);
  log('خروج:', ev(A, 'S.auth') === false ? 'انجام شد' : 'نشد', '· توکن ذخیره‌شده:', A.localStorage.getItem('blk-tok'));

  if (errors.length) { console.log('\n⚠️ خطاهای صفحه:\n' + errors.join('\n---\n')); process.exit(1); }
  console.log('\nهمه چیز درست کار کرد.');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); if (errors.length) console.log('\nخطاهای صفحه:\n' + errors.join('\n---\n')); process.exit(1); });
