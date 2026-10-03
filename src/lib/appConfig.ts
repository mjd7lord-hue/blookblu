import { z } from 'zod';
import { db } from '../db';
import { appConfig } from '../db/schema';
import { logger } from './logger';

/**
 * تنظیماتی که مدیر از پنل عوض می‌کند (جدول app_config، هر کلید یک JSON).
 * در حافظه نگه داشته می‌شود تا محاسبه‌ها (مثل هزینهٔ داوری) هم‌زمان بمانند؛ بعد از هر ذخیره تازه می‌شود.
 * اگر سرور چند نمونه شد باید با Redis یا LISTEN/NOTIFY هم‌گام شود (مثل lib/events).
 */

export const DEFAULTS = {
  settings: {
    flags: {
      guest: true,
      english: true,
      push: true,
      arbitration: true,
      boost: true,
      academy: true,
      foreign: true,
      custom: true,
      stories: true,
      autoFlag: true,
      otpVoice: false,
      maintenance: false,
      multiRole: false, // خاموش = نقش فقط یک بار هنگام ثبت‌نام؛ تغییر با پشتیبانی
    },
    ver: { min: '1.0.0', latest: '1.0.0', force: false },
    display: { font: 'متوسط', latin: false, contrast: false, reduce: false },
    logo: 'brand',
  },
  // هم‌تراز با arbFee در فرانت و پنل (CFG.arb و ARB_F)
  coefs: {
    arb: {
      base: 1_200_000,
      simple: 15,
      complex: 20,
      cplxAmt: 200,
      travel: { city: 0, prov: 600_000, far: 2_000_000 },
      amt: [
        [50, 1],
        [200, 1.6],
        [1000, 2.6],
        [1e9, 4],
      ] as [number, number][],
      talk: 48,
      appeal: 72,
      minYears: 5,
      minScore: 80,
      fields: { struct: 1.4, mas: 1, fin: 1, iso: 1.1, elec: 1.2, mech: 1.2, qty: 1.1 } as Record<string, number>,
    },
    est: { eco: 26, mid: 34, lux: 48, con: 0.42, reb: 42, stl: 48, lab: 3.2 },
    tools: { far: 1.8, occ: 60, unitKw: 8, commonKw: 15, pipeLpd: 150 },
  },
  // هم‌تراز با LEGAL فرانت
  legal: {
    terms: {
      n: 'قوانین استفاده',
      v: '۱٫۰',
      d: 'مرداد ۱۴۰۵',
      items: [
        'بلوک بستری برای پیدا کردن نیرو، کار و مشاورهٔ ساختمانی است و طرف قرارداد هیچ‌کدام از کاربران نیست.',
        'بلوک واسطهٔ مالی نیست. پرداخت‌ها مستقیم بین طرفین است؛ پیش از پیش‌پرداخت، کد کاربری و شناسنامهٔ کاری طرف مقابل را تطبیق بده.',
        'اطلاعات پروفایل باید واقعی باشد. پروفایل جعلی یا ادعای مدرک نادرست باعث مسدود شدن حساب می‌شود.',
        'آگهی‌ها باید مربوط به ساخت‌وساز باشند و اطلاعات تماس را در متن آگهی نگذار؛ برای تماس از چت بلوک استفاده کن.',
      ],
    },
    privacy: {
      n: 'حریم خصوصی',
      v: '۱٫۰',
      d: 'مرداد ۱۴۰۵',
      items: [
        'شمارهٔ موبایل تو بدون اجازه‌ات به هیچ کاربری نمایش داده نمی‌شود.',
        'تصاویر کارت ملی فقط برای تأیید هویت بررسی و بعد از تأیید از دسترس خارج می‌شوند.',
        'موقعیت تو در حد شهر و استان نمایش داده می‌شود، نه نشانی دقیق.',
        'می‌توانی هر زمان حسابت را حذف کنی.',
      ],
    },
    rules: {
      n: 'قوانین جامعهٔ بلوک',
      v: '۱٫۰',
      d: 'مرداد ۱۴۰۵',
      items: [
        'با احترام گفت‌وگو کن؛ توهین و تهدید باعث مسدود شدن می‌شود.',
        'درخواست پیش‌پرداخت خارج از توافق ثبت‌شده را گزارش کن.',
        'امتیاز و نظر فقط بعد از پایان واقعی همکاری ثبت می‌شود.',
        'معرفی کسی به‌عنوان قیم یعنی او را واقعاً می‌شناسی.',
      ],
    },
  } as Record<string, { n: string; v: string; d: string; items: string[] }>,
  // استوری‌های بالای خانه (جدا از استوری‌های شخصی خود اپ)
  stories: [] as { id: string; t: string; s: string; p?: string; cta?: string; go?: string; on: boolean }[],
  // دوره‌های آکادمی؛ roles خالی = همه
  courses: [
    { id: 'safety-height', t: 'ایمنی کار در ارتفاع', c: 'ایمنی', l: 5, m: 18, roles: [], st: 'published' },
    { id: 'read-plans', t: 'خواندن نقشهٔ سازه برای استادکار', c: 'نقشه', l: 8, m: 34, roles: ['worker', 'specialist', 'contractor'], st: 'published' },
    { id: 'estimate', t: 'متره و برآورد ساده', c: 'مدیریت', l: 6, m: 27, roles: ['contractor', 'company', 'general', 'engineer'], st: 'published' },
    { id: 'concrete-qc', t: 'کنترل کیفیت بتن‌ریزی', c: 'اجرا', l: 7, m: 25, roles: ['worker', 'specialist', 'contractor', 'engineer'], st: 'published' },
    { id: 'rebar-code', t: 'مقررات ملی: آرماتوربندی', c: 'مقررات', l: 6, m: 30, roles: ['engineer', 'contractor', 'specialist'], st: 'published' },
    { id: 'contract-pay', t: 'قرارداد و پرداخت امن در کار ساختمانی', c: 'حقوقی', l: 4, m: 15, roles: [], st: 'published' },
  ] as { id: string; t: string; c: string; l: number; m: number; roles: string[]; st: 'published' | 'draft' }[],
  // انواع بازدید مهندس (هم‌تراز با VTYPE فرانت)
  visitTypes: [
    { n: 'بازدید فنی عمومی', d: '۱ ساعت', p: 3_500_000 },
    { n: 'کنترل آرماتور پیش از بتن‌ریزی', d: '۱٫۵ ساعت', p: 4_500_000 },
    { n: 'بررسی ترک و نشست', d: '۲ ساعت', p: 6_000_000 },
    { n: 'تحویل مرحله‌ای کار', d: '۲ ساعت', p: 5_500_000 },
  ] as { n: string; d: string; p: number }[],
  // فهرست‌ها و گزینه‌ها: نقش‌های فعال در ثبت‌نام، تصمیم مدیر دربارهٔ «+ مورد دیگر» کاربران، و فهرست‌های نمایشی پنل
  catalog: { roles: {} as Record<string, { on?: boolean; n?: string; d?: string }>, custom: {} as Record<string, 'ok' | 'rej' | { to: string }> } as Record<string, unknown> & {
    roles: Record<string, { on?: boolean; n?: string; d?: string }>;
    custom: Record<string, 'ok' | 'rej' | { to: string }>;
  },
  // «تازه‌های بلوک»: بعد از هر به‌روزرسانی، هنگام ورود به اپ حداکثر ۲ بار نشان داده می‌شود (هر v تازه = دوباره)
  whatsNew: {
    on: true,
    v: '1405-07-11',
    title: 'تازه‌های بلوک',
    items: [
      { t: 'پروفایل و شناسنامهٔ کاری در یک صفحه', d: 'شناسنامهٔ کاری بالای پروفایل است؛ پایین‌تر مهارت‌ها، نمونه‌کار و نظرها.' },
      { t: 'رسید واریز در دفترچهٔ پرداخت', d: 'در صفحهٔ پروژه «ثبت پرداخت» را بزن، رسید و شمارهٔ پیگیری را بگذار؛ با تأیید طرف مقابل در قرارداد مستند می‌شود.' },
      { t: 'ثبت قرارداد از داخل چت', d: 'در چت «ثبت قرارداد» را بزن؛ کار، مبلغ و پرداخت از آگهی پر شده و در ۳ قدم برای طرف مقابل می‌رود.' },
      { t: 'پیشنهاد کار در چت', d: 'در پروفایل هر نفر «پیشنهاد کار در چت» را بزن؛ پیام آماده است، فقط بفرست.' },
      { t: 'کاوش با نقشه', d: 'نوار زیر نقشه می‌گوید چه آگهی‌هایی را می‌بینی؛ با یک لمس همه را ببین.' },
      { t: 'جست‌وجوی افراد با نام یا کد', d: 'در کاوش نام یا کد کاربری (مثل B-4X92) را بنویس؛ کد دقیق مستقیم پروفایل را باز می‌کند.' },
      { t: 'از برآورد تا نیرو', d: 'در «برآورد هزینه» نوع کار را انتخاب کن و «نیروی این پروژه را پیدا کن» را بزن.' },
      { t: 'پرسش تخصصی برای همه', d: 'همه می‌توانند پاسخ بدهند؛ با «مفید بود» و «مفید نبود» بهترین پاسخ‌ها بالا می‌آیند.' },
    ] as { t: string; d: string }[],
  },
  // متن و روشن/خاموش اعلان‌های خودکار (نمایشی در پنل)، و قیمت ارتقای آگهی — فعلاً فقط ذخیره می‌شوند
  notifTemplates: null as unknown,
  boost: null as unknown,
  // محدودیت آگهی رایگان (FREE_AD_LIMIT در اپ): تعداد آگهی کار/نیروی فعال هر کاربر
  limits: { freeAds: 1 },
};

