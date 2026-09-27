import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL لازم است'),
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
  MELIPAYAMAK_USERNAME: z.string().optional(),
  MELIPAYAMAK_PASSWORD: z.string().optional(),
  MELIPAYAMAK_BODY_ID: z.coerce.number().optional(),
  CORS_ORIGINS: z.string().default('*'),
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

export const env = parsed.data;

if (env.NODE_ENV === 'production' && env.OTP_DEV_ECHO) {
  console.error('❌ OTP_DEV_ECHO در production نباید روشن باشد');
  process.exit(1);
}
