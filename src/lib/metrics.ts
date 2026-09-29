import type { NextFunction, Request, Response } from 'express';

/** شمارنده‌های سادهٔ درون‌حافظه برای صفحهٔ «وضعیت سرویس» پنل ادمین */
const startedAt = Date.now();
let minute = 0;
let perMinute: number[] = [];
let errDay = '';
let errors5xx = 0;
let requests = 0;

const day = () => new Date().toISOString().slice(0, 10);

export function countRequests(_req: Request, res: Response, next: NextFunction) {
  const m = Math.floor(Date.now() / 60_000);
  if (m !== minute) {
    perMinute.push(0);
    if (perMinute.length > 10) perMinute = perMinute.slice(-10);
    minute = m;
  }
  perMinute[perMinute.length - 1]++;
  requests++;
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    const d = day();
    if (d !== errDay) {
      errDay = d;
      errors5xx = 0;
    }
    errors5xx++;
  });
  next();
}

export function metrics() {
  const full = perMinute.slice(0, -1);
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    requestsPerMinute: full.length ? Math.round(full.reduce((a, b) => a + b, 0) / full.length) : (perMinute[0] ?? 0),
    requestsTotal: requests,
    errors5xxToday: errDay === day() ? errors5xx : 0,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
  };
}
