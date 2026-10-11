/**
 * حساب آزمایشی: هر ۶ نقش + مدیر ارشد پنل برای یک شماره (برای تست و جابه‌جایی بین نقش‌ها در اپ).
 *   npm run test:account -- 09121234567
 * اگر حسابی با این شماره نباشد ساخته می‌شود (بعداً با همین شماره و کد پیامکی وارد می‌شوی).
 * نقش‌هایی که از قبل هست دست نمی‌خورد. نام نمایشی: «آزمایش بلوک» تا با کاربران واقعی اشتباه نشود.
 * روی همان دیتابیسی کار می‌کند که DATABASE_URL در .env نشان می‌دهد.
 */
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { admins, profiles, users, type Role } from '../src/db/schema';
import { normalizePhone } from '../src/lib/text';
import { loadConfig } from '../src/lib/appConfig';
import { createRoleProfile } from '../src/modules/profiles/profiles.service';

const BASE = { fn: 'آزمایش', ln: 'بلوک', nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم' };
const FORMS: Record<Role, Record<string, unknown>> = {
  worker: { ...BASE, range: 'کل استان', skills: ['بنایی و دیوارچینی', 'بتن‌ریزی'], exp: '۵ تا ۱۰ سال', wage: '۱.۸۰۰.۰۰۰', team: 'تنها', days: [0, 1, 2, 3, 4], hours: 'تمام روز' },
  specialist: { ...BASE, range: 'کل استان', skills: ['برق‌کاری ساختمان'], exp: 'بیش از ۱۰ سال', cert: 'دارم', rateType: 'روزانه', rate: '۳.۰۰۰.۰۰۰', team: 'تنها', days: [0, 1, 2, 3, 4] },
  engineer: { ...BASE, range: 'کل استان', field: ['عمران', 'معماری'], grade: 'پایه ۱', nezam: '23-10-0001', nprov: 'هرمزگان', comp: ['نظارت', 'طراحی'], services: ['نظارت ساختمان', 'طراحی و نقشه'], days: [1, 4] },
  contractor: { ...BASE, range: 'کل استان', kinds: ['اسکلت بتنی', 'سفت‌کاری'], exp: 'بیش از ۱۰ سال', contract: ['متری'], max: '۴ تا ۶ طبقه', lic: 'ندارم', pub: true },
  company: { cname: 'شرکت آزمایشی بلوک', ctype: 'سهامی خاص', nid: '۱۰۸۶۰۰۰۰۰۰۱', prov: 'هرمزگان', city: 'قشم', rank: 'رتبه ۳', areas: ['مسکونی'], staff: '۱۰ تا ۵۰', fn: 'آزمایش بلوک', pos: 'مدیر پروژه' },
  general: { ...BASE, need: 'ساخت ساختمان', land: 'زمین دارم', budget: 'زیر ۵۰ میلیون' },
};
const ORDER: Role[] = ['contractor', 'worker', 'specialist', 'engineer', 'company', 'general'];

async function main() {
  const phone = normalizePhone(process.argv[2] ?? '');
  if (!phone) throw new Error('شمارهٔ موبایل را بده: npm run test:account -- 09121234567');
  await loadConfig().catch(() => {});
  let [u] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (!u) {
    [u] = await db.insert(users).values({ phone }).returning();
    console.log(`حساب تازه با شمارهٔ ${phone} ساخته شد`);
  }
  if (u.status !== 'active') throw new Error(`وضعیت این حساب «${u.status}» است؛ اول از پنل فعالش کن`);

  for (const role of ORDER) {
    const [has] = await db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.userId, u.id), eq(profiles.role, role))).limit(1);
    if (has) { console.log(`• ${role}: از قبل هست`); continue; }
    const [fresh] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
    const p = await createRoleProfile(fresh, role, FORMS[role], { force: true });
    console.log(`✓ ${role}: ${p.code}`);
  }
  const [cur] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
  if (!cur.activeRole) await db.update(users).set({ activeRole: 'contractor' }).where(eq(users.id, u.id));

  // مدیر ارشد پنل
  await db
    .insert(admins)
    .values({ userId: u.id, roleKey: 'owner', name: 'آزمایش بلوک' })
    .onConflictDoUpdate({ target: admins.userId, set: { roleKey: 'owner', status: 'active', updatedAt: new Date() } });
  await db.update(users).set({ isAdmin: true, updatedAt: new Date() }).where(eq(users.id, u.id));
  const all = await db.select({ role: profiles.role, code: profiles.code }).from(profiles).where(eq(profiles.userId, u.id));
  console.log(`✅ ${phone}: ${all.length} نقش (${all.map((x) => x.role).join('، ')}) + مدیر ارشد پنل`);
}

main()
  .catch((e) => {
    console.error('❌', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
