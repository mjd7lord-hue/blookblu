import { EventEmitter } from 'events';

/**
 * رویدادهای لحظه‌ای برای هر کاربر (پیام تازه، خوانده شدن، تغییر پروژه).
 * درون‌حافظه است و برای یک نمونهٔ سرور (پلن فعلی لیارا) کافی است؛
 * برای چند نمونه باید به Redis Pub/Sub منتقل شود.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export type LiveEvent = { type: 'message' | 'conversation' | 'read' | 'project' | 'notification'; data: unknown };

export function emitTo(userIds: string | string[], ev: LiveEvent) {
  for (const id of Array.isArray(userIds) ? userIds : [userIds]) bus.emit(`u:${id}`, ev);
}

export function subscribe(userId: string, fn: (ev: LiveEvent) => void) {
  bus.on(`u:${userId}`, fn);
  return () => bus.off(`u:${userId}`, fn);
}
