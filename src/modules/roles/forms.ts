/**
 * فرم‌های ثبت‌نام هر نقش — دقیقاً هم‌تراز با فرم‌های اپ (REG در پروتوتایپ).
 * یک تعریف، دو کاربرد: اعتبارسنجی سمت سرور + ارسال به اپ از مسیر /api/meta/roles
 */
import type { Role } from '../../db/schema';
import { cfg } from '../../lib/appConfig';

export type FieldType = 'text' | 'area' | 'num' | 'chips' | 'multi' | 'toggle' | 'days' | 'prov' | 'city';

export type Field = {
  k: string;
  t: FieldType;
  label: string;
  req?: boolean;
  opts?: string[];
  max?: number;
  /** کاربر می‌تواند «مورد دیگر» اضافه کند */
  custom?: boolean;
  /** فقط وقتی این شرط برقرار است نمایش/الزام دارد */
  show?: (d: Record<string, unknown>) => boolean;
  /** هرگز در پروفایل عمومی نمایش داده نمی‌شود */
  private?: boolean;
  pattern?: RegExp;
  patternMsg?: string;
};

export type Step = { title: string; f: Field[] };

export const PROVINCES = [
  'آذربایجان شرقی', 'آذربایجان غربی', 'اردبیل', 'اصفهان', 'البرز', 'ایلام', 'بوشهر', 'تهران',
  'چهارمحال و بختیاری', 'خراسان جنوبی', 'خراسان رضوی', 'خراسان شمالی', 'خوزستان', 'زنجان',
  'سمنان', 'سیستان و بلوچستان', 'فارس', 'قزوین', 'قم', 'کردستان', 'کرمان', 'کرمانشاه',
  'کهگیلویه و بویراحمد', 'گلستان', 'گیلان', 'لرستان', 'مازندران', 'مرکزی', 'هرمزگان', 'همدان', 'یزد',
];

export const EXP = ['کمتر از ۱ سال', '۱ تا ۳ سال', '۳ تا ۵ سال', '۵ تا ۱۰ سال', 'بیش از ۱۰ سال'];

export const RANGE_OPTS: Record<string, 'city' | 'km50' | 'province' | 'country'> = {
  'فقط شهر خودم': 'city',
  'تا ۵۰ کیلومتر': 'km50',
  'کل استان': 'province',
  'هر جای ایران': 'country',
};

const foreign = (d: Record<string, unknown>) => d.nat === 'اتباع خارجی';
const NAT: Field[] = [
  { k: 'nat', t: 'chips', label: 'تابعیت', opts: ['ایرانی', 'اتباع خارجی'], req: true },
  { k: 'natc', t: 'chips', label: 'کشور', opts: ['افغانستان', 'عراق', 'پاکستان', 'ترکیه'], req: true, custom: true, show: foreign },
  {
    k: 'idType', t: 'chips', label: 'مدرک اقامت معتبر', req: true, custom: true, show: foreign, private: true,
    opts: ['کارت آمایش', 'کارت هویت اتباع (کد فراگیر)', 'گذرنامه با روادید کار', 'برگهٔ سرشماری'],
  },
  { k: 'idNo', t: 'text', label: 'شمارهٔ مدرک یا کد فراگیر', req: true, show: foreign, private: true },
  { k: 'wp', t: 'chips', label: 'پروانهٔ کار اتباع', opts: ['دارم', 'در حال اقدام', 'ندارم'], show: foreign },
];

const BASE: Step = {
  title: 'اطلاعات پایه',
  f: [
    { k: 'fn', t: 'text', label: 'نام', req: true },
    { k: 'ln', t: 'text', label: 'نام خانوادگی', req: true },
    ...NAT,
    // اختیاری؛ سن روی شناسنامهٔ کاری
    { k: 'by', t: 'text', label: 'سال تولد', pattern: /^1[34]\d\d$/, patternMsg: 'سال تولد را شمسی و ۴ رقمی بنویس، مثلاً ۱۳۶۵' },
    { k: 'prov', t: 'prov', label: 'استان محل کار', req: true },
    { k: 'city', t: 'city', label: 'شهر', req: true },
    { k: 'range', t: 'chips', label: 'تا کجا برای کار می‌روی؟', opts: Object.keys(RANGE_OPTS), req: true },
  ],
};

const PRIV: Step = {
  title: 'حریم خصوصی',
  f: [
    { k: 'pub', t: 'toggle', label: 'پروفایل عمومی' },
    { k: 'showPhone', t: 'toggle', label: 'نمایش شماره روی شناسنامهٔ کاری' },
    { k: 'ref', t: 'text', label: 'معرف (اختیاری)' },
  ],
};

const noLicense = (d: Record<string, unknown>) => !!d.grade && d.grade !== 'هنوز پروانه ندارم';

