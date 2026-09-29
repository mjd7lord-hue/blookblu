import type { Request, Response, NextFunction } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { adminRoles, admins, users, profiles, type AdminModule, type AdminPerms } from '../db/schema';
import { verifyAccess } from '../lib/jwt';
import { forbidden, unauthorized, AppError } from '../lib/errors';

type UserRow = typeof users.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;
export type AdminCtx = { id: string; name: string; roleKey: string; roleName: string; perms: AdminPerms; provinces: string[] };

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
    profile?: ProfileRow;
    admin?: AdminCtx;
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

/** مدیر پنل: ردیف admins با نقش و دسترسی‌ها؛ کاربر قدیمیِ is_admin خودکار «مدیر ارشد» می‌شود */
async function loadAdmin(u: UserRow): Promise<AdminCtx | null> {
  const q = () =>
    db
      .select({ a: admins, r: adminRoles })
      .from(admins)
      .innerJoin(adminRoles, eq(adminRoles.key, admins.roleKey))
      .where(eq(admins.userId, u.id))
      .limit(1);
  let [row] = await q();
  if (!row && u.isAdmin) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.phone;
    await db.insert(admins).values({ userId: u.id, roleKey: 'owner', name }).onConflictDoNothing();
    [row] = await q();
  }
  if (!row || row.a.status !== 'active') return null;
  return { id: row.a.id, name: row.a.name, roleKey: row.r.key, roleName: row.r.name, perms: row.r.perms, provinces: row.a.provinces };
}

/** فقط مدیران پنل (هر نقشی) */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  await requireAuth(req, res, async (err?: unknown) => {
    if (err) return next(err);
    try {
      const a = await loadAdmin(req.user!);
      if (!a) return next(forbidden('این بخش فقط برای کارشناسان بلوک است', 'NOT_ADMIN'));
      req.admin = a;
      db.update(admins).set({ lastSeenAt: new Date() }).where(eq(admins.id, a.id)).catch(() => {});
      next();
    } catch (e) {
      next(e);
    }
  });
}

/** سطح دسترسی لازم برای یک بخش پنل: ۱ مشاهده، ۲ ویرایش (بعد از requireAdmin) */
export function perm(module: AdminModule, level: 1 | 2 = 1) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const have = req.admin?.perms[module] ?? 0;
    if (have >= level) return next();
    next(forbidden(level === 2 ? 'برای این کار دسترسی ویرایش ندارید' : 'به این بخش دسترسی ندارید', 'NO_PERMISSION'));
  };
}
