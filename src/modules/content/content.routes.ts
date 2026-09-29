/**
 * /api/app — محتوایی که مدیر از پنل عوض می‌کند و اپ می‌خواند:
 * قابلیت‌های روشن/خاموش، نسخه، قوانین، استوری‌ها، دوره‌های آکادمی (با پیشرفت کاربر)، ضرایب برآورد و داوری،
 * انواع بازدید مهندس — و باز کردن گفت‌وگوی «پشتیبانی بلوک».
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { contentStats, courseProgress, ROLES } from '../../db/schema';
import { ah, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { cfg } from '../../lib/appConfig';
import { optionalAuth, requireAuth, requireProfile } from '../../middlewares/auth';
import { supportConversation } from '../chat/chat.service';

const r = Router();

export function publicConfig() {
  const s = cfg('settings');
  const cat = cfg('catalog');
  return {
    flags: s.flags,
    ver: s.ver,
    display: s.display,
    legal: cfg('legal'),
    stories: s.flags.stories === false ? [] : cfg('stories').filter((x) => x.on),
    coefs: cfg('coefs'),
    visitTypes: cfg('visitTypes'),
    whatsNew: cfg('whatsNew').on ? cfg('whatsNew') : null,
    roles: Object.fromEntries(ROLES.map((k) => [k, { on: cat.roles?.[k]?.on !== false }])),
  };
}

r.get('/config', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(publicConfig());
});

async function bump(kind: 'story' | 'course', itemId: string) {
  await db
    .insert(contentStats)
    .values({ kind, itemId, views: 1 })
    .onConflictDoUpdate({ target: [contentStats.kind, contentStats.itemId], set: { views: sql`${contentStats.views} + 1` } });
}

const idParam = z.object({ id: z.string().min(1).max(40) });

r.post(
  '/stories/:id/view',
  ah(async (req, res) => {
    const { id } = parse(idParam, req.params);
    if (!cfg('stories').some((s) => s.id === id)) throw notFound('استوری پیدا نشد');
    await bump('story', id);
    res.json({ ok: true });
  }),
);

/* ---------- آکادمی ---------- */

r.get(
  '/courses',
  optionalAuth,
  ah(async (req, res) => {
    const list = cfg('settings').flags.academy === false ? [] : cfg('courses').filter((c) => c.st === 'published');
    const prog = req.user ? await db.select().from(courseProgress).where(eq(courseProgress.userId, req.user.id)) : [];
    res.json({
      items: list.map((c) => ({ id: c.id, title: c.t, category: c.c, lessons: c.l, minutes: c.m, roles: c.roles, done: prog.find((p) => p.courseId === c.id)?.done ?? 0 })),
      badges: prog.filter((p) => p.completedAt).length,
    });
  }),
);

r.put(
  '/courses/:id/progress',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { done } = parse(z.object({ done: z.number().int().min(0).max(100) }), req.body);
    const c = cfg('courses').find((x) => x.id === id && x.st === 'published');
    if (!c) throw notFound('دوره پیدا نشد');
    if (done > c.l) throw badRequest('تعداد درس بیشتر از دوره است', 'BAD_PROGRESS');
    const [cur] = await db
      .select()
      .from(courseProgress)
      .where(and(eq(courseProgress.userId, req.user!.id), eq(courseProgress.courseId, id)))
      .limit(1);
    if (!cur) await bump('course', id);
    const v = Math.max(cur?.done ?? 0, done); // پیشرفت عقب نمی‌رود
    const completedAt = v >= c.l ? (cur?.completedAt ?? new Date()) : null;
    await db
      .insert(courseProgress)
      .values({ userId: req.user!.id, courseId: id, done: v, completedAt })
      .onConflictDoUpdate({ target: [courseProgress.userId, courseProgress.courseId], set: { done: v, completedAt, updatedAt: new Date() } });
    res.json({ done: v, completed: !!completedAt });
  }),
);

/* ---------- پشتیبانی ---------- */

r.post(
  '/support',
  requireProfile,
  ah(async (req, res) => {
    const conv = await supportConversation(req.profile!);
    res.json({ conversation: { id: conv.id, kind: conv.kind, title: conv.title } });
  }),
);

export default r;
