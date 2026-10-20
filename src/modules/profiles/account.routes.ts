import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { db } from '../../db';
import { profiles, refreshTokens, users } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { notFound } from '../../lib/errors';
import { sha256 } from '../../lib/crypto';
import { requireAuth } from '../../middlewares/auth';

/**
 * دور ۳۷ «همه‌چیز واقعی» — زیر /api/me:
 *   دستگاه‌های واردشده (نشست‌های باز) و خروج از آن‌ها؛ کسانی که با کد معرفی من ثبت‌نام کرده‌اند
 */
const r = Router();
r.use(requireAuth);

const active = (userId: string) =>
  and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date()));

/** نشست‌های باز؛ با refreshToken همین دستگاه، «این دستگاه» مشخص می‌شود */
r.post(
  '/sessions',
  ah(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().max(400).optional() }), req.body ?? {});
    const cur = refreshToken ? sha256(refreshToken) : null;
    const rows = await db
      .select({ id: refreshTokens.id, ua: refreshTokens.userAgent, at: refreshTokens.createdAt, hash: refreshTokens.tokenHash })
      .from(refreshTokens)
      .where(active(req.user!.id))
      .orderBy(desc(refreshTokens.createdAt))
      .limit(30);
    res.json({ items: rows.map(({ hash, ...x }) => ({ ...x, current: hash === cur })) });
  }),
);

r.delete(
  '/sessions/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const done = await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, id), eq(refreshTokens.userId, req.user!.id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    if (!done.length) throw notFound('این دستگاه پیدا نشد');
    res.json({ ok: true });
  }),
);

/** خروج از همهٔ دستگاه‌ها به‌جز همین یکی */
r.post(
  '/sessions/revoke-others',
  ah(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10).max(400) }), req.body);
    const done = await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(active(req.user!.id), ne(refreshTokens.tokenHash, sha256(refreshToken))))
      .returning({ id: refreshTokens.id });
    res.json({ revoked: done.length });
  }),
);

/** کسانی که با کد معرفی یکی از نقش‌های من ثبت‌نام کرده‌اند */
r.get(
  '/referrals',
  ah(async (req, res) => {
    const mine = (await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, req.user!.id))).map((p) => p.id);
    if (!mine.length) return res.json({ items: [] });
    const rows = await db
      .select({ code: profiles.code, name: profiles.displayName, role: profiles.role, city: profiles.city, doneCount: profiles.doneCount, joinedAt: profiles.createdAt })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(and(inArray(profiles.referredBy, mine), eq(users.status, 'active')))
      .orderBy(desc(profiles.createdAt))
      .limit(200);
    res.json({ items: rows });
  }),
);

export default r;
