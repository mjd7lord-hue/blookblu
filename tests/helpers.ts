import request from 'supertest';
import { createApp } from '../src/app';

export const app = createApp();
export const api = () => request(app);

let n = 0;
/** شمارهٔ یکتا برای هر تست */
const used = new Set<string>();
export const nextPhone = (): string => {
  // ۷ رقم تصادفی (قبلاً فقط ۱۰ حالت داشت و بین فایل‌های تست تکراری می‌شد)
  const p = '0912' + String(1_000_000 + ((Date.now() * 7 + ++n * 7919 + Math.floor(Math.random() * 9_000_000)) % 9_000_000));
  return used.has(p) ? nextPhone() : (used.add(p), p);
};

export async function login(phone = nextPhone()) {
  const s = await api().post('/api/auth/otp/send').send({ phone });
  if (s.status !== 200) throw new Error('otp send failed ' + JSON.stringify(s.body));
  const v = await api().post('/api/auth/otp/verify').send({ phone, code: s.body.devCode });
  if (v.status !== 200) throw new Error('otp verify failed ' + JSON.stringify(v.body));
  return { phone, token: v.body.accessToken as string, refresh: v.body.refreshToken as string, body: v.body };
}

export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

export const FORMS = {
  worker: {
    fn: 'رضا', ln: 'بهمنی', nat: 'ایرانی', prov: 'هرمزگان', city: 'درگهان', range: 'کل استان',
    skills: ['بنایی و دیوارچینی', 'بتن‌ریزی'], exp: '۵ تا ۱۰ سال', wage: '۱٬۸۰۰٬۰۰۰', team: 'تنها', days: [0, 2, 3], hours: 'تمام روز',
  },
  specialist: {
    fn: 'رضا', ln: 'بهمنی', nat: 'ایرانی', prov: 'هرمزگان', city: 'درگهان', range: 'فقط شهر خودم',
    skills: ['آرماتوربندی'], exp: 'بیش از ۱۰ سال', cert: 'دارم', rateType: 'متری', rate: '۹۵۰۰۰۰۰', team: 'تیم کامل', days: [0, 1],
  },
  contractor: {
    fn: 'مجید', ln: 'یحیایی', nat: 'ایرانی', prov: 'هرمزگان', city: 'قشم', range: 'کل استان',
    kinds: ['اسکلت بتنی', 'سفت‌کاری'], exp: 'بیش از ۱۰ سال', contract: ['متری'], max: '۴ تا ۶ طبقه', lic: 'ندارم', pub: true,
  },
  engineer: {
    fn: 'علی', ln: 'کریمی', nat: 'ایرانی', prov: 'فارس', city: 'شیراز', range: 'کل استان',
    field: 'عمران', grade: 'پایه ۱', nezam: '23-10-0456', nprov: 'فارس', comp: ['نظارت'], services: ['نظارت ساختمان'], days: [1, 4],
  },
  general: { fn: 'سارا', ln: 'نوری', nat: 'ایرانی', prov: 'تهران', city: 'تهران', need: 'بازسازی و تعمیرات', land: 'ساختمان موجود', budget: 'زیر ۵۰ میلیون' },
  company: {
    cname: 'ساحل‌سازان هرمز', ctype: 'سهامی خاص', nid: '۱۰۸۶۱۲۳۴۵۶۷', prov: 'هرمزگان', city: 'بندرعباس',
    rank: 'رتبه ۳', areas: ['مسکونی'], staff: '۱۰ تا ۵۰', fn: 'مجید یحیایی', pos: 'مدیر پروژه',
  },
};

export async function registered(role: keyof typeof FORMS) {
  const u = await login();
  const r = await api().post('/api/me/roles').set(auth(u.token)).send({ role, data: FORMS[role] });
  if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r.body));
  return { ...u, profile: r.body.profile };
}

/** پیمانکار (کارفرما) و متخصص (مجری) با یک پروژهٔ ساخته‌شده از توافق چت */
export async function makeProject() {
  const boss = await registered('contractor');
  const w = await registered('specialist');
  const c = await api().post('/api/conversations').set(auth(boss.token)).send({ profileCode: w.profile.code });
  const cid = c.body.conversation.id;
  const deal = await api()
    .post(`/api/conversations/${cid}/deals`)
    .set(auth(w.token))
    .send({
      job: 'آرماتوربندی سقف دوم',
      qty: 'حدود ۳ تن',
      price: '۹٬۵۰۰٬۰۰۰ تومان هر تن',
      amount: '۲۸٬۵۰۰٬۰۰۰',
      start: 'دوشنبه ۶ مهر، ۷ صبح',
      durationDays: 3,
      plan: [
        { title: 'پیش‌پرداخت', pct: 30 },
        { title: 'پایان کار', pct: 70 },
      ],
      retentionPct: 10,
    });
  const acc = await api().post(`/api/messages/${deal.body.message.id}/answer`).set(auth(boss.token)).send({ status: 'accepted' });
  const pid = acc.body.project.id as string;
  return { boss, w, cid, pid };
}

/** «چند نقش» برای تست‌هایی که عمداً نقش دوم می‌سازند (پیش‌فرض: خاموش = نقش فقط هنگام ثبت‌نام) */
export async function multiRole(on: boolean) {
  const { cfg, saveConfig } = await import('../src/lib/appConfig');
  const { db } = await import('../src/db');
  const { users } = await import('../src/db/schema');
  const [u] = await db.select({ id: users.id }).from(users).limit(1);
  const s = cfg('settings');
  await saveConfig('settings', { ...s, flags: { ...s.flags, multiRole: on } }, u.id);
}
