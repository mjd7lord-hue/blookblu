/**
 * دادهٔ نمونه برای توسعه (هم‌تراز با آدم‌ها و آگهی‌های پروتوتایپ).
 * اجرا: npm run db:seed — فقط روی دیتابیس توسعه!
 */
import { eq } from 'drizzle-orm';
import { db, pool } from './index';
import { users } from './schema';
import { env } from '../config/env';
import { createRoleProfile } from '../modules/profiles/profiles.service';
import { createAd } from '../modules/ads/ads.service';

const people = [
  {
    phone: '09170000001',
    role: 'engineer' as const,
    data: { fn: 'علی', ln: 'کریمی', nat: 'ایرانی', prov: 'فارس', city: 'شیراز', range: 'کل استان', field: 'عمران', grade: 'پایه ۱', comp: ['نظارت', 'محاسبات'], services: ['نظارت ساختمان', 'محاسبات سازه', 'متره و برآورد'], visit: 3500000, cap: '۳ تا ۵', days: [0, 2, 5], pub: true },
    ads: [{ type: 'work' as const, title: 'نظارت و محاسبات سازه برای ویلا و مسکونی', description: 'محاسبهٔ سازه، نظارت مرحله‌ای و گزارش بازدید مکتوب.', province: 'فارس', city: 'شیراز', wageType: 'پروژه‌ای', wageAmount: 18000000, startWhen: 'با هماهنگی', range: 'province' as const, audience: ['general', 'contractor', 'company'] as const, skills: ['نظارت ساختمان', 'محاسبات سازه'] }],
  },
  {
    phone: '09170000002',
    role: 'contractor' as const,
    data: { fn: 'حسین', ln: 'توکلی', nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم', range: 'کل استان', kinds: ['اسکلت بتنی', 'نازک‌کاری'], exp: 'بیش از ۱۰ سال', contract: ['متری', 'درصدی (امانی)'], max: '۴ تا ۶ طبقه', crew: 8, lic: 'مجری ذی‌صلاح', bio: 'پیمانکار کلی با تمرکز بر پروژه‌های تجاری و مسکونی میان‌مقیاس در جزیرهٔ قشم.', pub: true },
    ads: [{ type: 'job' as const, title: '۳ کارگر برای بلوک‌چینی دیوارهای طبقهٔ دوم', description: 'کار حدود ۱۰ روز. ناهار و آب با کارگاه.', province: 'هرمزگان', city: 'درگهان', wageType: 'روزانه', wageAmount: 1800000, startWhen: 'فوری', range: 'city' as const, audience: ['worker'] as const, needCount: 3, skills: ['بنایی و دیوارچینی'] }],
  },
  {
    phone: '09170000003',
    role: 'specialist' as const,
    data: { fn: 'رضا', ln: 'بهمنی', nat: 'ایرانی', prov: 'هرمزگان', city: 'درگهان', range: 'فقط شهر خودم', skills: ['آرماتوربندی'], exp: 'بیش از ۱۰ سال', cert: 'دارم', rateType: 'متری', rate: 9500000, team: 'تیم کامل', days: [0, 1, 2], pub: true },
    ads: [{ type: 'work' as const, title: 'آرماتوربند با ۱۸ سال سابقه، آماده از شنبه', description: 'با تیم ۳ نفره آرماتوربندی سقف و فونداسیون انجام می‌دهیم.', province: 'هرمزگان', city: 'درگهان', wageType: 'تنی', wageAmount: 9500000, startWhen: 'فوری', range: 'city' as const, audience: ['contractor', 'company', 'general'] as const, skills: ['آرماتوربندی'] }],
  },
  {
    phone: '09170000004',
    role: 'general' as const,
    data: { fn: 'سارا', ln: 'نوری', nat: 'ایرانی', prov: 'تهران', city: 'تهران', need: 'بازسازی و تعمیرات', land: 'ساختمان موجود' },
    ads: [{ type: 'consult' as const, title: 'علت ترک مورب کنار پنجره چیست؟', description: 'ساختمان ۸ ساله است. ترک از گوشهٔ پنجره به سمت بالا رفته.', province: 'تهران', city: 'تهران', range: 'city' as const, audience: ['engineer'] as const, skills: ['نظارت ساختمان'] }],
  },
];

async function main() {
  if (env.NODE_ENV === 'production') throw new Error('seed در production اجرا نمی‌شود');
  for (const p of people) {
    const [exists] = await db.select().from(users).where(eq(users.phone, p.phone)).limit(1);
    if (exists) {
      console.log('skip', p.phone);
      continue;
    }
    const [u] = await db.insert(users).values({ phone: p.phone, kycStatus: 'verified' }).returning();
    const prof = await createRoleProfile(u, p.role, p.data);
    for (const a of p.ads) await createAd(prof, { ...a, audience: [...a.audience] });
    console.log('✓', prof.displayName, prof.code);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