export const REG: Record<Role, Step[]> = {
  worker: [
    BASE,
    {
      title: 'چه کارهایی بلدی؟',
      f: [
        {
          k: 'skills', t: 'multi', max: 5, req: true, custom: true, label: 'مهارت‌ها',
          opts: ['کارگر ساده', 'بنایی و دیوارچینی', 'کمک‌آرماتوربند', 'کمک‌قالب‌بند', 'گچ و خاک', 'کمک‌کاشی‌کار', 'نقاشی', 'بتن‌ریزی', 'تخریب و نخاله', 'حمل مصالح', 'ایزوگام', 'نظافت پایان کار'],
        },
        { k: 'exp', t: 'chips', label: 'سابقهٔ کار ساختمانی', opts: EXP, req: true },
      ],
    },
    {
      title: 'شرایط کار',
      f: [
        { k: 'wage', t: 'num', label: 'دستمزد روزانهٔ پیشنهادی' },
        { k: 'team', t: 'chips', label: 'چطور کار می‌کنی؟', opts: ['تنها', 'با یک همکار', 'با تیم ۳ نفره یا بیشتر'], req: true },
        { k: 'tools', t: 'toggle', label: 'ابزار شخصی دارم' },
        { k: 'stay', t: 'toggle', label: 'اسکان در کارگاه را قبول می‌کنم' },
        { k: 'ins', t: 'toggle', label: 'بیمهٔ تأمین اجتماعی دارم' },
      ],
    },
    {
      title: 'روزهای آزاد',
      f: [
        { k: 'days', t: 'days', label: 'این هفته', req: true },
        { k: 'hours', t: 'chips', label: 'ساعت کار', opts: ['صبح تا ظهر', 'تمام روز', 'شیفت شب هم می‌آیم'], req: true },
      ],
    },
    PRIV,
  ],

  specialist: [
    BASE,
    {
      title: 'رشتهٔ تخصصی',
      f: [
        {
          k: 'skills', t: 'multi', max: 3, req: true, custom: true, label: 'رشته',
          opts: ['برق‌کاری ساختمان', 'لوله‌کشی و تأسیسات', 'جوشکاری و اسکلت فلزی', 'آرماتوربندی', 'قالب‌بندی', 'کاشی و سرامیک', 'سنگ‌کاری و نما', 'گچ‌کاری و کناف', 'نقاشی ساختمان', 'کابینت و MDF', 'درب و پنجرهٔ UPVC', 'ایزوگام و عایق‌کاری', 'بنایی و آجرکاری', 'سرکارگری اسکلت بتنی'],
        },
        { k: 'exp', t: 'chips', label: 'سابقه', opts: EXP, req: true },
      ],
    },
    {
      title: 'مدرک مهارت',
      f: [
        { k: 'cert', t: 'chips', label: 'گواهی مهارت فنی‌وحرفه‌ای یا کارت مهارت ساختمانی', opts: ['دارم', 'ندارم'], req: true },
        { k: 'warranty', t: 'chips', label: 'ضمانت کار', opts: ['ندارد', '۳ ماه', '۶ ماه', '۱ سال'] },
      ],
    },
    {
      title: 'دستمزد و تیم',
      f: [
        { k: 'rateType', t: 'chips', label: 'روش دستمزد', opts: ['روزانه', 'متری', 'پروژه‌ای', 'توافقی'], req: true },
        { k: 'rate', t: 'num', label: 'نرخ پایه', show: (d) => !!d.rateType && d.rateType !== 'توافقی' },
        { k: 'team', t: 'chips', label: 'تیم', opts: ['تنها', 'با شاگرد', 'تیم کامل'], req: true },
        { k: 'tools', t: 'toggle', label: 'ابزار کامل دارم' },
      ],
    },
    { title: 'نمونه‌کار و روزهای آزاد', f: [{ k: 'days', t: 'days', label: 'روزهای آزاد این هفته', req: true }] },
    PRIV,
  ],

  engineer: [
    BASE,
    {
      title: 'رشته و پایه',
      f: [
        { k: 'field', t: 'chips', label: 'رشته', req: true, custom: true, opts: ['عمران', 'معماری', 'تأسیسات مکانیکی', 'تأسیسات برقی', 'نقشه‌برداری', 'شهرسازی', 'ترافیک'] },
        { k: 'grade', t: 'chips', label: 'پایهٔ پروانه', req: true, opts: ['پایه ۳', 'پایه ۲', 'پایه ۱', 'ارشد', 'هنوز پروانه ندارم'] },
        { k: 'nezam', t: 'text', label: 'شمارهٔ عضویت نظام مهندسی', show: noLicense },
        { k: 'nprov', t: 'prov', label: 'استان سازمان نظام مهندسی', show: noLicense },
      ],
    },
    {
      title: 'صلاحیت و خدمات',
      f: [
        { k: 'comp', t: 'multi', label: 'صلاحیت‌ها', req: true, custom: true, opts: ['طراحی', 'نظارت', 'اجرا', 'محاسبات'] },
        {
          k: 'services', t: 'multi', max: 6, label: 'خدمات', req: true, custom: true,
          opts: ['نظارت ساختمان', 'طراحی و نقشه', 'محاسبات سازه', 'متره و برآورد', 'بازدید و کارشناسی', 'ترک و مقاوم‌سازی', 'پروانه و پایان‌کار', 'نقشهٔ ازبیلت', 'نقشه‌برداری و پیاده‌کردن'],
        },
      ],
    },
    {
      title: 'تعرفه و ظرفیت',
      f: [
        { k: 'visit', t: 'num', label: 'هزینهٔ هر بازدید' },
        { k: 'cap', t: 'chips', label: 'پروژه‌های همزمان نظارت', opts: ['۱ تا ۲', '۳ تا ۵', 'بیش از ۵'] },
        { k: 'days', t: 'days', label: 'روزهای قابل بازدید', req: true },
      ],
    },
    PRIV,
  ],

  contractor: [
    BASE,
    {
      title: 'نوع پیمانکاری',
      f: [
        {
          k: 'kinds', t: 'multi', max: 3, req: true, custom: true, label: 'حوزهٔ کار',
          opts: ['ساخت کامل ساختمان', 'اسکلت بتنی', 'اسکلت فلزی', 'سفت‌کاری', 'نازک‌کاری', 'نما', 'تأسیسات', 'بازسازی و تعمیرات', 'گودبرداری و خاکبرداری', 'محوطه‌سازی'],
        },
        { k: 'exp', t: 'chips', label: 'سابقه', opts: EXP, req: true },
      ],
    },
    {
      title: 'روش کار',
      f: [
        { k: 'contract', t: 'multi', label: 'نوع قرارداد', req: true, custom: true, opts: ['درصدی (امانی)', 'مقطوع', 'متری', 'دستمزدی'] },
        { k: 'max', t: 'chips', label: 'بزرگ‌ترین پروژهٔ اجراشده', req: true, opts: ['ویلایی و یک‌طبقه', 'تا ۳ طبقه', '۴ تا ۶ طبقه', '۷ طبقه و بیشتر'] },
        { k: 'conc', t: 'num', label: 'پروژه‌های همزمان' },
        { k: 'crew', t: 'num', label: 'تیم ثابت' },
      ],
    },
    {
      title: 'مجوزها',
      f: [
        { k: 'lic', t: 'chips', label: 'صلاحیت اجرا', req: true, opts: ['پروانهٔ اجرا از نظام مهندسی', 'مجری ذی‌صلاح', 'ندارم'] },
        { k: 'ins', t: 'toggle', label: 'بیمهٔ مسئولیت کارگاه دارم' },
      ],
    },
    { title: 'نمونه پروژه‌ها', f: [{ k: 'bio', t: 'area', label: 'معرفی کوتاه' }] },
    PRIV,
  ],

  company: [
    {
      title: 'مشخصات شرکت',
      f: [
        { k: 'cname', t: 'text', label: 'نام شرکت', req: true },
        { k: 'ctype', t: 'chips', label: 'نوع شرکت', req: true, custom: true, opts: ['سهامی خاص', 'مسئولیت محدود', 'تعاونی'] },
        { k: 'nid', t: 'text', label: 'شناسهٔ ملی شرکت', req: true, pattern: /^\d{11}$/, patternMsg: 'شناسهٔ ملی شرکت ۱۱ رقم است' },
        { k: 'reg', t: 'text', label: 'شمارهٔ ثبت' },
        { k: 'prov', t: 'prov', label: 'استان دفتر', req: true },
        { k: 'city', t: 'city', label: 'شهر', req: true },
      ],
    },
    {
      title: 'رتبه و صلاحیت',
      f: [
        { k: 'rank', t: 'chips', label: 'رتبهٔ پیمانکاری ساختمان و ابنیه', req: true, opts: ['رتبه ۱', 'رتبه ۲', 'رتبه ۳', 'رتبه ۴', 'رتبه ۵', 'ندارد'] },
        { k: 'nezam', t: 'multi', label: 'صلاحیت نظام مهندسی', custom: true, opts: ['مجری ذی‌صلاح حقوقی', 'انبوه‌سازی', 'طراحی حقوقی', 'نظارت حقوقی'] },
        { k: 'areas', t: 'multi', label: 'حوزه‌های کار', req: true, custom: true, opts: ['مسکونی', 'تجاری', 'صنعتی و سوله', 'ابنیهٔ دولتی', 'بازسازی'] },
      ],
    },
    {
      title: 'ظرفیت',
      f: [
        { k: 'staff', t: 'chips', label: 'تعداد پرسنل', req: true, opts: ['کمتر از ۱۰', '۱۰ تا ۵۰', '۵۰ تا ۲۰۰', 'بیش از ۲۰۰'] },
        { k: 'mach', t: 'toggle', label: 'ماشین‌آلات اختصاصی داریم' },
      ],
    },
    {
      title: 'نمایندهٔ شرکت',
      f: [
        { k: 'fn', t: 'text', label: 'نام و نام خانوادگی نماینده', req: true },
        { k: 'pos', t: 'text', label: 'سمت', req: true },
      ],
    },
    PRIV,
  ],

  general: [
    {
      title: 'اطلاعات پایه',
      f: [
        { k: 'fn', t: 'text', label: 'نام', req: true },
        { k: 'ln', t: 'text', label: 'نام خانوادگی', req: true },
        ...NAT,
        { k: 'prov', t: 'prov', label: 'استان ملک', req: true },
        { k: 'city', t: 'city', label: 'شهر', req: true },
      ],
    },
    {
      title: 'چه کاری در پیش داری؟',
      f: [
        { k: 'need', t: 'chips', label: 'نیاز', req: true, custom: true, opts: ['ساخت ویلا یا ساختمان', 'بازسازی و تعمیرات', 'کار جزئی و فوری', 'مشاوره و بازدید فنی', 'فعلاً فقط نگاه می‌کنم'] },
        { k: 'land', t: 'chips', label: 'وضعیت ملک', custom: true, opts: ['زمین دارم', 'پروانه گرفته‌ام', 'در حال ساخت', 'ساختمان موجود'], show: (d) => !!d.need && d.need !== 'فعلاً فقط نگاه می‌کنم' },
        { k: 'budget', t: 'chips', label: 'بودجهٔ تقریبی', opts: ['زیر ۵۰ میلیون', '۵۰ تا ۵۰۰ میلیون', '۵۰۰ میلیون تا ۲ میلیارد', 'بیش از ۲ میلیارد'], show: (d) => !!d.need && d.need !== 'فعلاً فقط نگاه می‌کنم', private: true },
      ],
    },
    {
      title: 'حریم خصوصی',
      f: [
        { k: 'showPhone', t: 'toggle', label: 'نمایش شماره به نیروهایی که با آن‌ها توافق کرده‌ام' },
        { k: 'pub', t: 'toggle', label: 'پروفایل عمومی کارفرما' },
      ],
    },
  ],
};

