/**
 * /api/invites — «درخواست همکاری» مستقیم: دعوت یک یا چند نفر به کار خودت (از پروفایل یا از «نیروی این پروژه» در برآورد).
 * هر درخواست یک گفت‌وگو با گیرنده باز می‌کند؛ اگر قبول کند، در همان چت توافق و قرارداد ثبت می‌شود.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../../db';
import { ads, invites, profiles, users } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { normalizeFa } from '../../lib/text';
import { requireProfile } from '../../middlewares/auth';
import { notify } from '../notifications/notify';
import { ensureConversation, postMessage } from '../chat/chat.service';
import { blockedIds } from '../profiles/profiles.service';
import { authorCols, shapeAuthor } from '../ads/ads.service';

const r = Router();
r.use(requireProfile);

const MAX_BULK = 30;

const body = z
  .object({
    profileCode: z.string().regex(/^B-[A-Z0-9]{4}$/i, 'کد کاربری نامعتبر').optional(),
    profileCodes: z.array(z.string().regex(/^B-[A-Z0-9]{4}$/i, 'کد کاربری نامعتبر')).min(1).max(MAX_BULK).optional(),
    adId: z.string().uuid().nullish(),
    title: z.string().trim().min(3, 'عنوان کار را بنویس').max(160),
    startWhen: z.string().trim().max(60).nullish(),
    offer: z.string().trim().max(120).nullish(),
    message: z.string().trim().max(1000).nullish(),
  })
  .refine((b) => b.profileCode || b.profileCodes, { message: 'گیرنده را انتخاب کن' });

r.post(
  '/',
  ah(async (req, res) => {
    const b = parse(body, req.body);
    const me = req.profile!;
    const codes = [...new Set([...(b.profileCodes ?? []), ...(b.profileCode ? [b.profileCode] : [])].map((c) => c.toUpperCase()))];
    if (b.adId) {
      const [ad] = await db.select({ profileId: ads.profileId, status: ads.status }).from(ads).where(eq(ads.id, b.adId)).limit(1);
      if (!ad || ad.status === 'removed') throw notFound('آگهی پیدا نشد');
      if (ad.profileId !== me.id) throw forbidden('این آگهی مال شما نیست');
    }
    const targets = await db
      .select({ p: profiles })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(and(inArray(profiles.code, codes), eq(users.status, 'active')));
    const blocked = await blockedIds(req.user!.id);
    const title = normalizeFa(b.title);
    const items: { id: string; conversationId: string; code: string }[] = [];
    const skipped: { code: string; reason: string }[] = [];
    for (const code of codes) {
      const t = targets.find((x) => x.p.code === code)?.p;
      if (!t) { skipped.push({ code, reason: 'NOT_FOUND' }); continue; }
      if (t.userId === req.user!.id) { skipped.push({ code, reason: 'SELF' }); continue; }
      if (blocked.includes(t.userId)) { skipped.push({ code, reason: 'BLOCKED' }); continue; }
      const [dup] = await db
        .select({ id: invites.id })
        .from(invites)
        .where(and(eq(invites.fromProfileId, me.id), eq(invites.toProfileId, t.id), eq(invites.status, 'pending'), eq(invites.title, title)))
        .limit(1);
      if (dup) { skipped.push({ code, reason: 'DUPLICATE' }); continue; }
      const { conv, created } = await ensureConversation(me, t, { adId: b.adId ?? null, title });
      if (created) await postMessage(conv, null, { kind: 'sys', body: `این گفت‌وگو از درخواست همکاری «${title}» شروع شد.` });
      const lines = [`درخواست همکاری: ${title}`, b.startWhen ? `شروع: ${b.startWhen}` : '', b.offer ? `مبلغ پیشنهادی: ${b.offer}` : '', b.message ?? ''].filter(Boolean);
      await postMessage(conv, me, { kind: 'text', body: lines.join('\n') });
      const [inv] = await db
        .insert(invites)
        .values({ fromProfileId: me.id, toProfileId: t.id, adId: b.adId ?? null, conversationId: conv.id, title, startWhen: b.startWhen || null, offer: b.offer || null, message: b.message || null })
        .returning();
      await notify(t.userId, { type: 'req', title: 'درخواست همکاری تازه', body: `${me.displayName}: «${title}»`, link: { screen: 'req' } });
      items.push({ id: inv.id, conversationId: conv.id, code });
    }
    if (!items.length) {
      const why = skipped[0]?.reason;
      if (why === 'DUPLICATE') throw conflict('این درخواست را قبلاً فرستاده‌ای و هنوز منتظر جواب است', 'INVITE_DUPLICATE');
      if (why === 'SELF') throw badRequest('به خودت نمی‌توانی درخواست بدهی', 'SELF_INVITE');
      throw notFound('گیرنده‌ای پیدا نشد');
    }
    res.status(201).json({ items, skipped });
  }),
);

/** دریافتی (in) یا ارسالی (out) */
r.get(
  '/',
  ah(async (req, res) => {
    const { dir } = parse(z.object({ dir: z.enum(['in', 'out']).default('in') }), req.query);
    const mine = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, req.user!.id));
    const other = dir === 'in' ? invites.fromProfileId : invites.toProfileId;
    const rows = await db
      .select({ i: invites, who: { ...authorCols, kyc: users.kycStatus }, ad: { id: ads.id, title: ads.title, type: ads.type } })
      .from(invites)
      .innerJoin(profiles, eq(profiles.id, other))
      .innerJoin(users, eq(users.id, profiles.userId))
      .leftJoin(ads, eq(ads.id, invites.adId))
      .where(and(inArray(dir === 'in' ? invites.toProfileId : invites.fromProfileId, mine), ne(invites.status, 'withdrawn')))
      .orderBy(desc(invites.createdAt))
      .limit(200);
    res.json({
      items: rows.map(({ i, who, ad }) => ({
        id: i.id,
        status: i.status,
        title: i.title,
        startWhen: i.startWhen,
        offer: i.offer,
        message: i.message,
        conversationId: i.conversationId,
        createdAt: i.createdAt,
        ad: ad && ad.id ? ad : null,
        [dir === 'in' ? 'from' : 'to']: shapeAuthor(who),
      })),
    });
  }),
);

