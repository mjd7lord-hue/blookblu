import 'dotenv/config';
import { z } from 'zod';

// متغیرِ خالی در .env (مثل PUBLIC_BASE_URL=) یعنی تنظیم‌نشده
const optUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
const optStr = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL لازم است'),
  // اتصال مستقیم/Session pooler برای migration (Supabase: پورت 5432). اگر نبود، همان DATABASE_URL
  DIRECT_URL: optStr,
  // Supabase و بیشتر سرویس‌های ابری اتصال SSL می‌خواهند
  DB_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET باید حداقل ۳۲ کاراکتر باشد'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET باید حداقل ۳۲ کاراکتر باشد'),
  ACCESS_TOKEN_TTL: z.string().default('1h'),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(60),
  OTP_TTL_SECONDS: z.coerce.number().default(120),
  OTP_RESEND_SECONDS: z.coerce.number().default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_MAX_PER_HOUR: z.coerce.number().default(5),
  SMS_PROVIDER: z.enum(['console', 'kavenegar', 'melipayamak']).default('console'),
  KAVENEGAR_API_KEY: z.string().optional(),
  KAVENEGAR_TEMPLATE: z.string().default('block-otp'),
  // الگوی جدا برای کد امضای قرارداد (اختیاری؛ اگر نبود همان الگوی ورود)
  KAVENEGAR_SIGN_TEMPLATE: optStr,
  MELIPAYAMAK_USERNAME: z.string().optional(),
  MELIPAYAMAK_PASSWORD: z.string().optional(),
  MELIPAYAMAK_BODY_ID: z.coerce.number().optional(),
  MELIPAYAMAK_SIGN_BODY_ID: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().optional()),
  // شمارهٔ خط پنل برای پیامک متنی (هشدار سرور)؛ کاوه‌نگار: اختیاری
  MELIPAYAMAK_FROM: optStr,
  KAVENEGAR_SENDER: optStr,
  // پایش: شماره‌هایی که هشدار «دیتابیس قطع شد/برگشت» را پیامک می‌گیرند (با کاما)
  ALERT_PHONES: z.string().default(''),
  // بیدار نگه داشتن سرور رایگان Render: هر ۱۰ دقیقه این آدرس خودش را صدا می‌زند.
  // اگر خالی باشد از RENDER_EXTERNAL_URL (خود Render می‌گذارد) یا PUBLIC_BASE_URL استفاده می‌شود
  KEEPALIVE_URL: optUrl,
  RENDER_EXTERNAL_URL: optUrl,
  CORS_ORIGINS: z.string().default('*'),
  // ذخیرهٔ فایل: supabase = Supabase Storage، local = پوشهٔ روی سرور (توسعه/تست)، s3 = هر سرویس سازگار با S3
  // auto (پیش‌فرض): اگر کلید Supabase تنظیم شده باشد supabase، وگرنه local
  STORAGE_DRIVER: z.enum(['auto', 'supabase', 'local', 's3']).default('auto'),
  // Supabase → Project Settings → API. اگر SUPABASE_URL نبود، از DATABASE_URL ساخته می‌شود
  SUPABASE_URL: optUrl,
  SUPABASE_SERVICE_ROLE_KEY: optStr,
  SUPABASE_BUCKET: z.string().default('blook-files'),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),
  S3_ENDPOINT: optUrl,
  S3_REGION: z.string().default('default'),
  S3_BUCKET: optStr,
  S3_ACCESS_KEY: optStr,
  S3_SECRET_KEY: optStr,
  // اعتبار لینک امضاشدهٔ فایل‌های خصوصی (مدرک، عکس چت)
  FILE_URL_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  // اگر تنظیم شود لینک فایل‌ها کامل برگردانده می‌شود (مثلاً https://api.blook.ir)؛ وگرنه نسبی (/api/files/...)
  PUBLIC_BASE_URL: optUrl.transform((v) => v?.replace(/\/+$/, '')),
  // راهنمای پرداخت امانی هزینهٔ داوری (تا درگاه بانکی وصل شود)، مثلاً شمارهٔ کارت/شبا و نام
  ARB_PAYMENT_INFO: optStr,
  // فقط در توسعه: کد OTP در پاسخ API برگردانده می‌شود تا تست راحت باشد
  OTP_DEV_ECHO: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ تنظیمات محیطی نامعتبر است:');
  for (const i of parsed.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}

// آدرس پروژهٔ Supabase از نام کاربری pooler (postgres.<ref>) هم قابل حدس است
function supabaseUrl(d: z.infer<typeof schema>): string | undefined {
  if (d.SUPABASE_URL) return d.SUPABASE_URL.replace(/\/+$/, '');
  const ref = d.DATABASE_URL.match(/\/\/postgres\.([a-z0-9]{20})[:@]/)?.[1];
  return ref ? `https://${ref}.supabase.co` : undefined;
}

export const env = {
  ...parsed.data,
  SUPABASE_URL: supabaseUrl(parsed.data),
  STORAGE_DRIVER: (parsed.data.STORAGE_DRIVER === 'auto'
    ? parsed.data.SUPABASE_SERVICE_ROLE_KEY
      ? 'supabase'
      : 'local'
    : parsed.data.STORAGE_DRIVER) as 'supabase' | 'local' | 's3',
};

if (env.STORAGE_DRIVER === 'supabase' && !(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) {
  console.error('❌ برای STORAGE_DRIVER=supabase باید SUPABASE_SERVICE_ROLE_KEY (و اگر از DATABASE_URL پیدا نشد، SUPABASE_URL) تنظیم شود');
  process.exit(1);
}

if (env.STORAGE_DRIVER === 's3' && !(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY)) {
  console.error('❌ برای STORAGE_DRIVER=s3 باید S3_ENDPOINT، S3_BUCKET، S3_ACCESS_KEY و S3_SECRET_KEY تنظیم شوند');
  process.exit(1);
}

if (env.NODE_ENV === 'production' && env.OTP_DEV_ECHO) {
  console.error('❌ OTP_DEV_ECHO در production نباید روشن باشد');
  process.exit(1);
}
