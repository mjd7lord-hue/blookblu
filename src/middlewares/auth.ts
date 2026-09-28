import type { Request, Response, NextFunction } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { users, profiles } from '../db/schema';
import { verifyAccess } from '../lib/jwt';
import { forbidden, unauthorized, AppError } from '../lib/errors';

type UserRow = typeof users.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
    profile?: ProfileRow;
  }
}

async function loadUser(req: Request): Promise<UserRow | null> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  const p = verifyAccess(h.slice(7));
  if (!p) throw unauthorized('نشست شما منقضی شده؛ دوباره وارد شوید', 'TOKEN_INVALID');
  const [u] = await db.select().from(users).where(eq(users.id, p.sub)).limit(1);
  if (!u || u.status === 'deleted') throw unauthorized('حساب پیدا نشد', 'TOKEN_INVALID');
  if (u.status === 'suspended') throw new AppError(403, 'SUSPENDED', 'حساب شما موقتاً مسدود است؛ با پشتیبانی تماس بگیرید');
  return u;
}

/** ورود الزامی است */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const u = await loadUser(req);
    if (!u) throw unauthorized();
    req.user = u;
    next();
  } catch (e) {
    next(e);
  }
}

/** ورود اختیاری (مهمان هم می‌تواند آگهی‌ها را ببیند) */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const u = await loadUser(req).catch(() => null);
    if (u) req.user = u;
    next();
  } catch (e) {
    next(e);
  }
}

/** ورود + داشتن نقش فعال؛ پروفایل نقش فعال در req.profile قرار می‌گیرد */
export async function requireProfile(req: Request, res: Response, next: NextFunction) {
  await requireAuth(req, res, async (err?: unknown) => {
    if (err) return next(err);
    try {
      const u = req.user!;
      if (!u.activeRole) throw forbidden('اول یک نقش انتخاب و ثبت‌نام را کامل کنید', 'NO_ROLE');
      const [p] = await db
        .select()
        .from(profiles)
        .where(and(eq(profiles.userId, u.id), eq(profiles.role, u.activeRole)))
        .limit(1);
      if (!p) throw forbidden('پروفایل نقش فعال پیدا نشد', 'NO_ROLE');
      req.profile = p;
      next();
    } catch (e) {
      next(e);
    }
  });
}

/** فقط کارشناس/ادمین بلوک */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  await requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.user!.isAdmin) return next(forbidden('این بخش فقط برای کارشناسان بلوک است', 'NOT_ADMIN'));
    next();
  });
}