async function inviteFor(userId: string, id: string, side: 'to' | 'from') {
  const [row] = await db
    .select({ i: invites, owner: profiles.userId, name: profiles.displayName })
    .from(invites)
    .innerJoin(profiles, eq(profiles.id, side === 'to' ? invites.toProfileId : invites.fromProfileId))
    .where(eq(invites.id, id))
    .limit(1);
  if (!row || row.owner !== userId) throw notFound('درخواست پیدا نشد');
  if (row.i.status !== 'pending') throw conflict('به این درخواست قبلاً جواب داده شده', 'INVITE_CLOSED');
  return row;
}

r.patch(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['accepted', 'rejected']) }), req.body);
    const row = await inviteFor(req.user!.id, id, 'to');
    const [inv] = await db.update(invites).set({ status, respondedAt: new Date() }).where(eq(invites.id, id)).returning();
    const [from] = await db.select().from(profiles).where(eq(profiles.id, row.i.fromProfileId)).limit(1);
    if (row.i.conversationId) {
      const [to] = await db.select().from(profiles).where(eq(profiles.id, row.i.toProfileId)).limit(1);
      const { conv } = await ensureConversation(to, from, { adId: row.i.adId, title: row.i.title });
      await postMessage(conv, null, {
        kind: 'sys',
        body: status === 'accepted' ? `${row.name} درخواست همکاری را قبول کرد؛ شرایط را نهایی کنید و قرارداد را ثبت کنید.` : `${row.name} درخواست همکاری را رد کرد.`,
      });
    }
    if (from) {
      await notify(from.userId, {
        type: 'req',
        title: status === 'accepted' ? 'درخواست همکاری قبول شد' : 'درخواست همکاری رد شد',
        body: `${row.name}: «${row.i.title}»`,
        link: row.i.conversationId ? { screen: 'chat', id: row.i.conversationId } : { screen: 'req' },
      });
    }
    res.json({ invite: inv });
  }),
);

r.post(
  '/:id/withdraw',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await inviteFor(req.user!.id, id, 'from');
    await db.update(invites).set({ status: 'withdrawn', respondedAt: new Date() }).where(eq(invites.id, id));
    res.json({ ok: true });
  }),
);

export default r;