export type ConfigKey = keyof typeof DEFAULTS;
export const CONFIG_KEYS = Object.keys(DEFAULTS) as ConfigKey[];
type Cfg = { [K in ConfigKey]: (typeof DEFAULTS)[K] };

const num = z.number().finite().nonnegative();
/** مقدارهایی که سرور با آن‌ها حساب می‌کند سخت‌گیرانه بررسی می‌شوند؛ بقیه فقط اندازه */
const SCHEMAS: Partial<Record<ConfigKey, z.ZodTypeAny>> = {
  coefs: z.object({
    arb: z.object({
      base: num.min(10_000),
      simple: num.max(90),
      complex: num.max(90),
      cplxAmt: num,
      travel: z.object({ city: num, prov: num, far: num }),
      amt: z.array(z.tuple([num, num.min(0.1)])).min(1).max(10),
      talk: num.min(1).max(24 * 30),
      appeal: num.min(1).max(24 * 30),
      minYears: num.max(60),
      minScore: num.max(100),
      fields: z.record(z.string(), num.min(0.1).max(10)),
    }),
    est: z.record(z.string(), num),
    tools: z.record(z.string(), num),
  }),
  settings: z.object({
    flags: z.record(z.string(), z.boolean()),
    ver: z.object({ min: z.string().max(20), latest: z.string().max(20), force: z.boolean() }),
    display: z.record(z.string(), z.union([z.string().max(30), z.boolean()])),
    logo: z.string().max(30),
  }),
  legal: z.record(z.string(), z.object({ n: z.string().max(80), v: z.string().max(20), d: z.string().max(40), items: z.array(z.string().max(2000)).max(60) })),
  stories: z
    .array(z.object({ id: z.string().max(40), t: z.string().max(40), s: z.string().max(200), p: z.string().max(1000).optional(), cta: z.string().max(40).optional(), go: z.string().max(30).optional(), on: z.boolean() }))
    .max(30),
  courses: z
    .array(
      z.object({
        id: z.string().max(40),
        t: z.string().min(2).max(120),
        c: z.string().max(40),
        l: z.number().int().min(1).max(100),
        m: z.number().int().min(1).max(1000),
        roles: z.array(z.string().max(20)).max(6),
        st: z.enum(['published', 'draft']),
      }),
    )
    .max(200),
  limits: z.object({ freeAds: z.number().int().min(1).max(50) }),
  visitTypes: z.array(z.object({ n: z.string().min(2).max(80), d: z.string().max(30), p: z.number().int().min(0) })).min(1).max(20),
  whatsNew: z.object({
    on: z.boolean(),
    v: z.string().trim().min(1).max(30),
    title: z.string().trim().min(2).max(80),
    items: z.array(z.object({ t: z.string().trim().min(2).max(120), d: z.string().trim().max(400) })).max(12),
  }),
  catalog: z.object({ roles: z.record(z.string(), z.object({ on: z.boolean().optional(), n: z.string().max(40).optional(), d: z.string().max(200).optional() })).default({}), custom: z.record(z.string(), z.unknown()).default({}) }).passthrough(),
};

