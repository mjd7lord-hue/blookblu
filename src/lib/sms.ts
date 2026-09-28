import { env } from '../config/env';
import { logger } from './logger';

export interface SmsProvider {
  /** purpose: ورود یا امضای قرارداد — برای الگوی پیامک جدا (اختیاری) */
  sendOtp(phone: string, code: string, purpose?: 'login' | 'sign'): Promise<void>;
}

/** برای توسعه: کد را فقط در لاگ چاپ می‌کند */
const consoleProvider: SmsProvider = {
  async sendOtp(phone, code, purpose = 'login') {
    logger.info({ phone, code, purpose }, '📱 [SMS:console] OTP');
  },
};

/** کاوه‌نگار — سرویس Verify Lookup با قالب تأییدشده */
const kavenegarProvider: SmsProvider = {
  async sendOtp(phone, code, purpose = 'login') {
    if (!env.KAVENEGAR_API_KEY) throw new Error('KAVENEGAR_API_KEY تنظیم نشده');
    const url = new URL(`https://api.kavenegar.com/v1/${env.KAVENEGAR_API_KEY}/verify/lookup.json`);
    url.searchParams.set('receptor', phone);
    url.searchParams.set('token', code);
    url.searchParams.set('template', (purpose === 'sign' && env.KAVENEGAR_SIGN_TEMPLATE) || env.KAVENEGAR_TEMPLATE);
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => null)) as { return?: { status?: number; message?: string } } | null;
    if (!res.ok || body?.return?.status !== 200) {
      throw new Error(`Kavenegar error: ${body?.return?.status} ${body?.return?.message ?? res.statusText}`);
    }
  },
};

/**
 * ملی‌پیامک — وب‌سرویس خدماتی اشتراکی با الگوی تأییدشده (bodyId)؛ کد جای {0} در الگو می‌نشیند.
 * رمز: بهتر است «کلید API» پنل (بخش توسعه‌دهندگان) باشد نه رمز ورود پنل.
 */
const melipayamakProvider: SmsProvider = {
  async sendOtp(phone, code, purpose = 'login') {
    const { MELIPAYAMAK_USERNAME: u, MELIPAYAMAK_PASSWORD: p } = env;
    const bodyId = (purpose === 'sign' && env.MELIPAYAMAK_SIGN_BODY_ID) || env.MELIPAYAMAK_BODY_ID;
    if (!u || !p || !bodyId) throw new Error('تنظیمات ملی‌پیامک کامل نیست');
    const res = await fetch('https://rest.payamak-panel.com/api/SendSMS/BaseServiceNumber', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p, text: code, to: phone, bodyId }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { RetStatus?: number; StrRetStatus?: string } | null;
    if (!res.ok || body?.RetStatus !== 1) {
      throw new Error(`Melipayamak error: ${body?.RetStatus} ${body?.StrRetStatus ?? res.statusText}`);
    }
  },
};

export const sms: SmsProvider = {
  console: consoleProvider,
  kavenegar: kavenegarProvider,
  melipayamak: melipayamakProvider,
}[env.SMS_PROVIDER];
