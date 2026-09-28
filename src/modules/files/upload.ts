import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { AppError, badRequest } from '../../lib/errors';
import { MAX_UPLOAD_BYTES } from './files.service';

const m = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 4000 },
});

/** دریافت یک فایل از فیلد `file` (multipart/form-data) با پیام خطای فارسی */
export function singleFile(req: Request, res: Response, next: NextFunction) {
  m.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(badRequest(`حجم فایل حداکثر ${MAX_UPLOAD_BYTES / 1024 / 1024} مگابایت است`, 'FILE_TOO_LARGE'));
      return next(badRequest('فقط یک فایل در فیلد «file» بفرستید', 'UPLOAD_INVALID'));
    }
    if (err) return next(err);
    if (!req.file) return next(badRequest('فایلی فرستاده نشده', 'NO_FILE'));
    next();
  });
}

/** جلوگیری از پر کردن فضا: حداکثر ۶۰ آپلود در ۱۰ دقیقه برای هر کاربر */
export const uploadLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // همیشه بعد از requireAuth استفاده می‌شود
  keyGenerator: (req) => 'u:' + req.user!.id,
  handler: (_req, _res, next) => next(new AppError(429, 'UPLOAD_RATE', 'تعداد آپلودها زیاد است؛ چند دقیقه بعد دوباره تلاش کنید')),
});
