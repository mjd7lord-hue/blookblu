import { Router } from 'express';
import { z } from 'zod';
import { and, count, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { dailyReports, files, profiles } from '../../db/schema';
import { ah, parse, uuidParam } from '../../lib/http';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { emitTo } from '../../lib/events';
import { toLatinDigits } from '../../lib/text';
import { requireAuth } from '../../middlewares/auth';
import { fileUrl, purgeFiles, saveUpload } from '../files/files.service';
import { optionalPhotos, singleFile, uploadLimiter } from '../files/upload';
import { notify } from '../notifications/notify';
import { faDate } from '../contracts/contract.service';
import { assertActive, projectFor } from './access';

type Daily = typeof dailyReports.$inferSelect;
type View = Awaited<ReturnType<typeof projectFor>>;

const MAX_PROJECT_FILES = 50;
const todayTehran = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
const empty = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const intInput = z.preprocess((v) => (typeof v === 'string' ? Number(toLatinDigits(v).trim()) : v), z.number().int().min(0).max(1000));

/* ================= گزارش روزانهٔ کارگاه ================= */

function shapeDaily(d: Daily, v: View, author: { code: string; name: string } | undefined) {
  const mine = d.authorProfileId === v.me.id;
  return {
    id: d.id,
    date: d.reportDate,
    dateFa: faDate(new Date(`${d.reportDate}T12:00:00Z`)),
    weather: d.weather,
    crew: d.crew,
    done: d.done,
    issues: d.issues,
    photos: d.photoFileIds.map((id) => fileUrl({ id, isPublic: false })),
    author: author ? { ...author, side: d.authorProfileId === v.client.id ? 'client' : 'provider', mine } : null,
    can: { edit: mine && v.p.status === 'active', delete: mine },
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export const projectDailyRouter = Router({ mergeParams: true });
projectDailyRouter.use(requireAuth);

projectDailyRouter.get(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const q = parse(
      z.object({ before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limit: z.coerce.number().int().min(1).max(60).default(20) }),
      req.query,
    );
    const v = await projectFor(req.user!.id, id);
    const rows = await db
      .select({ d: dailyReports, code: profiles.code, name: profiles.displayName })
      .from(dailyReports)
      .innerJoin(profiles, eq(profiles.id, dailyReports.authorProfileId))
      .where(and(eq(dailyReports.projectId, id), q.before ? lt(dailyReports.reportDate, q.before) : undefined))
      .orderBy(desc(dailyReports.reportDate), desc(dailyReports.createdAt))
      .limit(q.limit);
    const [{ days, crewDays }] = await db
      .select({ days: sql<number>`count(distinct ${dailyReports.reportDate})::int`, crewDays: sql<number>`coalesce(sum(${dailyReports.crew}), 0)::int` })
      .from(dailyReports)
      .where(eq(dailyReports.projectId, id));
    res.json({
      items: rows.map((r) => shapeDaily(r.d, v, { code: r.code, name: r.name })),
      stats: { days, crewDays },
      hasMore: rows.length === q.limit,
    });
  }),
);

/** multipart (با عکس در «photos») یا JSON: date?، weather?، crew، done، issues? */
projectDailyRouter.post(
  '/',
  uploadLimiter,
  optionalPhotos,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        date: z.preprocess(empty, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ به شکل 2026-09-28').optional()),
        weather: z.preprocess(empty, z.string().trim().max(30).optional()),
        crew: intInput.default(0),
        done: z.string({ required_error: 'کارهای انجام‌شده را بنویس' }).trim().min(3, 'کارهای انجام‌شده را بنویس').max(3000),
        issues: z.preprocess(empty, z.string().trim().max(2000).optional()),
      }),
      req.body,
    );
    const v = await projectFor(req.user!.id, id);
    assertActive(v.p);
    const date = body.date ?? todayTehran();
    if (date > todayTehran()) throw conflict('گزارش روزهای آینده ثبت نمی‌شود', 'FUTURE_DATE');

    const [dup] = await db
      .select({ id: dailyReports.id })
      .from(dailyReports)
      .where(and(eq(dailyReports.projectId, id), eq(dailyReports.authorProfileId, v.me.id), eq(dailyReports.reportDate, date)))
      .limit(1);
    if (dup) throw conflict('برای این روز گزارش ثبت کرده‌ای؛ همان را ویرایش کن', 'DAILY_EXISTS', { id: dup.id });

    const uploads = (req.files as Express.Multer.File[] | undefined) ?? [];
    const saved: string[] = [];
    try {
      for (const f of uploads) saved.push((await saveUpload(req.user!.id, 'project', f, { projectId: id })).id);
      const [d] = await db
        .insert(dailyReports)
        .values({
          projectId: id,
          authorProfileId: v.me.id,
          reportDate: date,
          weather: body.weather ?? null,
          crew: body.crew,
          done: body.done,
          issues: body.issues ?? null,
          photoFileIds: saved,
        })
        .returning();
      await notify(v.other.userId, {
        type: 'req',
        title: 'گزارش روزانهٔ کارگاه',
        body: `${v.p.title}: ${body.done.slice(0, 80)}`,
        link: { screen: 'pdet', id },
      });
      emitTo([v.client.userId, v.provider.userId], { type: 'daily', data: { projectId: id, dailyId: d.id } });
      res.status(201).json({ report: shapeDaily(d, v, { code: v.me.code, name: v.me.name }) });
    } catch (e) {
      await purgeFiles(saved);
      throw e;
    }
  }),
);

