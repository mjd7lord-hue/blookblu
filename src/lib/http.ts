import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodTypeAny } from 'zod';
import { badRequest } from './errors';

/** خطاهای async را به error handler می‌فرستد */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('اطلاعات فرستاده‌شده کامل یا درست نیست', 'VALIDATION', r.error.flatten());
  }
  return r.data;
}

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const uuidParam = z.object({ id: z.string().uuid() });