export const ROLE_INFO: Record<Role, { name: string; desc: string }> = {
  worker: { name: 'کارگر', desc: 'کار روزمزد: بنایی، کمک‌کار، بتن‌ریزی، حمل مصالح' },
  specialist: { name: 'متخصص (استادکار)', desc: 'برق، لوله‌کشی، جوش، کاشی، کناف، نما و…' },
  engineer: { name: 'مهندس', desc: 'نظارت، طراحی، محاسبات، بازدید و کارشناسی' },
  contractor: { name: 'پیمانکار', desc: 'اجرای پروژه یا بخشی از آن با تیم خودت' },
  company: { name: 'شرکت ساختمانی', desc: 'شخص حقوقی با شناسهٔ ملی و روزنامهٔ رسمی' },
  general: { name: 'کارفرما (کاربر عادی)', desc: 'صاحب‌کار؛ دنبال نیرو، پیمانکار یا مشاورم' },
};

export const allFields = (role: Role) => REG[role].flatMap((s) => s.f);

export const privateKeys = (role: Role) => new Set(allFields(role).filter((f) => f.private).map((f) => f.k));

/** گزینه‌های «+ مورد دیگر» که مدیر در پنل پذیرفته (فهرست‌ها ← مورد دیگر) */
export function acceptedExtras(role: Role, field: string) {
  const pre = `${role}.${field}|`;
  return Object.entries(cfg('catalog').custom ?? {})
    .filter(([k, v]) => k.startsWith(pre) && v === 'ok')
    .map(([k]) => k.slice(pre.length));
}

/** نسخهٔ قابل ارسال به اپ (بدون تابع show) */
export function formsForClient() {
  const cat = cfg('catalog').roles ?? {};
  return (Object.keys(REG) as Role[]).map((role) => ({
    role,
    ...ROLE_INFO[role],
    // نقشی که مدیر ثبت‌نامش را بسته
    enabled: cat[role]?.on !== false,
    steps: REG[role].map((s) => ({
      title: s.title,
      fields: s.f.map(({ show, pattern, patternMsg, ...rest }) => {
        const extra = rest.custom && rest.opts ? acceptedExtras(role, rest.k).filter((v) => !rest.opts!.includes(v)) : [];
        return { ...rest, ...(extra.length ? { opts: [...rest.opts!, ...extra] } : {}), conditional: !!show };
      }),
    })),
  }));
}
