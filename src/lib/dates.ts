/** تاریخ امروز به وقت تهران به شکل YYYY-MM-DD (برای ستون‌های date) */
export function tehranDay(offsetDays = 0, from = new Date()): string {
  const d = new Date(from.getTime() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** روز هفته به ترتیب اپ: ۰ = شنبه … ۶ = جمعه */
export function weekIndex(day: string): number {
  return (new Date(day + 'T12:00:00Z').getUTCDay() + 1) % 7;
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** «شنبه ۴ مهر» */
export function faDay(day: string): string {
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(day + 'T12:00:00Z'));
}

export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
