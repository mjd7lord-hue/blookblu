import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { ads, profiles, savedItems } from '../../db/schema';
import { ah, parse } from '../../lib/http';
import { notFound } from '../../lib/errors';
import { requireAuth } from '../../middlewares/auth';

const r = Router();
r.use(requireAuth);

const target = z.object({ kind: z.enum(['ad', 'profile']), id: z.string().uuid() });

/** ذخیره‌ها: آگهی‌ها و پروفایل‌ها */
r.get(
  '/',
  ah(async (req, res) => {
    const rows = await db
      .select()
      .from(savedItems)
      .where(eq(savedItems.userId, req.user!.id))
      .orderBy(desc(savedItems.createdAt));
    const adIds = rows.filter((x) => x.kind === 'ad').map((x) => x.targetId);
    const pIds = rows.filter((x) => x.kind === 'profile').map((x) => x.targetId);
    const [adRows, pRows] = await Promise.all([
      adIds.length
        ? db
            .select({ id: ads.id, title: ads.title, type: ads.type, city: ads.city, status: ads.status, createdAt: ads.createdAt })
            .from(ads)
            .where(inArray(ads.id, adIds))
        : [],
      pIds.length
        ? db
            .select({
              id: profiles.id,
              code: profiles.code,
              name: profiles.displayName,
              role: profiles.role,
              title: profiles.title,
              city: profiles.city,
              rating: profiles.ratingAvg,
              verified: profiles.verified,
            })
            .from(profiles)
            .where(and(inArray(profiles.id, pIds), eq(profiles.isPublic, true)))
        : [],
    ]);
    res.json({
      ads: adIds.map((id) => adRows.find((a) => a.id === id)).filter((a) => a && a.status !== 'removed'),
      profiles: pIds.map((id) => pRows.find((p) => p.id === id)).filter(Boolean),
    });
  }),
);

r.put(
  '/:kind/:id',
  ah(async (req, res) => {
    const { kind, id } = parse(target, req.params);
    const table = kind === 'ad' ? ads : profiles;
    const [x] = await db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
    if (!x) throw notFound();
    await db.insert(savedItems).values({ userId: req.user!.id, kind, targetId: id }).onConflictDoNothing();
    res.json({ saved: true });
  }),
);

r.delete(
  '/:kind/:id',
  ah(async (req, res) => {
    const { kind, id } = parse(target, req.params);
    await db
      .delete(savedItems)
      .where(and(eq(savedItems.userId, req.user!.id), eq(savedItems.kind, kind), eq(savedItems.targetId, id)));
    res.json({ saved: false });
  }),
);

export default r;
