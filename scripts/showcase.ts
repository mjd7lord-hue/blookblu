/**
 * آگهی‌های نمونه برای نمایش اپ به دیگران (روی همان دیتابیسی که .env نشان می‌دهد).
 * ۸ حساب نمونه (همهٔ نقش‌ها) و آگهی در هر سه بخش کاوش: «پیدا کردن نیرو»، «پیدا کردن کار»، «پرسش تخصصی».
 * حساب‌ها با شماره‌های 0900000xxxx ساخته می‌شوند (پیش‌شمارهٔ 0900 به موبایل کسی داده نشده؛ کسی نمی‌تواند با آن وارد شود).
 * روی همهٔ پروفایل‌ها و آگهی‌ها نوشته شده «نمونه»، تا کاربر واقعی گول نخورد.
 *   npm run showcase            ساختن (دوباره زدن چیزی را تکراری نمی‌سازد)
 *   npm run showcase -- --remove   پاک کردن همهٔ نمونه‌ها (پیش از راه‌اندازی عمومی حتماً بزن)
 */
import { eq, like } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { profiles, users, type Role } from '../src/db/schema';
import { createRoleProfile } from '../src/modules/profiles/profiles.service';
import { createAd, type AdInput } from '../src/modules/ads/ads.service';

const TAG = ' (آگهی نمونه برای نمایش بلوک)';
const BIO = 'حساب نمونهٔ بلوک برای نمایش؛ این شخص واقعی نیست.';
const base = { nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم', range: 'کل استان', pub: true, bio: BIO };
type Ad = Omit<AdInput, 'province' | 'city' | 'range'> & Partial<Pick<AdInput, 'province' | 'city' | 'range'>>;

const people: { phone: string; role: Role; data: Record<string, unknown>; ads: Ad[] }[] = [
  {
    phone: '09000000101', role: 'worker',
    data: { ...base, fn: 'علی', ln: 'درویشی', skills: ['کارگر ساده', 'حمل مصالح', 'بتن‌ریزی'], exp: '۳ تا ۵ سال', wage: 1_600_000, team: 'تنها', days: [0, 1, 2, 3, 4], hours: 'تمام روز' },
    ads: [{ type: 'work', title: 'کارگر ساده، آماده کار روزمزد در قشم', description: 'حمل مصالح، بتن‌ریزی و نظافت کارگاه. از شنبه آزادم.', wageType: 'روزانه', wageAmount: 1_600_000, startWhen: 'فوری', audience: ['contractor', 'company', 'general'], skills: ['کارگر ساده', 'بتن‌ریزی'] }],
  },
  {
    phone: '09000000102', role: 'worker',
    data: { ...base, city: 'بندرعباس', fn: 'یوسف', ln: 'بلوچی', skills: ['بنایی و دیوارچینی', 'کمک‌قالب‌بند'], exp: '۵ تا ۱۰ سال', wage: 1_900_000, team: 'با تیم ۳ نفره یا بیشتر', days: [0, 2, 4], hours: 'تمام روز' },
    ads: [{ type: 'work', title: 'بنا و دیوارچین با تیم ۳ نفره', description: 'دیوارچینی بلوک و آجر، کمک قالب‌بندی. بندرعباس و قشم.', city: 'بندرعباس', wageType: 'روزانه', wageAmount: 1_900_000, startWhen: 'از هفتهٔ بعد', audience: ['contractor', 'company'], skills: ['بنایی و دیوارچینی'] }],
  },
  {
    phone: '09000000103', role: 'specialist',
    data: { ...base, city: 'درگهان', fn: 'رضا', ln: 'بندری', skills: ['آرماتوربندی'], exp: 'بیش از ۱۰ سال', cert: 'دارم', rateType: 'متری', rate: 9_500_000, team: 'تیم کامل', days: [0, 1, 2] },
    ads: [{ type: 'work', title: 'آرماتوربند با ۱۸ سال سابقه، آماده از شنبه', description: 'آرماتوربندی سقف و فونداسیون با تیم ۳ نفره؛ رفت‌وآمد داخل جزیره با خودمان.', city: 'درگهان', wageType: 'تنی', wageAmount: 9_500_000, startWhen: 'فوری', audience: ['contractor', 'company', 'general'], skills: ['آرماتوربندی'] }],
  },
  {
    phone: '09000000104', role: 'specialist',
    data: { ...base, fn: 'حمید', ln: 'نجفی', skills: ['کاشی و سرامیک', 'سنگ‌کاری و نما'], exp: '۵ تا ۱۰ سال', cert: 'دارم', rateType: 'متری', rate: 420_000, team: 'با شاگرد', days: [1, 3, 5] },
    ads: [{ type: 'work', title: 'کاشی‌کاری حمام و آشپزخانه، متری', description: 'کاشی، سرامیک و سنگ نما با ضمانت شیب و آب‌بندی.', wageType: 'متری', wageAmount: 420_000, startWhen: 'با هماهنگی', audience: ['general', 'contractor', 'company'], skills: ['کاشی و سرامیک'] }],
  },
  {
    phone: '09000000105', role: 'engineer',
    data: { ...base, fn: 'فرهاد', ln: 'سلیمانی', field: 'عمران', grade: 'پایه ۱', nezam: '28-10-1234', nprov: 'هرمزگان', comp: ['نظارت', 'محاسبات'], services: ['نظارت ساختمان', 'محاسبات سازه', 'بازدید و کارشناسی'], days: [0, 2, 4] },
    ads: [{ type: 'work', title: 'نظارت مرحله‌ای و بازدید کارشناسی ساختمان', description: 'کنترل آرماتور پیش از بتن‌ریزی، بررسی ترک و گزارش مکتوب.', wageType: 'هر بازدید', wageAmount: 3_500_000, startWhen: 'با هماهنگی', audience: ['general', 'contractor', 'company'], skills: ['نظارت ساختمان', 'بازدید و کارشناسی'] }],
  },
  {
    phone: '09000000106', role: 'contractor',
    data: { ...base, fn: 'حسین', ln: 'توکلی', kinds: ['اسکلت بتنی', 'سفت‌کاری'], exp: 'بیش از ۱۰ سال', contract: ['متری', 'درصدی (امانی)'], max: '۴ تا ۶ طبقه', lic: 'ندارم' },
    ads: [
      { type: 'job', title: '۳ کارگر برای بلوک‌چینی دیوارهای طبقهٔ دوم', description: 'کار حدود ۱۰ روز در درگهان. ناهار و آب با کارگاه.', city: 'درگهان', wageType: 'روزانه', wageAmount: 1_800_000, startWhen: 'فوری', audience: ['worker'], needCount: 3, skills: ['بنایی و دیوارچینی'] },
      { type: 'job', title: 'آرماتوربند برای سقف دوم ویلا', description: 'حدود ۳ تن آرماتور؛ نقشه آماده است.', wageType: 'تنی', wageAmount: 9_000_000, startWhen: 'از هفتهٔ بعد', audience: ['specialist'], needCount: 1, skills: ['آرماتوربندی'] },
    ],
  },
  {
    phone: '09000000107', role: 'company',
    data: { prov: 'هرمزگان', city: 'بندرعباس', cname: 'ساحل‌سازان هرمز (نمونه)', ctype: 'سهامی خاص', nid: '۱۰۸۶۱۲۳۴۵۶۷', rank: 'رتبه ۳', areas: ['مسکونی', 'صنعتی و سوله'], staff: '۱۰ تا ۵۰', fn: 'مدیر نمونه', pos: 'مدیر پروژه', pub: true, bio: BIO },
    ads: [{ type: 'job', title: 'مهندس ناظر برای سولهٔ ۲۴۰۰ متری لافت', description: 'نظارت اسکلت فلزی و گزارش هفتگی.', city: 'لافت', wageType: 'پروژه‌ای', wageAmount: 60_000_000, startWhen: 'با هماهنگی', audience: ['engineer'], needCount: 1, skills: ['نظارت ساختمان'] }],
  },
  {
    phone: '09000000108', role: 'general',
    data: { ...base, fn: 'مریم', ln: 'احمدی', need: 'بازسازی و تعمیرات', land: 'ساختمان موجود', budget: 'زیر ۵۰ میلیون' },
    ads: [
      { type: 'job', title: 'بازسازی کامل حمام ۶ متری', description: 'تعویض کاشی، لوله‌کشی و کف‌شور. قشم، محلهٔ سلخ.', wageType: 'توافقی', startWhen: 'از هفتهٔ بعد', audience: ['specialist', 'contractor'], needCount: 1, skills: ['کاشی و سرامیک'] },
      { type: 'consult', title: 'نم زیر کاشی حمام بعد از ۶ ماه', description: 'بعد از بازسازی حمام، دور کف‌شور نم زده. لوله است یا عایق؟', audience: ['engineer', 'specialist'], skills: ['بازدید و کارشناسی'] },
      { type: 'consult', title: 'برای ساحل قشم تیرچه‌بلوک مناسب است؟', description: 'می‌خواهم ویلای یک طبقه بسازم؛ رطوبت و شوری هوا بالاست.', audience: ['engineer', 'contractor'], skills: ['محاسبات سازه'] },
    ],
  },
];

async function main() {
  if (process.argv.includes('--remove')) {
    const del = await db.delete(users).where(like(users.phone, '0900000%')).returning({ phone: users.phone });
    console.log(`✅ ${del.length} حساب نمونه و همهٔ آگهی‌هایشان پاک شد`);
    return;
  }
  for (const p of people) {
    let [u] = await db.select().from(users).where(eq(users.phone, p.phone)).limit(1);
    if (u && (await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, u.id)).limit(1)).length) { console.log('هست:', p.phone); continue; }
    if (!u) [u] = await db.insert(users).values({ phone: p.phone }).returning();
    const prof = await createRoleProfile(u, p.role, p.data);
    for (const a of p.ads) {
      await createAd(prof, {
        province: 'هرمزگان', city: (p.data.city as string) || 'قشم', range: 'province', ...a,
        description: (a.description ?? '') + TAG,
      } as AdInput);
    }
    console.log('✓', prof.displayName, prof.code, '·', p.ads.length, 'آگهی');
  }
}

main()
  .catch((e) => { console.error('❌', e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
