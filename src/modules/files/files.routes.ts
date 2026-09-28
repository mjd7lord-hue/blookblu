import { Router } from 'express';
import { ah, parse, uuidParam } from '../../lib/http';
import { storage } from '../../lib/storage';
import { optionalAuth } from '../../middlewares/auth';
import { notFound } from '../../lib/errors';
import { canAccess, checkSignature, getFile } from './files.service';

const r = Router();

/**
 * دریافت فایل. عمومی (عکس پروفایل، نمونه‌کار): آزاد.
 * خصوصی (مدرک، عکس چت): با لینک امضاشده‌ای که API داده، یا با توکن ورودِ کسی که اجازه دارد.
 * برای بقیه «پیدا نشد» — وجود فایل هم لو نمی‌رود.
 */
r.get(
  '/:id',
  optionalAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const f = await getFile(id);
    const ok =
      f.isPublic ||
      checkSignature(f.id, req.query.exp, req.query.sig) ||
      (!!req.user && (await canAccess(f, req.user)));
    if (!ok) throw notFound('فایل پیدا نشد', 'FILE_NOT_FOUND');
    // فرانت روی دامنهٔ دیگری است؛ helmet به‌طور پیش‌فرض <img> بین‌دامنه‌ای را می‌بندد
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await storage.send(res, f.storageKey, f.mime, {
      isPublic: f.isPublic,
      downloadName: f.mime === 'application/pdf' ? (f.originalName ?? undefined) : undefined,
    });
  }),
);

export default r;
