import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { notifications, users } from '../../db/schema';
import { logger } from '../../lib/logger';

export type NotifType = 'req' | 'ad' | 'star' | 'id' | 'msg' | 'cal';

// کدام ترجیح کاربر هر نوع اعلان را کنترل می‌کند
const PREF_OF: Record<NotifType, 'requests' | 'messages' | 'ads' | 'reviews' | null> = {
  req: 'requests',
  msg: 'messages',
  ad: 'ads',
  star: 'reviews',
  id: null, // اعلان‌های امنیتی/حساب همیشه فرستاده می‌شوند
  cal: 'requests',
};

/** ثبت اعلان؛ هیچ‌وقت جریان اصلی را خراب نمی‌کند */
export async function notify(
  userId: string,
  n: { type: NotifType; title: string; body?: string; link?: { screen: string; id?: string } },
) {
  try {
    const pref = PREF_OF[n.type];
    if (pref) {
      const [u] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).limit(1);
      if (u?.prefs?.notif?.[pref] === false) return;
    }
    await db.insert(notifications).values({ userId, type: n.type, title: n.title, body: n.body, link: n.link });
    // TODO(فاز بعد): ارسال Push از طریق سرویس داخلی (مثل Pushe یا Najva)
  } catch (e) {
    logger.error({ err: e }, 'notify failed');
  }
}
