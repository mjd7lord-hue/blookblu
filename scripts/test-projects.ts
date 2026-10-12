/**
 * پروژه‌های آزمایشی برای حسابِ ساخته‌شده با test:account — در هر ۶ نقش دو پروژهٔ واقعی:
 * آگهی ثبت‌شده ← گفت‌وگو ← پیشنهاد توافق ← پذیرش ← پروژه (+ فهرست کار، پرداخت، گزارش روزانه).
 * در بعضی تو مجری هستی و در بعضی کارفرما، تا هر دو طرف (تیک کار، ثبت پرداخت، تأیید دریافت، صورت‌وضعیت) آزموده شود.
 * طرف مقابل: حساب‌های «طرف آزمایشی» با شماره‌های 0900000990x.
 *   npm run test:projects -- 09121234567
 *   npm run test:projects -- 09121234567 --remove     (پاک کردن پروژه‌ها و حساب‌های طرف آزمایشی)
 * پروژه‌ای که از قبل ساخته شده دوباره ساخته نمی‌شود (عنوان + طرفین).
 * روی همان دیتابیسی کار می‌کند که DATABASE_URL در .env نشان می‌دهد.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { ads, conversations, dailyReports, profiles, projectPayments, projects, users, type Role } from '../src/db/schema';
import { normalizePhone } from '../src/lib/text';
import { loadConfig } from '../src/lib/appConfig';
import { createRoleProfile } from '../src/modules/profiles/profiles.service';
import { answerProposal, ensureConversation, postMessage, proposeDeal } from '../src/modules/chat/chat.service';

const BASE = { nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم' };
// طرف‌های آزمایشی (هر کدام یک نقش)
const PARTNERS: Record<string, { phone: string; role: Role; data: Record<string, unknown> }> = {
  contractor: { phone: '09000009901', role: 'contractor', data: { ...BASE, fn: 'طرف آزمایشی', ln: 'پیمانکار', range: 'کل استان', kinds: ['اسکلت بتنی', 'سفت‌کاری'], exp: 'بیش از ۱۰ سال', contract: ['متری'], max: '۴ تا ۶ طبقه', lic: 'ندارم', pub: true } },
  general: { phone: '09000009902', role: 'general', data: { ...BASE, fn: 'طرف آزمایشی', ln: 'کارفرما', need: 'ساخت ساختمان', land: 'زمین دارم', budget: 'زیر ۵۰ میلیون' } },
  company: { phone: '09000009903', role: 'company', data: { cname: 'شرکت طرف آزمایشی', ctype: 'سهامی خاص', nid: '۱۰۸۶۰۰۰۰۹۰۳', prov: 'هرمزگان', city: 'بندرعباس', rank: 'رتبه ۳', areas: ['مسکونی'], staff: '۱۰ تا ۵۰', fn: 'طرف آزمایشی', pos: 'مدیر پروژه' } },
  worker: { phone: '09000009904', role: 'worker', data: { ...BASE, city: 'درگهان', fn: 'طرف آزمایشی', ln: 'کارگر', range: 'کل استان', skills: ['بنایی و دیوارچینی'], exp: '۵ تا ۱۰ سال', wage: '۱.۸۰۰.۰۰۰', team: 'تنها', days: [0, 1, 2, 3, 4], hours: 'تمام روز' } },
  specialist: { phone: '09000009905', role: 'specialist', data: { ...BASE, fn: 'طرف آزمایشی', ln: 'متخصص', range: 'کل استان', skills: ['جوشکاری و اسکلت فلزی'], exp: 'بیش از ۱۰ سال', cert: 'دارم', rateType: 'روزانه', rate: '۲.۸۰۰.۰۰۰', team: 'تنها', days: [0, 1, 2] } },
  engineer: { phone: '09000009906', role: 'engineer', data: { ...BASE, fn: 'طرف آزمایشی', ln: 'مهندس', range: 'کل استان', field: ['عمران'], grade: 'پایه ۱', nezam: '23-10-0906', nprov: 'هرمزگان', comp: ['نظارت'], services: ['نظارت ساختمان'], days: [1, 4] } },
};
const days = (n: number) => Array.from({ length: n }, (_, i) => `روز ${'۰۱۲۳۴۵۶۷۸۹'.split('').reduce((s, d, k) => s.replace(new RegExp(String(k), 'g'), d), String(i + 1))}`);
const units = (n: number) => Array.from({ length: n }, (_, i) => `واحد ${'۱۲۳۴۵۶۷۸۹'[i]}`);
type Spec = {
  mine: Role; other: keyof typeof PARTNERS; iAm: 'provider' | 'client'; title: string; qty?: string; price: string; amount: number; dur: number;
  plan: { title: string; pct: number }[]; steps: string[]; done: number; started: boolean; paid?: number; pending?: number; report?: string; skills: string[];
};
// دو پروژه برای هر نقش (کار همزمان)
const SPECS: Spec[] = [
  { mine: 'worker', other: 'contractor', iAm: 'provider', title: 'بلوک‌چینی طبقهٔ دوم ویلای درگهان', qty: '۵ روز', price: '۱.۸۰۰.۰۰۰ تومان روزانه', amount: 9_000_000, dur: 5, plan: [{ title: 'پایان کار', pct: 100 }], steps: days(5), done: 2, started: true, paid: 3_600_000, report: 'دیوار شمالی طبقهٔ دوم تا ارتفاع ۱.۲ متر چیده شد', skills: ['بنایی و دیوارچینی'] },
  { mine: 'worker', other: 'general', iAm: 'provider', title: 'کمک‌کار نازک‌کاری واحد ۳', qty: '۳ روز', price: '۱.۶۰۰.۰۰۰ تومان روزانه', amount: 4_800_000, dur: 3, plan: [{ title: 'شروع کار', pct: 50 }, { title: 'پایان کار', pct: 50 }], steps: days(3), done: 0, started: false, skills: ['گچ و خاک'] },
  { mine: 'specialist', other: 'general', iAm: 'provider', title: 'سیم‌کشی ساختمان ۴ واحدی قشم', qty: '۴ واحد', price: '۲۱.۲۵۰.۰۰۰ تومان هر واحد', amount: 85_000_000, dur: 20, plan: [{ title: 'پیش‌پرداخت', pct: 30 }, { title: 'نیمهٔ کار', pct: 40 }, { title: 'پایان کار', pct: 30 }], steps: units(4), done: 2, started: true, paid: 25_500_000, pending: 10_000_000, report: 'لوله‌گذاری و سیم‌کشی واحد ۲ تمام شد', skills: ['برق‌کاری ساختمان'] },
  { mine: 'specialist', other: 'contractor', iAm: 'provider', title: 'کاشی حمام و آشپزخانه ویلای طولا', qty: '۴۲ متر', price: '۴۵۰.۰۰۰ تومان هر متر', amount: 18_900_000, dur: 10, plan: [{ title: 'پایان کار', pct: 100 }], steps: ['زیرسازی', 'کاشی دیوار', 'سرامیک کف', 'بندکشی و تحویل'], done: 0, started: false, skills: ['کاشی و سرامیک'] },
  { mine: 'engineer', other: 'general', iAm: 'provider', title: 'طراحی نقشهٔ معماری ویلای دو طبقه', price: '۶۵.۰۰۰.۰۰۰ تومان کل کار', amount: 65_000_000, dur: 30, plan: [{ title: 'پیش‌پرداخت', pct: 40 }, { title: 'تحویل نقشه', pct: 60 }], steps: ['برداشت و نقشهٔ وضع موجود', 'طرح اولیه (پلان و نما)', 'نقشه‌های نهایی', 'تحویل و تأیید'], done: 1, started: true, paid: 26_000_000, report: 'طرح اولیهٔ پلان همکف برای کارفرما فرستاده شد', skills: ['طراحی و نقشه'] },
  { mine: 'engineer', other: 'company', iAm: 'provider', title: 'نظارت مجتمع ۳ طبقه بندرعباس', price: '۹۰.۰۰۰.۰۰۰ تومان کل کار', amount: 90_000_000, dur: 120, plan: [{ title: 'هر مرحله', pct: 100 }], steps: ['فونداسیون', 'اسکلت', 'سقف‌ها', 'سفت‌کاری', 'نازک‌کاری و پایان‌کار'], done: 2, started: true, paid: 36_000_000, skills: ['نظارت ساختمان'] },
  { mine: 'contractor', other: 'general', iAm: 'provider', title: 'ساخت ویلای دو طبقه رمکان', price: '۱.۲۰۰.۰۰۰.۰۰۰ تومان کل کار', amount: 1_200_000_000, dur: 180, plan: [{ title: 'پیش‌پرداخت', pct: 20 }, { title: 'اسکلت', pct: 30 }, { title: 'سفت‌کاری', pct: 30 }, { title: 'تحویل', pct: 20 }], steps: ['گودبرداری و فونداسیون', 'اسکلت', 'سقف‌ها', 'دیوارچینی', 'تحویل'], done: 2, started: true, paid: 240_000_000, pending: 60_000_000, report: 'بتن‌ریزی سقف اول انجام شد', skills: ['اسکلت بتنی'] },
  { mine: 'contractor', other: 'worker', iAm: 'client', title: 'بلوک‌چینی دیوار حیاط', qty: '۴ روز', price: '۱.۸۰۰.۰۰۰ تومان روزانه', amount: 7_200_000, dur: 4, plan: [{ title: 'پایان کار', pct: 100 }], steps: days(4), done: 1, started: true, paid: 1_800_000, skills: ['بنایی و دیوارچینی'] },
  { mine: 'company', other: 'specialist', iAm: 'client', title: 'جوشکاری اسکلت سولهٔ ۶۰۰ متری', qty: '۲۰ روز', price: '۲.۸۰۰.۰۰۰ تومان روزانه', amount: 56_000_000, dur: 20, plan: [{ title: 'هر ۵ روز', pct: 100 }], steps: ['نصب ستون‌ها', 'خرپا و سقف', 'مهاربندی', 'تحویل'], done: 1, started: true, paid: 14_000_000, skills: ['جوشکاری و اسکلت فلزی'] },
  { mine: 'company', other: 'general', iAm: 'provider', title: 'مجتمع مسکونی ۸ واحدی قشم', qty: '۸ واحد', price: '۴.۸۰۰.۰۰۰.۰۰۰ تومان کل کار', amount: 4_800_000_000, dur: 365, plan: [{ title: 'پیش‌پرداخت', pct: 15 }, { title: 'اسکلت', pct: 35 }, { title: 'سفت‌کاری', pct: 30 }, { title: 'تحویل', pct: 20 }], steps: units(8), done: 0, started: false, skills: ['مسکونی'] },
  { mine: 'general', other: 'contractor', iAm: 'client', title: 'بازسازی کامل آپارتمان ۹۰ متری', price: '۲۵۰.۰۰۰.۰۰۰ تومان کل کار', amount: 250_000_000, dur: 45, plan: [{ title: 'پیش‌پرداخت', pct: 30 }, { title: 'نیمهٔ کار', pct: 40 }, { title: 'تحویل', pct: 30 }], steps: ['تخریب', 'تأسیسات', 'کاشی و کف', 'رنگ و تحویل'], done: 1, started: true, paid: 75_000_000, report: 'تخریب و نخاله‌برداری تمام شد', skills: ['بازسازی و تعمیر'] },
  { mine: 'general', other: 'engineer', iAm: 'client', title: 'نظارت ساخت ویلای درگهان', price: '۴۰.۰۰۰.۰۰۰ تومان کل کار', amount: 40_000_000, dur: 90, plan: [{ title: 'هر مرحله', pct: 100 }], steps: ['فونداسیون', 'اسکلت', 'سقف‌ها', 'سفت‌کاری', 'نازک‌کاری و پایان‌کار'], done: 0, started: false, skills: ['نظارت ساختمان'] },
];

async function userByPhone(phone: string) {
  let [u] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (!u) [u] = await db.insert(users).values({ phone }).returning();
  return u;
}
async function profileOf(userId: string, role: Role) {
  const [p] = await db.select().from(profiles).where(and(eq(profiles.userId, userId), eq(profiles.role, role))).limit(1);
  return p ?? null;
}
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());

async function main() {
  const phone = normalizePhone(process.argv[2] ?? '');
  if (!phone) throw new Error('شمارهٔ موبایل را بده: npm run test:projects -- 09121234567');
  await loadConfig().catch(() => {});
  const me = (await db.select().from(users).where(eq(users.phone, phone)).limit(1))[0];
  if (!me) throw new Error('این شماره حساب ندارد؛ اول بزن: npm run test:account -- ' + phone);

  if (process.argv.includes('--remove')) {
    const partnerUsers = await db.select({ id: users.id }).from(users).where(like(users.phone, '090000099%'));
    const pIds = (await db.select({ id: profiles.id }).from(profiles).where(inArray(profiles.userId, partnerUsers.map((x) => x.id).concat(['00000000-0000-0000-0000-000000000000'])))).map((x) => x.id);
    if (pIds.length) {
      await db.delete(projects).where(inArray(projects.clientProfileId, pIds));
      await db.delete(projects).where(inArray(projects.providerProfileId, pIds));
    }
    await db.delete(users).where(like(users.phone, '090000099%'));
    console.log('✅ پروژه‌ها و حساب‌های «طرف آزمایشی» پاک شد');
    return;
  }

  // طرف‌های آزمایشی
  const partner: Record<string, Awaited<ReturnType<typeof profileOf>>> = {};
  for (const [k, x] of Object.entries(PARTNERS)) {
    const u = await userByPhone(x.phone);
    partner[k] = (await profileOf(u.id, x.role)) ?? (await createRoleProfile(u, x.role, x.data, { force: true }));
  }

  for (const s of SPECS) {
    const mine = await profileOf(me.id, s.mine);
    if (!mine) { console.log(`• ${s.mine}: این نقش را نداری؛ اول test:account`); continue; }
    const other = partner[s.other]!;
    const client = s.iAm === 'client' ? mine : other, provider = s.iAm === 'client' ? other : mine;
    const [dup] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.title, s.title), eq(projects.clientProfileId, client.id), eq(projects.providerProfileId, provider.id))).limit(1);
    if (dup) { console.log(`• ${s.mine}: «${s.title}» از قبل هست`); continue; }
    // آگهی «نیاز به نیرو» کارفرما
    const [ad] = await db
      .insert(ads)
      .values({ profileId: client.id, type: 'job', title: s.title.slice(0, 120), description: 'آگهی آزمایشی برای تست پروژه', province: 'هرمزگان', city: client.city, wageType: /روزانه/.test(s.price) ? 'روزانه' : /متر/.test(s.price) ? 'متری' : 'پروژه‌ای', wageAmount: s.amount, startWhen: 'این هفته', range: 'province', audience: [provider.role], needCount: 1, skills: s.skills, expiresAt: new Date(Date.now() + 30 * 864e5) })
      .returning();
    const { conv } = await ensureConversation(client, provider, { adId: ad.id, title: ad.title });
    await postMessage(conv, null, { kind: 'sys', body: `این گفت‌وگو از آگهی «${ad.title}» شروع شد.` });
    const deal = await proposeDeal(provider.userId, conv.id, { job: s.title, qty: s.qty ?? null, price: s.price, amount: s.amount, start: 'شنبه ۷ صبح', durationDays: s.dur, plan: s.plan, retentionPct: 0, steps: s.steps });
    const { project } = await answerProposal(client.userId, deal.id, 'accepted');
    if (!project) throw new Error('پروژه ساخته نشد: ' + s.title);
    const now = new Date();
    await db
      .update(projects)
      .set({
        stage: s.started ? 2 : 1,
        startedAt: s.started ? new Date(now.getTime() - Math.max(1, Math.round(s.dur / 3)) * 864e5) : null,
        progress: s.steps.map((t, i) => ({ t, done: i < s.done, at: i < s.done ? now.toISOString() : null })),
        updatedAt: now,
      })
      .where(eq(projects.id, project.id));
    await db.update(conversations).set({ stage: s.started ? 2 : 1 }).where(eq(conversations.id, conv.id));
    if (s.paid) await db.insert(projectPayments).values({ projectId: project.id, recordedByProfileId: client.id, amount: s.paid, label: 'پیش‌پرداخت', milestoneIndex: 0, paidOn: todayStr(), status: 'confirmed', respondedAt: now, trackingNo: 'T' + String(Date.now()).slice(-9) + Math.floor(Math.random() * 9) });
    if (s.pending) await db.insert(projectPayments).values({ projectId: project.id, recordedByProfileId: client.id, amount: s.pending, label: 'قسط مرحله', milestoneIndex: Math.min(1, s.plan.length - 1), paidOn: todayStr(), status: 'recorded', trackingNo: 'P' + String(Date.now()).slice(-9) + Math.floor(Math.random() * 9) });
    if (s.report) await db.insert(dailyReports).values({ projectId: project.id, authorProfileId: provider.id, reportDate: todayStr(), crew: 3, done: s.report });
    console.log(`✓ ${s.mine} (${s.iAm === 'client' ? 'کارفرما' : 'مجری'}): «${s.title}» — ${s.started ? 'در حال اجرا' : 'توافق'}، ${s.done} از ${s.steps.length} کار`);
  }
  console.log('✅ تمام. در اپ با هر نقش (من ← نقش‌های من) خانه و «پروژه‌های من» را ببین.');
}

main()
  .catch((e) => {
    console.error('❌', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
