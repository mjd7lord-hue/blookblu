import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { ads, blocks, profiles, reports } from '../../db/schema';
import { ah, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { requireAuth } from '../../middlewares/auth';

export const REPORT_REASONS = ['کلاهبرداری یا درخواست پیش‌پرداخت', 'اطلاعات نادرست', 'رفتار نامناسب', 'آگهی تکراری یا اسپم', 'سایر'] as const;

const r = Router();
r.use(['/reports', '/blocks'], requireAuth);

const codeSchema = z.string().regex(/^B-[A-Z0-9]{4}$/i, 'کد نامعتبر').transform((s) => s.toUpperCase());

async function profileByCode(code: string) {
  const [p] = await db.select({ id: profiles.id, userId: profiles.userId }).from(profiles).where(eq(profiles.code, code)).limit(1);
  if (!p) throw notFound('کاربر پیدا نشد');
  return p;
}

r.post(
  '/reports',
  ah(async (req, res) => {
    const body = parse(
      z
        .object({
          profileCode: codeSchema.optional(),
          adId: z.string().uuid().optional(),
          reason: z.enum(REPORT_REASONS),
          details: z.string().trim().max(2000).optional(),
        })
        .refine((b) => b.profileCode || b.adId, { message: 'کاربر یا آگهی را مشخص کنید' }),
      req.body,
    );
    let targetProfileId: string | null = null;
    let targetAdId: string | null = null;
    if (body.profileCode) targetProfileId = (await profileByCode(body.profileCode)).id;
    if (body.adId) {
      const [a] = await db.select({ id: ads.id, profileId: ads.profileId }).from(ads).where(eq(ads.id, body.adId)).limit(1);
      if (!a) throw notFound('آگهی پیدا نشد');
      targetAdId = a.id;
      targetProfileId ??= a.profileId;
    }
    const [rep] = await db
      .insert(reports)
      .values({ reporterUserId: req.user!.id, targetProfileId, targetAdId, reason: body.reason, details: body.details })
      .returning({ id: reports.id, status: reports.status });
    res.status(201).json({ report: rep, message: 'گزارش ثبت شد؛ کارشناس بلوک بررسی می‌کند' });
  }),
);

r.get(
  '/blocks',
  ah(async (req, res) => {
    const rows = await db
      .selectDistinctOn([blocks.blockedUserId], {
        userId: blocks.blockedUserId,
        name: profiles.displayName,
        code: profiles.code,
        createdAt: blocks.createdAt,
      })
      .from(blocks)
      .leftJoin(profiles, eq(profiles.userId, blocks.blockedUserId))
      .where(eq(blocks.blockerUserId, req.user!.id))
      .orderBy(blocks.blockedUserId, desc(blocks.createdAt));
    res.json({ items: rows.map(({ userId, ...x }) => x) });
  }),
);

r.post(
  '/blocks',
  ah(async (req, res) => {
    const { profileCode } = parse(z.object({ profileCode: codeSchema }), req.body);
    const p = await profileByCode(profileCode);
    if (p.userId === req.user!.id) throw badRequest('خودتان را نمی‌توانید مسدود کنید');
    await db.insert(blocks).values({ blockerUserId: req.user!.id, blockedUserId: p.userId }).onConflictDoNothing();
    res.json({ blocked: true });
  }),
);

r.delete(
  '/blocks/:code',
  ah(async (req, res) => {
    const { code } = parse(z.object({ code: codeSchema }), req.params);
    const p = await profileByCode(code);
    await db.delete(blocks).where(and(eq(blocks.blockerUserId, req.user!.id), eq(blocks.blockedUserId, p.userId)));
    res.json({ blocked: false });
  }),
);

export default r;
