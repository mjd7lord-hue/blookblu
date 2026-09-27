import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { adResponses, ads, guarantees, profiles, reviews, users } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { normalizePhone, maskPhone } from '../../lib/text';
import { requireAuth, requireProfile } from '../../middlewares/auth';
import { notify } from '../notifications/notify';

/* ---------- نظرها: فقط بعد از همکاری پذیرفته‌شده ---------- */
export const reviewsRouter = Router();

reviewsRouter.post(
  '/',
  requireAuth,
  ah(async (req, res) => {
    const body = parse(
      z.object({
        responseId: z.string().uuid(),
        rating: z.number().int().min(1).max(5),
        text: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    const [row] = await db
      .select({ r: adResponses, adProfileId: ads.profileId, adTitle: ads.title })
      .from(adResponses)
      .innerJoin(ads, eq(ads.id, adResponses.adId))
      .where(eq(adResponses.id, body.responseId))
      .limit(1);
    if (!row) throw notFound('همکاری پیدا نشد');
    if (row.r.status !== 'accepted') throw badRequest('فقط بعد از همکاری پذیرفته‌شده می‌توان نظر داد', 'NOT_ACCEPTED');

    const both = await db
      .select({ id: profiles.id, userId: profiles.userId, name: profiles.displayName })
      .from(profiles)
      .where(sql`${profiles.id} in (${row.adProfileId}, ${row.r.profileId})`);
    const adP = both.find((p) => p.id === row.adProfileId)!;
    const respP = both.find((p) => p.id === row.r.profileId)!;
    const me = req.user!.id;
    const [from, to] = adP.userId === me ? [adP, respP] : respP.userId === me ? [respP, adP] : [null, null];
    if (!from || !to) throw forbidden('شما طرف این همکاری نیستید');

    const review = await db.transaction(async (tx) => {
      const [rv] = await tx
        .insert(reviews)
        .values({ responseId: body.responseId, fromProfileId: from.id, toProfileId: to.id, rating: body.rating, text: body.text || null })
        .onConflictDoNothing()
        .returning();
      if (!rv) throw conflict('برای این همکاری قبلاً نظر داده‌اید', 'ALREADY_REVIEWED');
      // میانگین و تعداد نظر + یک پروژهٔ انجام‌شده
      await tx
        .update(profiles)
        .set({
          ratingAvg: sql`(${profiles.ratingAvg} * ${profiles.ratingCount} + ${body.rating}) / (${profiles.ratingCount} + 1)`,
          ratingCount: sql`${profiles.ratingCount} + 1`,
          doneCount: sql`${profiles.doneCount} + 1`,
        })
        .where(eq(profiles.id, to.id));
      return rv;
    });

    await notify(to.userId, {
      type: 'star',
      title: `${from.name} به شما ${body.rating} ستاره داد`,
      body: body.text?.slice(0, 120),
      link: { screen: 'trust' },
    });
    res.status(201).json({ review });
  }),
);

/* ---------- قیم (ضامن) ---------- */
export const guaranteesRouter = Router();

guaranteesRouter.get(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const mine = await db
      .select({
        id: guarantees.id,
        name: guarantees.guarantorName,
        relation: guarantees.relation,
        phone: guarantees.guarantorPhone,
        status: guarantees.status,
        createdAt: guarantees.createdAt,
      })
      .from(guarantees)
      .where(eq(guarantees.profileId, req.profile!.id))
      .orderBy(desc(guarantees.createdAt));
    // درخواست‌هایی که دیگران از من برای ضمانت کرده‌اند
    const incoming = await db
      .select({
        id: guarantees.id,
        relation: guarantees.relation,
        status: guarantees.status,
        createdAt: guarantees.createdAt,
        from: { code: profiles.code, name: profiles.displayName, role: profiles.role, title: profiles.title },
      })
      .from(guarantees)
      .innerJoin(profiles, eq(profiles.id, guarantees.profileId))
      .where(eq(guarantees.guarantorPhone, req.user!.phone))
      .orderBy(desc(guarantees.createdAt));
    res.json({ mine: mine.map((g) => ({ ...g, phone: maskPhone(g.phone) })), incoming });
  }),
);

guaranteesRouter.post(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        relation: z.string().trim().max(120).default('آشنا'),
        phone: z.string(),
      }),
      req.body,
    );
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('شمارهٔ موبایل قیم معتبر نیست', 'BAD_PHONE');
    if (phone === req.user!.phone) throw badRequest('خودتان نمی‌توانید قیم خودتان باشید', 'SELF_GUARANTEE');
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(guarantees)
      .where(eq(guarantees.profileId, req.profile!.id));
    if (n >= 5) throw badRequest('حداکثر ۵ قیم می‌توانید داشته باشید', 'GUARANTEE_LIMIT');

    const [gu] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).limit(1);
    const [g] = await db
      .insert(guarantees)
      .values({
        profileId: req.profile!.id,
        guarantorPhone: phone,
        guarantorUserId: gu?.id ?? null,
        guarantorName: body.name,
        relation: body.relation || 'آشنا',
      })
      .onConflictDoNothing()
      .returning();
    if (!g) throw conflict('از این شماره قبلاً درخواست ضمانت کرده‌اید', 'GUARANTEE_EXISTS');
    if (gu) {
      await notify(gu.id, {
        type: 'id',
        title: 'درخواست قیم شدن',
        body: `${req.profile!.displayName} از شما خواسته اعتبارش را تأیید کنید`,
        link: { screen: 'guar' },
      });
    }
    // TODO(فاز بعد): اگر قیم هنوز در بلوک نیست، پیامک دعوت فرستاده شود
    res.status(201).json({ guarantee: { ...g, guarantorPhone: maskPhone(g.guarantorPhone) }, invited: !gu });
  }),
);

guaranteesRouter.patch(
  '/:id',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['accepted', 'rejected']) }), req.body);
    const [g] = await db.select().from(guarantees).where(eq(guarantees.id, id)).limit(1);
    if (!g || g.guarantorPhone !== req.user!.phone) throw notFound('درخواست پیدا نشد');
    if (g.status !== 'pending') throw conflict('به این درخواست قبلاً جواب داده‌اید', 'ALREADY_ANSWERED');
    const [ng] = await db
      .update(guarantees)
      .set({ status, respondedAt: new Date(), guarantorUserId: req.user!.id })
      .where(eq(guarantees.id, id))
      .returning();
    const [owner] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.id, g.profileId)).limit(1);
    if (owner && status === 'accepted') {
      await notify(owner.userId, { type: 'id', title: `${g.guarantorName} قیم شما شد`, link: { screen: 'guar' } });
    }
    res.json({ guarantee: { ...ng, guarantorPhone: maskPhone(ng.guarantorPhone) } });
  }),
);

guaranteesRouter.delete(
  '/:id',
  requireProfile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const del = await db
      .delete(guarantees)
      .where(and(eq(guarantees.id, id), eq(guarantees.profileId, req.profile!.id)))
      .returning({ id: guarantees.id });
    if (!del.length) throw notFound('پیدا نشد');
    res.json({ ok: true });
  }),
);