export const dailyRouter = Router();
dailyRouter.use(requireAuth);

async function ownDaily(userId: string, id: string) {
  const [d] = await db.select().from(dailyReports).where(eq(dailyReports.id, id)).limit(1);
  if (!d) throw notFound('گزارش پیدا نشد');
  const v = await projectFor(userId, d.projectId);
  if (d.authorProfileId !== v.me.id) throw forbidden('فقط گزارش خودت را می‌توانی تغییر دهی', 'NOT_OWNER');
  return { d, v };
}

dailyRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        weather: z.string().trim().max(30).nullable().optional(),
        crew: intInput.optional(),
        done: z.string().trim().min(3).max(3000).optional(),
        issues: z.string().trim().max(2000).nullable().optional(),
      }),
      req.body,
    );
    const { v } = await ownDaily(req.user!.id, id);
    assertActive(v.p);
    const [d] = await db
      .update(dailyReports)
      .set({ ...body, weather: body.weather === '' ? null : body.weather, issues: body.issues === '' ? null : body.issues, updatedAt: new Date() })
      .where(eq(dailyReports.id, id))
      .returning();
    res.json({ report: shapeDaily(d, v, { code: v.me.code, name: v.me.name }) });
  }),
);

dailyRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { d } = await ownDaily(req.user!.id, id);
    await db.delete(dailyReports).where(eq(dailyReports.id, id));
    await purgeFiles(d.photoFileIds);
    res.json({ ok: true });
  }),
);

/* ================= فایل‌های پروژه (نقشه، صورت‌جلسه، ...) ================= */

// عکس‌های گزارش روزانه جدا نمایش داده می‌شوند
const notDailyPhoto = sql`not exists (select 1 from ${dailyReports} d where ${files.id} = any(d.photo_file_ids))`;

export const projectFilesRouter = Router({ mergeParams: true });
projectFilesRouter.use(requireAuth);

projectFilesRouter.get(
  '/',
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const v = await projectFor(req.user!.id, id);
    const rows = await db
      .select()
      .from(files)
      .where(and(eq(files.projectId, id), eq(files.purpose, 'project'), notDailyPhoto))
      .orderBy(desc(files.createdAt));
    res.json({
      items: rows.map((f) => ({
        id: f.id,
        name: f.originalName,
        mime: f.mime,
        size: f.size,
        url: fileUrl(f),
        mine: f.ownerUserId === v.me.userId,
        createdAt: f.createdAt,
      })),
      max: MAX_PROJECT_FILES,
    });
  }),
);

projectFilesRouter.post(
  '/',
  uploadLimiter,
  singleFile,
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const v = await projectFor(req.user!.id, id);
    if (v.p.status === 'cancelled') throw conflict('این پروژه لغو شده است', 'PROJECT_CLOSED');
    const [{ n }] = await db.select({ n: count() }).from(files).where(and(eq(files.projectId, id), eq(files.purpose, 'project')));
    if (n >= MAX_PROJECT_FILES) throw conflict(`حداکثر ${MAX_PROJECT_FILES} فایل برای هر پروژه`, 'PROJECT_FILES_FULL');
    const f = await saveUpload(req.user!.id, 'project', req.file!, { projectId: id });
    await notify(v.other.userId, { type: 'req', title: 'فایل تازه در پروژه', body: `${v.me.name}: ${f.originalName ?? 'فایل'}`, link: { screen: 'pdet', id } });
    res.status(201).json({ file: { id: f.id, name: f.originalName, mime: f.mime, size: f.size, url: fileUrl(f), mine: true, createdAt: f.createdAt } });
  }),
);

projectFilesRouter.delete(
  '/:fileId',
  ah(async (req, res) => {
    const { id, fileId } = parse(z.object({ id: z.string().uuid(), fileId: z.string().uuid() }), req.params);
    await projectFor(req.user!.id, id);
    const [f] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.projectId, id), eq(files.purpose, 'project'), notDailyPhoto))
      .limit(1);
    if (!f) throw notFound('فایل پیدا نشد');
    if (f.ownerUserId !== req.user!.id) throw forbidden('فقط فایلی را که خودت گذاشته‌ای می‌توانی حذف کنی', 'NOT_OWNER');
    await purgeFiles([f.id]);
    res.json({ ok: true });
  }),
);
