import { Router } from 'express';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { notifications } from '../../db/schema';
import { ah, pageQuery, parse, uuidParam } from '../../lib/http';
import { requireAuth } from '../../middlewares/auth';

const r = Router();
r.use(requireAuth);

r.get(
  '/',
  ah(async (req, res) => {
    const q = parse(pageQuery, req.query);
    const [items, [{ unread }]] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, req.user!.id))
        .orderBy(desc(notifications.createdAt))
        .limit(q.limit)
        .offset((q.page - 1) * q.limit),
      db
        .select({ unread: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt))),
    ]);
    res.json({ items, unread, page: q.page });
  }),
);

r.post(
  '/read-all',
  ah(async (req, res) => {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt)));
    res.json({ ok: true });
  }),
);

r.post(
  '/:id/read',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id)));
    res.json({ ok: true });
  }),
);

export default r;
