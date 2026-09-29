import { Router } from 'express';
import { z } from 'zod';
import { ah, moneyInput, parse, uuidParam } from '../../lib/http';
import { requireAuth, requireProfile } from '../../middlewares/auth';
import { shapeMessage } from './chat.service';
import * as svc from './chat.service';
import { singleFile, uploadLimiter } from '../files/upload';

const r = Router();

/* ---------- /api/conversations ---------- */

r.get(
  '/',
  requireAuth,
  ah(async (req, res) => {
    const q = parse(
      z.object({ filter: z.enum(['all', 'unread', 'archived', 'project']).default('all'), q: z.string().max(60).optional() }),
      req.query,
    );
    res.json(await svc.listConversations(req.user!.id, q));
  }),
);

/** شروع گفت‌وگو با یک پروفایل (از پروفایل یا از آگهی) — با نقش فعال من */
r.post(
  '/',
  requireProfile,
  ah(async (req, res) => {
    const body = parse(
      z.object({ profileCode: z.string().regex(/^B-[A-Z0-9]{4}$/i, 'کد نامعتبر'), adId: z.string().uuid().optional() }),
      req.body,
    );
    const conv = await svc.startConversation(req.profile!, body);
    res.status(201).json({ conversation: { id: conv.id, kind: conv.kind, title: conv.title } });
  }),
);

r.get(
  '/:id/messages',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const q = parse(
      z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      req.query,
    );
    res.json(await svc.listMessages(req.user!.id, id, q));
  }),
);

const locPayload = z.object({
  place: z.string().max(60),
  label: z.string().max(160).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

r.post(
  '/:id/messages',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('text'), body: z.string().trim().min(1, 'پیام خالی است').max(4000) }),
        z.object({ kind: z.literal('loc'), payload: locPayload }),
        z.object({ kind: z.literal('phone') }),
      ]),
      req.body,
    );
    const { me } = await svc.membership(req.user!.id, id);
    const msg = await svc.sendMessage(req.user!.id, id, body);
    res.status(201).json({ message: shapeMessage(msg, me.id) });
  }),
);

/** پیوست: عکس (JPG/PNG/WebP)، PDF یا پیام صوتی (WebM/Ogg/M4A، مدت در «duration» ثانیه) در فیلد «file»، توضیح اختیاری در «caption» — multipart/form-data */
r.post(
  '/:id/attachments',
  requireAuth,
  uploadLimiter,
  singleFile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { caption, duration } = parse(z.object({ caption: z.string().trim().max(1000).optional(), duration: z.coerce.number().int().min(0).max(600).optional() }), req.body);
    const { me } = await svc.membership(req.user!.id, id);
    const msg = await svc.sendAttachment(req.user!.id, id, req.file!, caption, duration);
    res.status(201).json({ message: shapeMessage(msg, me.id) });
  }),
);


/** پیشنهاد توافق (کار، مقدار، دستمزد، شروع، مدت، مراحل پرداخت) */
r.post(
  '/:id/deals',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const d = parse(
      z.object({
        job: z.string().trim().min(2).max(160),
        qty: z.string().max(80).nullish(),
        price: z.string().trim().min(1).max(120),
        amount: moneyInput.optional(),
        start: z.string().trim().min(2).max(80),
        durationDays: z.number().int().min(1).max(1000),
        plan: z
          .array(z.object({ title: z.string().trim().min(2).max(60), pct: z.number().int().min(1).max(100) }))
          .min(1)
          .max(8)
          .default([{ title: 'پس از پایان کار', pct: 100 }]),
        retentionPct: z.number().int().min(0).max(20).default(0),
      }),
      req.body,
    );
    const { me } = await svc.membership(req.user!.id, id);
    const msg = await svc.proposeDeal(req.user!.id, id, d);
    res.status(201).json({ message: shapeMessage(msg, me.id) });
  }),
);

/** پیشنهاد روز شروع */
r.post(
  '/:id/days',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const d = parse(z.object({ date: z.string().trim().min(2).max(40), hour: z.string().trim().min(1).max(20) }), req.body);
    const { me } = await svc.membership(req.user!.id, id);
    const msg = await svc.proposeDay(req.user!.id, id, d);
    res.status(201).json({ message: shapeMessage(msg, me.id) });
  }),
);

r.patch(
  '/:id',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const set = parse(z.object({ muted: z.boolean(), archived: z.boolean(), pinned: z.boolean() }).partial(), req.body);
    await svc.updateMembership(req.user!.id, id, set);
    res.json({ ok: true, ...set });
  }),
);

r.delete(
  '/:id',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.hideConversation(req.user!.id, id);
    res.json({ ok: true });
  }),
);

export default r;

/* ---------- /api/messages ---------- */
export const messagesRouter = Router();

messagesRouter.post(
  '/:id/answer',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['accepted', 'rejected']) }), req.body);
    res.json(await svc.answerProposal(req.user!.id, id, status));
  }),
);

messagesRouter.delete(
  '/:id',
  requireAuth,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.deleteMessage(req.user!.id, id);
    res.json({ ok: true });
  }),
);
