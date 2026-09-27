import request from 'supertest';
import { createApp } from '../src/app';

export const app = createApp();
export const api = () => request(app);

let n = 0;
/** شمارهٔ یکتا برای هر تست */
export const nextPhone = () => '0912' + String(1000000 + ++n + Math.floor(Math.random() * 1000) * 1000).slice(-7);

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
