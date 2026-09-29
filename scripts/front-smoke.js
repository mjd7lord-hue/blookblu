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
  .replace('<script src="live.js"></script>', inline('live.js'))
  .replace('<script src="live-projects.js"></script>', inline('live-projects.js'))
  .replace('<script src="live-more.js"></script>', inline('live-more.js'))
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

  // پرداخت: مجری ثبت می‌کند، کارفرما تأیید
  ev(B, 'openProjPage(0)');
  await until(() => ev(B, "S.cur==='pdet'"), 'project page B');
  ev(B, "addPay(S.role+':0')");
  ev(B, "document.getElementById('payA').value='۲٬۰۰۰٬۰۰۰'");
  click(B, '#sb .cta');
  await until(() => ev(B, "(S.pays[S.role+':0']||[]).length") === 1, 'payment recorded');
  ev(A, 'openProjPage(0)');
  await until(() => ev(A, "S.cur==='pdet' && document.querySelector('#s-pdet [data-act=confirm]')"), 'confirm button');
  click(A, '#s-pdet [data-act=confirm]');
  await until(() => ev(A, "S.pays[S.role+':0'][0]._x.status") === 'confirmed', 'payment confirmed');
  log('دفترچهٔ پرداخت: ثبت مجری و تأیید کارفرما —', ev(A, "S.pays[S.role+':0'][0].f"));

  // شروع کار
  ev(B, 'advProj(0)');
  await until(() => ev(B, 'S.projs[S.role][0].stage') === 2, 'work started');
  log('شروع کار ← مرحله:', ev(B, 'PSTG[S.projs[S.role][0].stage]'));

  // صورت‌وضعیت: مجری ردیف اضافه و ارسال می‌کند، کارفرما تأیید
  ev(B, 'openSov(0)');
  await until(() => ev(B, "S.cur==='sov' && document.getElementById('sovAdd')"), 'sov open');
  click(B, '#sovAdd');
  ev(B, "document.getElementById('srN').value='بلوک‌چینی دیوار طبقهٔ دوم';document.getElementById('srQ').value='۱۲۰';document.getElementById('srD').value='۶۰';document.getElementById('srP').value='۴۲۰٬۰۰۰'");
  click(B, '#srGo');
  ev(B, "sovSend(S.role+':0')");
  await until(() => ev(B, "S.sov[S.role+':0'].st") === 'sent', 'sov sent');
  ev(A, 'openSov(0)');
  await until(() => ev(A, "document.getElementById('sovOk')"), 'approve button');
  click(A, '#sovOk');
  await until(() => ev(A, "S.sov[S.role+':0'].st") === 'ok', 'sov approved');
  log('صورت‌وضعیت: ارسال مجری و تأیید کارفرما —', ev(A, "S.sov[S.role+':0']._s.totals.payable"), 'تومان قابل پرداخت');

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

  ev(B, "S.rtab='out';go('req')");
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
  await until(() => ev(C, 'S.arbMe && S.arbMe.st') === 'review', 'arbiter applied');
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

  ev(A, "go('set')");
  log('تنظیمات:', ev(A, "[...document.querySelectorAll('#s-set .hint')].pop().textContent"));
  ev(A, 'logout()');
  await sleep(200);
  log('خروج:', ev(A, 'S.auth') === false ? 'انجام شد' : 'نشد', '· توکن ذخیره‌شده:', A.localStorage.getItem('blk-tok'));

  if (errors.length) { console.log('\n⚠️ خطاهای صفحه:\n' + errors.join('\n---\n')); process.exit(1); }
  console.log('\nهمه چیز درست کار کرد.');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); if (errors.length) console.log('\nخطاهای صفحه:\n' + errors.join('\n---\n')); process.exit(1); });