export function validateConfig(key: ConfigKey, value: unknown) {
  if (JSON.stringify(value ?? null).length > 300_000) return { ok: false as const, message: 'حجم تنظیمات زیاد است' };
  const s = SCHEMAS[key];
  if (!s) return { ok: true as const, value };
  const r = s.safeParse(value);
  if (!r.success) return { ok: false as const, message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ') };
  return { ok: true as const, value: r.data };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function merge(def: unknown, v: unknown): unknown {
  if (v === undefined || v === null) return def;
  if (isObj(def) && isObj(v)) {
    const out: Record<string, unknown> = { ...def };
    for (const k of Object.keys(v)) out[k] = merge(def[k], v[k]);
    return out;
  }
  return v;
}

let stored: Partial<Record<ConfigKey, unknown>> = {};
let current = DEFAULTS as Cfg;
let loading: Promise<void> | null = null;
let loadedOnce = false;

function rebuild() {
  const out = {} as Record<string, unknown>;
  for (const k of CONFIG_KEYS) out[k] = merge(DEFAULTS[k], stored[k]);
  current = out as Cfg;
}

export function loadConfig(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = db
    .select()
    .from(appConfig)
    .then((rows) => {
      stored = Object.fromEntries(rows.filter((r) => (CONFIG_KEYS as string[]).includes(r.key)).map((r) => [r.key, r.value]));
      rebuild();
      loadedOnce = true;
    })
    .catch((err) => {
      loading = null; // دفعهٔ بعد دوباره تلاش شود؛ تا آن موقع پیش‌فرض‌ها
      logger.error({ err }, 'app config load failed');
    });
  return loading;
}

/** middleware: پیش از اولین درخواست تنظیمات از دیتابیس خوانده شود */
export const configReady = (_req: unknown, _res: unknown, next: () => void) => {
  if (loadedOnce) return next();
  void loadConfig().finally(next);
};

export const cfg = <K extends ConfigKey>(key: K): Cfg[K] => current[key];
export const flag = (name: keyof (typeof DEFAULTS)['settings']['flags']) => current.settings.flags[name] !== false;
/** مقدار ذخیره‌شده (بدون پیش‌فرض) — برای پنل که بداند هنوز تنظیم نشده */
export const storedConfig = () => stored;

export async function saveConfig(key: ConfigKey, value: unknown, userId: string) {
  await db
    .insert(appConfig)
    .values({ key, value, updatedBy: userId })
    .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
  stored = { ...stored, [key]: value };
  rebuild();
}

/** فقط برای تست‌ها */
export function resetConfigCache() {
  stored = {};
  rebuild();
  loadedOnce = false;
  loading = null;
}
