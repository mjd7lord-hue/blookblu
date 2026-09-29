/**
 * پنل ادمین — بخش ب: گفت‌وگوها (نظارت، پنهان کردن پیام، قفل، پیام پشتیبانی، اخطار)،
 * تیکت‌های پشتیبانی، اعلان همگانی، تنظیمات و محتوا (app_config)، «+ مورد دیگر» کاربران،
 * تراکنش‌ها و تسویهٔ حل‌کننده‌ها، وضعیت سرویس و نشست‌های مدیران.
 * بخش‌های تصویر لحظه‌ای این فایل از /snapshot در panel.ts صدا زده می‌شوند.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  adResponses,
  admins,
  ads,
  arbiterPayouts,
  arbiters,
  arbitrationCases,
  broadcasts,
  contentStats,
  conversationMembers,
  conversations,
  courseProgress,
  disputes,
  messages,
  notifications,
  profileSkills,
  profiles,
  projectPayments,
  projects,
  refreshTokens,
  reports,
  ROLES,
  supportTickets,
  users,
  type AdminModule,
  type Role,
} from '../../db/schema';
import { ah, moneyInput, parse, uuidParam } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { CONFIG_KEYS, cfg, saveConfig, storedConfig, validateConfig, type ConfigKey } from '../../lib/appConfig';
import { emitTo } from '../../lib/events';
import { metrics } from '../../lib/metrics';
import { env } from '../../config/env';
import { perm, requireAdmin, type AdminCtx } from '../../middlewares/auth';
import { fileUrl } from '../files/files.service';
import { notify } from '../notifications/notify';
import { postMessage } from '../chat/chat.service';
import { allFields } from '../roles/forms';
import { adminLog } from './admin.service';

const r = Router();
r.use(requireAdmin);

const can = (a: AdminCtx, m: AdminModule, lvl = 1) => (a.perms[m] ?? 0) >= lvl;
const inList = (col: SQL | Parameters<typeof inArray>[0], list: string[]) => sql`${col} in (${sql.join(list.map((p) => sql`${p}`), sql`, `)})`;
/** کاربر در محدودهٔ استان مدیر است (یکی از پروفایل‌هایش) */
// ستون با نام کامل (مثل "support_tickets"."user_id")؛ drizzle در بعضی جاها نام جدول را نمی‌نویسد و زیرپرس‌وجو اشتباه وصل می‌شود
const userInScope = (a: AdminCtx, userCol: string) =>
  a.provinces.length ? sql`exists (select 1 from ${profiles} sp where sp.user_id = ${sql.raw(userCol)} and ${inList(sql`sp.province`, a.provinces)})` : undefined;
const ZERO = '00000000-0000-0000-0000-000000000000';

/* ================= گفت‌وگوها ================= */

async function conversationsSection(a: AdminCtx) {
  const scope = a.provinces.length
    ? sql`exists (select 1 from ${conversationMembers} cm join ${profiles} sp on sp.id = cm.profile_id where cm.conversation_id = "conversations"."id" and ${inList(sql`sp.province`, a.provinces)})`
    : undefined;
  const rows = await db
    .select({
      c: conversations,
      n: sql<number>`(select count(*) from ${messages} m where m.conversation_id = "conversations"."id" and m.kind <> 'sys')::int`,
      flags: sql<number>`(select count(*) from ${messages} m where m.conversation_id = "conversations"."id" and m.flagged and m.hidden_at is null)::int`,
      last: sql<string | null>`(select m.body from ${messages} m where m.conversation_id = "conversations"."id" and m.kind = 'text' order by m.created_at desc limit 1)`,
    })
    .from(conversations)
    .where(and(ne(conversations.kind, 'support'), scope))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(300);
  if (!rows.length) return [];
  const mem = await db
    .select({ conversationId: conversationMembers.conversationId, userId: conversationMembers.userId, profileId: profiles.id, code: profiles.code, name: profiles.displayName, role: profiles.role })
    .from(conversationMembers)
    .innerJoin(profiles, eq(profiles.id, conversationMembers.profileId))
    .where(inArray(conversationMembers.conversationId, rows.map((x) => x.c.id)));
  return rows.map(({ c, ...x }) => ({ ...c, ...x, members: mem.filter((m) => m.conversationId === c.id) }));
}

function shapeForAdmin(m: typeof messages.$inferSelect, senders: Map<string, string>) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const fileId = typeof p.fileId === 'string' ? p.fileId : null;
  return {
    id: m.id,
    kind: m.kind,
    body: m.body,
    payload: fileId ? { ...p, url: fileUrl({ id: fileId, isPublic: false }) } : p,
    status: m.status,
    flagged: m.flagged,
    hidden: !!m.hiddenAt,
    senderUserId: m.senderProfileId ? (senders.get(m.senderProfileId) ?? null) : null,
    admin: m.senderProfileId === null && typeof p.admin === 'string' ? p.admin : null,
    createdAt: m.createdAt,
  };
}

async function messagesOf(conversationId: string, limit = 500) {
  const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(desc(messages.createdAt)).limit(limit);
  const pids = [...new Set(rows.map((m) => m.senderProfileId).filter((x): x is string => !!x))];
  const ps = pids.length ? await db.select({ id: profiles.id, userId: profiles.userId }).from(profiles).where(inArray(profiles.id, pids)) : [];
  const senders = new Map(ps.map((p) => [p.id, p.userId]));
  return rows.reverse().map((m) => shapeForAdmin(m, senders));
}

async function convForAdmin(a: AdminCtx, id: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!c) throw notFound('گفت‌وگو پیدا نشد');
  if (a.provinces.length) {
    const [ok] = await db
      .select({ n: sql<number>`1` })
      .from(conversationMembers)
      .innerJoin(profiles, eq(profiles.id, conversationMembers.profileId))
      .where(and(eq(conversationMembers.conversationId, id), inArray(profiles.province, a.provinces)))
      .limit(1);
    if (!ok) throw forbidden('این گفت‌وگو خارج از محدودهٔ استان توست', 'OUT_OF_SCOPE');
  }
  return c;
}

r.get(
  '/conversations/:id',
  perm('chats'),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const c = await convForAdmin(req.admin!, id);
    res.json({ conversation: c, items: await messagesOf(id) });
  }),
);

const textBody = z.object({ text: z.string().trim().min(1).max(2000) });

/** پیام «پشتیبانی بلوک» داخل یک گفت‌وگو (هر دو طرف می‌بینند) */
async function adminSay(req: { admin?: AdminCtx; user?: { id: string } }, convId: string, text: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
  if (!c) throw notFound('گفت‌وگو پیدا نشد');
  return postMessage(c, null, { kind: 'text', body: text, payload: { admin: req.admin!.name } });
}

r.post(
  '/conversations/:id/messages',
  perm('chats', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { text } = parse(textBody, req.body);
    await convForAdmin(req.admin!, id);
    const m = await adminSay(req, id, text);
    await adminLog(db, req.user!, 'chat.message', 'conversation', id, text.slice(0, 200));
    res.status(201).json({ message: m });
  }),
);

r.patch(
  '/conversations/:id',
  perm('chats', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { locked } = parse(z.object({ locked: z.boolean() }), req.body);
    const c = await convForAdmin(req.admin!, id);
    if (!!c.lockedAt === locked) return res.json({ conversation: c });
    const [nc] = await db.update(conversations).set({ lockedAt: locked ? new Date() : null }).where(eq(conversations.id, id)).returning();
    await postMessage(nc, null, { kind: 'sys', body: locked ? 'این گفت‌وگو توسط پشتیبانی بلوک قفل شد.' : 'پشتیبانی بلوک قفل این گفت‌وگو را برداشت.' });
    await adminLog(db, req.user!, locked ? 'chat.lock' : 'chat.unlock', 'conversation', id);
    res.json({ conversation: nc });
  }),
);

r.patch(
  '/messages/:id',
  perm('chats', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ hidden: z.boolean().optional(), flagged: z.boolean().optional() }), req.body);
    const [m] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    if (!m) throw notFound('پیام پیدا نشد');
    await convForAdmin(req.admin!, m.conversationId);
    const set: Partial<typeof messages.$inferInsert> = {};
    if (body.hidden !== undefined) set.hiddenAt = body.hidden ? new Date() : null;
    if (body.flagged !== undefined) set.flagged = body.flagged;
    const [nm] = await db.update(messages).set(set).where(eq(messages.id, id)).returning();
    const members = await db.select({ userId: conversationMembers.userId }).from(conversationMembers).where(eq(conversationMembers.conversationId, m.conversationId));
    if (body.hidden !== undefined) emitTo(members.map((x) => x.userId), { type: 'conversation', data: { conversationId: m.conversationId, changedMessageId: id } });
    await adminLog(db, req.user!, body.hidden !== undefined ? (body.hidden ? 'message.hide' : 'message.show') : body.flagged ? 'message.flag' : 'message.safe', 'message', id, (m.body ?? '').slice(0, 120));
    res.json({ message: { id: nm.id, hidden: !!nm.hiddenAt, flagged: nm.flagged } });
  }),
);

r.post(
  '/users/:id/warn',
  perm('chats', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ text: z.string().trim().min(5).max(1000), report: z.boolean().default(false) }), req.body);
    const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw notFound('کاربر پیدا نشد');
    await notify(id, { type: 'id', title: 'اخطار پشتیبانی بلوک', body: body.text });
    if (body.report) {
      const [p] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, id)).orderBy(sql`${profiles.role} = ${u.activeRole} desc`).limit(1);
      if (p) await db.insert(reports).values({ reporterUserId: req.user!.id, targetProfileId: p.id, reason: 'اخطار مدیر', details: body.text, status: 'resolved', handledBy: req.user!.id, handledAt: new Date() });
    }
    await adminLog(db, req.user!, 'user.warn', 'user', id, body.text.slice(0, 200));
    res.json({ ok: true });
  }),
);

/* ================= پشتیبانی ================= */

async function ticketsSection(a: AdminCtx) {
  const rows = await db
    .select({ t: supportTickets, phone: users.phone, activeRole: users.activeRole })
    .from(supportTickets)
    .innerJoin(users, eq(users.id, supportTickets.userId))
    .where(and(isNotNull(supportTickets.subject), userInScope(a, '"support_tickets"."user_id"')))
    .orderBy(desc(supportTickets.updatedAt))
    .limit(300);
  if (!rows.length) return [];
  const msgs = await db
    .select({ m: messages, senderUserId: profiles.userId })
    .from(messages)
    .leftJoin(profiles, eq(profiles.id, messages.senderProfileId))
    .where(inArray(messages.conversationId, rows.map((x) => x.t.conversationId)))
    .orderBy(messages.createdAt);
  return rows.map(({ t, phone }) => ({
    ...t,
    code: 'T-' + (1000 + t.no),
    phone,
    messages: msgs
      .filter((x) => x.m.conversationId === t.conversationId && x.m.kind !== 'sys')
      .slice(-100)
      .map(({ m, senderUserId }) => ({
        id: m.id,
        from: m.senderProfileId ? 'user' : 'admin',
        admin: typeof m.payload?.admin === 'string' ? m.payload.admin : null,
        kind: m.kind,
        body: m.kind === 'photo' || m.kind === 'file' ? `${m.kind === 'photo' ? '🖼 عکس' : '📎 فایل'}${m.body ? ' · ' + m.body : ''}` : m.body,
        senderUserId,
        createdAt: m.createdAt,
      })),
  }));
}

async function ticketFor(a: AdminCtx, id: string) {
  const [t] = await db.select().from(supportTickets).where(and(eq(supportTickets.id, id), userInScope(a, '"support_tickets"."user_id"'))).limit(1);
  if (!t) throw notFound('تیکت پیدا نشد');
  return t;
}

r.patch(
  '/tickets/:id',
  perm('support', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        status: z.enum(['open', 'pending', 'closed']).optional(),
        priority: z.enum(['high', 'mid', 'low']).optional(),
        category: z.string().trim().min(2).max(40).optional(),
        assigneeAdminId: z.string().uuid().nullable().optional(),
      }),
      req.body,
    );
    const t = await ticketFor(req.admin!, id);
    const [nt] = await db.update(supportTickets).set({ ...body, updatedAt: new Date() }).where(eq(supportTickets.id, id)).returning();
    if (body.status === 'closed' && t.status !== 'closed') {
      const [c] = await db.select().from(conversations).where(eq(conversations.id, t.conversationId)).limit(1);
      await postMessage(c, null, { kind: 'sys', body: 'پشتیبانی بلوک این درخواست را بست. اگر هنوز مشکلی هست، همین‌جا بنویس.' });
    }
    await adminLog(db, req.user!, 'ticket.update', 'ticket', id, `T-${1000 + t.no} ${JSON.stringify(body)}`);
    res.json({ ticket: nt });
  }),
);

r.post(
  '/tickets/:id/reply',
  perm('support', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { text } = parse(textBody, req.body);
    const t = await ticketFor(req.admin!, id);
    const m = await adminSay(req, t.conversationId, text);
    await db
      .update(supportTickets)
      .set({ status: 'pending', assigneeAdminId: t.assigneeAdminId ?? req.admin!.id, firstReplyAt: t.firstReplyAt ?? new Date(), updatedAt: new Date() })
      .where(eq(supportTickets.id, id));
    await notify(t.userId, { type: 'msg', title: 'پاسخ پشتیبانی بلوک', body: text.slice(0, 140), link: { screen: 'chat', id: t.conversationId } });
    await adminLog(db, req.user!, 'ticket.reply', 'ticket', id, `T-${1000 + t.no}`);
    res.status(201).json({ message: m });
  }),
);

/* ================= اعلان همگانی ================= */

const audience = z.object({
  roles: z.array(z.enum(ROLES)).max(6).default([]),
  provinces: z.array(z.string().trim().min(2).max(60)).max(31).default([]),
  userIds: z.array(z.string().uuid()).max(5000).default([]),
});

function audienceWhere(a: AdminCtx, t: z.infer<typeof audience>) {
  const provs = a.provinces.length ? (t.provinces.length ? t.provinces.filter((p) => a.provinces.includes(p)) : a.provinces) : t.provinces;
  if (a.provinces.length && t.provinces.length && !provs.length) return sql`false`;
  const conds: SQL[] = [eq(users.status, 'active')];
  if (t.userIds.length) conds.push(inArray(users.id, t.userIds));
  if (t.roles.length || provs.length) {
    const inner: SQL[] = [sql`sp.user_id = "users"."id"`];
    if (t.roles.length) inner.push(inList(sql`sp.role`, t.roles));
    if (provs.length) inner.push(inList(sql`sp.province`, provs));
    conds.push(sql`exists (select 1 from ${profiles} sp where ${sql.join(inner, sql` and `)})`);
  }
  return and(...conds)!;
}

r.post(
  '/broadcasts/preview',
  perm('notif'),
  ah(async (req, res) => {
    const t = parse(audience, req.body);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(audienceWhere(req.admin!, t));
    res.json({ count: n });
  }),
);

r.post(
  '/broadcasts',
  perm('notif', 2),
  ah(async (req, res) => {
    const body = parse(
      audience.extend({
        title: z.string().trim().min(2).max(160),
        body: z.string().trim().max(1000).optional(),
        screen: z.string().trim().max(30).optional(),
        targetText: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    const ids = (await db.select({ id: users.id }).from(users).where(audienceWhere(req.admin!, body))).map((x) => x.id);
    if (!ids.length) throw badRequest('هیچ کاربری با این شرایط نیست', 'NO_AUDIENCE');
    const link = body.screen ? { screen: body.screen } : undefined;
    const targetText = body.targetText || [body.roles.join('، ') || 'همه', body.provinces.join('، ')].filter(Boolean).join(' · ');
    const [b] = await db
      .insert(broadcasts)
      .values({ title: body.title, body: body.body, link, target: { roles: body.roles, provinces: body.provinces, userIds: body.userIds }, targetText, sent: ids.length, createdBy: req.user!.id })
      .returning();
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await db
        .insert(notifications)
        .values(ids.slice(i, i + 1000).map((userId) => ({ userId, type: 'ad', title: body.title, body: body.body, link, broadcastId: b.id })))
        .returning();
      for (const n of rows) emitTo(n.userId, { type: 'notification', data: n });
    }
    await adminLog(db, req.user!, 'broadcast.send', 'broadcast', b.id, `${body.title} · ${ids.length} نفر`);
    res.status(201).json({ broadcast: b, sent: ids.length });
  }),
);

async function broadcastsSection() {
  const rows = await db
    .select({
      b: broadcasts,
      opened: sql<number>`(select count(*) from ${notifications} n where n.broadcast_id = "broadcasts"."id" and n.read_at is not null)::int`,
      by: admins.id,
    })
    .from(broadcasts)
    .leftJoin(admins, eq(admins.userId, broadcasts.createdBy))
    .orderBy(desc(broadcasts.createdAt))
    .limit(100);
  return rows.map(({ b, opened, by }) => ({ ...b, opened, byAdminId: by }));
}

/* ================= تنظیمات و محتوا ================= */

// کدام بخش پنل اجازهٔ ویرایش هر کلید را می‌دهد
const CONFIG_MODULE: Record<ConfigKey, AdminModule> = {
  settings: 'settings',
  coefs: 'coefs',
  catalog: 'catalog',
  legal: 'legal',
  notifTemplates: 'notif',
  boost: 'pay',
  stories: 'stories',
  courses: 'academy',
  visitTypes: 'coefs',
};

r.put(
  '/config/:key',
  ah(async (req, res) => {
    const { key } = parse(z.object({ key: z.enum(CONFIG_KEYS as [ConfigKey, ...ConfigKey[]]) }), req.params);
    const a = req.admin!;
    if (!can(a, CONFIG_MODULE[key], 2)) throw forbidden('برای این بخش دسترسی ویرایش نداری', 'NO_PERMISSION');
    const body = parse(z.object({ value: z.unknown(), note: z.string().trim().max(300).optional() }), req.body);
    const v = validateConfig(key, body.value);
    if (!v.ok) throw badRequest('تنظیمات معتبر نیست: ' + v.message, 'BAD_CONFIG');
    if (key === 'settings' && (v.value as { flags?: Record<string, boolean> }).flags?.maintenance && a.roleKey !== 'owner') {
      if (!cfg('settings').flags.maintenance) throw forbidden('حالت تعمیر را فقط مدیر ارشد روشن می‌کند', 'OWNER_ONLY');
    }
    await saveConfig(key, v.value, req.user!.id);
    await adminLog(db, req.user!, 'config.' + key, 'config', ZERO, body.note ?? null);
    res.json({ key, value: cfg(key) });
  }),
);

async function contentSection() {
  const [stats, done] = await Promise.all([
    db.select().from(contentStats),
    db
      .select({ courseId: courseProgress.courseId, started: sql<number>`count(*)::int`, completed: sql<number>`count(${courseProgress.completedAt})::int` })
      .from(courseProgress)
      .groupBy(courseProgress.courseId),
  ]);
  return { views: stats, courses: done };
}

/* ---------- «+ مورد دیگر» کاربران ---------- */

const customKey = (role: string, field: string, value: string) => `${role}.${field}|${value}`;

async function customSection() {
  const decided = cfg('catalog').custom ?? {};
  const out: { role: Role; field: string; label: string; value: string; count: number; status: string; to?: string }[] = [];
  const ps = await db.select({ role: profiles.role, data: profiles.data }).from(profiles);
  const counts = new Map<string, number>();
  for (const p of ps) {
    for (const f of allFields(p.role).filter((x) => x.custom && x.opts)) {
      const raw = (p.data as Record<string, unknown>)[f.k];
      for (const v of Array.isArray(raw) ? raw : raw ? [raw] : []) {
        if (typeof v !== 'string' || f.opts!.includes(v)) continue;
        const k = customKey(p.role, f.k, v);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  for (const [k, count] of counts) {
    const [head, value] = k.split('|');
    const [role, field] = head.split('.') as [Role, string];
    const d = decided[k];
    const f = allFields(role).find((x) => x.k === field)!;
    out.push({ role, field, label: f.label, value, count, status: !d ? 'wait' : typeof d === 'object' ? 'merge' : d, to: typeof d === 'object' ? d.to : undefined });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 500);
}

r.post(
  '/catalog/custom',
  perm('catalog', 2),
  ah(async (req, res) => {
    const body = parse(
      z.object({ role: z.enum(ROLES), field: z.string().max(30), value: z.string().min(1).max(60), action: z.enum(['ok', 'rej', 'merge']), to: z.string().trim().min(2).max(60).optional() }),
      req.body,
    );
    const f = allFields(body.role).find((x) => x.k === body.field && x.custom);
    if (!f) throw badRequest('این فیلد «مورد دیگر» ندارد', 'BAD_FIELD');
    const k = customKey(body.role, body.field, body.value);
    const catalog = { ...cfg('catalog'), custom: { ...(cfg('catalog').custom ?? {}) } };
    if (body.action === 'merge') {
      if (!body.to || body.to === body.value) throw badRequest('گزینهٔ مقصد را انتخاب کن', 'BAD_TARGET');
      catalog.custom[k] = { to: body.to };
      // مقدار در پروفایل‌ها با گزینهٔ رسمی جایگزین می‌شود
      const ps = await db.select({ id: profiles.id, data: profiles.data }).from(profiles).where(eq(profiles.role, body.role));
      for (const p of ps) {
        const d = p.data as Record<string, unknown>;
        const raw = d[body.field];
        if (Array.isArray(raw) ? !raw.includes(body.value) : raw !== body.value) continue;
        const nv = Array.isArray(raw) ? [...new Set(raw.map((x) => (x === body.value ? body.to : x)))] : body.to;
        await db.update(profiles).set({ data: { ...d, [body.field]: nv } }).where(eq(profiles.id, p.id));
        await db.update(profileSkills).set({ title: body.to }).where(and(eq(profileSkills.profileId, p.id), eq(profileSkills.title, body.value)));
      }
    } else catalog.custom[k] = body.action;
    await saveConfig('catalog', catalog, req.user!.id);
    await adminLog(db, req.user!, 'catalog.' + body.action, 'config', ZERO, `${f.label}: ${body.value}${body.to ? ' ← ' + body.to : ''}`);
    res.json({ ok: true });
  }),
);


/* ================= پرسش تخصصی ================= */

async function qaSection(a: AdminCtx) {
  const rows = await db
    .select({ r: adResponses, adId: ads.id, userId: profiles.userId })
    .from(adResponses)
    .innerJoin(ads, eq(ads.id, adResponses.adId))
    .innerJoin(profiles, eq(profiles.id, adResponses.profileId))
    .where(and(eq(ads.type, 'consult'), a.provinces.length ? inArray(ads.province, a.provinces) : undefined))
    .orderBy(desc(adResponses.createdAt))
    .limit(500);
  return rows.map(({ r: x, adId, userId }) => ({ id: x.id, adId, userId, message: x.message, status: x.status, createdAt: x.createdAt }));
}

/* ================= تراکنش‌ها و تسویه ================= */

async function txSection(a: AdminCtx) {
  const scope = a.provinces.length ? inArray(profiles.province, a.provinces) : undefined;
  const [pays, cases, outs] = await Promise.all([
    db
      .select({ p: projectPayments, projectTitle: projects.title, userId: profiles.userId })
      .from(projectPayments)
      .innerJoin(projects, eq(projects.id, projectPayments.projectId))
      .innerJoin(profiles, eq(profiles.id, projects.clientProfileId))
      .where(scope)
      .orderBy(desc(projectPayments.createdAt))
      .limit(500),
    db
      .select({ c: arbitrationCases, userId: profiles.userId, projectId: disputes.projectId })
      .from(arbitrationCases)
      .innerJoin(disputes, eq(disputes.id, arbitrationCases.disputeId))
      .leftJoin(profiles, eq(profiles.id, arbitrationCases.payerProfileId))
      .where(and(ne(arbitrationCases.paymentStatus, 'unpaid'), a.provinces.length ? inArray(disputes.province, a.provinces) : undefined))
      .orderBy(desc(arbitrationCases.updatedAt))
      .limit(500),
    db
      .select({ o: arbiterPayouts, userId: arbiters.userId })
      .from(arbiterPayouts)
      .innerJoin(arbiters, eq(arbiters.id, arbiterPayouts.arbiterId))
      .orderBy(desc(arbiterPayouts.createdAt))
      .limit(300),
  ]);
  const out: { id: string; kind: string; label: string; userId: string | null; amount: number; at: Date; status: 'ok' | 'pending' | 'fail'; ref: string | null; projectId: string | null }[] = [];
  for (const { p, userId } of pays)
    out.push({ id: p.id, kind: 'direct', label: 'پرداخت ثبت‌شده · ' + p.label, userId, amount: p.amount, at: p.createdAt, status: p.status === 'confirmed' ? 'ok' : p.status === 'disputed' ? 'fail' : 'pending', ref: p.paidOn, projectId: p.projectId });
  for (const { c, userId, projectId } of cases) {
    out.push({ id: c.id + ':p', kind: 'arb', label: 'هزینهٔ داوری (امانی)', userId, amount: c.total, at: c.paidAt ?? c.updatedAt, status: 'ok', ref: c.paymentRef, projectId });
    if (c.paymentStatus === 'refunded') out.push({ id: c.id + ':r', kind: 'refund', label: 'بازگشت هزینهٔ داوری', userId, amount: c.total, at: c.refundedAt ?? c.updatedAt, status: 'ok', ref: c.refundReason, projectId });
    if (c.paymentStatus === 'released') out.push({ id: c.id + ':s', kind: 'release', label: 'آزاد شدن سهم حل‌کننده', userId: null, amount: c.arbiterShare, at: c.releasedAt ?? c.updatedAt, status: 'ok', ref: null, projectId });
  }
  for (const { o, userId } of outs) out.push({ id: o.id, kind: 'payout', label: 'تسویه به حساب حل‌کننده', userId, amount: o.amount, at: o.createdAt, status: 'ok', ref: o.ref, projectId: null });
  return out.sort((x, y) => +new Date(y.at) - +new Date(x.at)).slice(0, 800);
}

/** سهم آزادشده منهای تسویه‌شده، برای هر حل‌کننده */
export async function arbiterBalances() {
  const rows = await db
    .select({
      id: arbiters.id,
      released: sql<number>`coalesce((select sum(c.arbiter_share) from ${arbitrationCases} c where c.arbiter_id = "arbiters"."id" and c.payment_status = 'released'), 0)::bigint`,
      paid: sql<number>`coalesce((select sum(o.amount) from ${arbiterPayouts} o where o.arbiter_id = "arbiters"."id"), 0)::bigint`,
    })
    .from(arbiters);
  return new Map(rows.map((x) => [x.id, { released: Number(x.released), paidOut: Number(x.paid), pending: Number(x.released) - Number(x.paid) }]));
}

r.post(
  '/payouts',
  perm('pay', 2),
  ah(async (req, res) => {
    const body = parse(z.object({ arbiterId: z.string().uuid(), amount: moneyInput, ref: z.string().trim().min(3).max(120) }), req.body);
    if (!body.amount) throw badRequest('مبلغ را وارد کن', 'BAD_AMOUNT');
    const [arb] = await db.select().from(arbiters).where(eq(arbiters.id, body.arbiterId)).limit(1);
    if (!arb) throw notFound('حل‌کننده پیدا نشد');
    const bal = (await arbiterBalances()).get(arb.id)!;
    if (body.amount > bal.pending) throw conflict(`مانده قابل تسویه ${bal.pending.toLocaleString('fa-IR')} تومان است`, 'OVER_BALANCE');
    const [o] = await db.insert(arbiterPayouts).values({ arbiterId: arb.id, amount: body.amount, ref: body.ref, adminUserId: req.user!.id }).returning();
    await notify(arb.userId, { type: 'id', title: 'تسویهٔ سهم داوری', body: `${body.amount.toLocaleString('fa-IR')} تومان به حسابت واریز شد · پیگیری ${body.ref}` });
    await adminLog(db, req.user!, 'arbiter.payout', 'arbiter', arb.id, `${body.amount} · ${body.ref}`);
    res.status(201).json({ payout: o });
  }),
);

/* ================= وضعیت سرویس و نشست‌ها ================= */

async function statusSection() {
  const t = Date.now();
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }
  const dbMs = Date.now() - t;
  const [[online], [openTickets]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(users).where(gt(users.lastSeenAt, new Date(Date.now() - 10 * 60_000))),
    db.select({ n: sql<number>`count(*)::int` }).from(supportTickets).where(eq(supportTickets.status, 'open')),
  ]);
  return {
    ...metrics(),
    db: { ok: dbOk, ms: dbMs },
    storage: env.STORAGE_DRIVER,
    sms: env.SMS_PROVIDER,
    env: env.NODE_ENV,
    online: online.n,
    openTickets: openTickets.n,
  };
}

r.get('/status', perm('status'), ah(async (_req, res) => res.json(await statusSection())));

async function sessionsSection() {
  return db
    .select({ id: refreshTokens.id, userId: refreshTokens.userId, adminId: admins.id, userAgent: refreshTokens.userAgent, createdAt: refreshTokens.createdAt })
    .from(refreshTokens)
    .innerJoin(admins, eq(admins.userId, refreshTokens.userId))
    .where(and(isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date()), eq(admins.status, 'active')))
    .orderBy(desc(refreshTokens.createdAt))
    .limit(200);
}

r.delete(
  '/sessions/:id',
  perm('admins', 2),
  ah(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const [t] = await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, id)).returning();
    if (!t) throw notFound('نشست پیدا نشد');
    await adminLog(db, req.user!, 'admin.session_close', 'admin', ZERO, t.userAgent);
    res.json({ ok: true });
  }),
);

export { r as panelMoreRoutes };

/** بخش‌های تصویر لحظه‌ای این فایل (panel.ts صدا می‌زند) */
export function moreSections(a: AdminCtx, add: (key: string, m: AdminModule | null, fn: () => Promise<unknown>) => void) {
  add('conversations', 'chats', () => conversationsSection(a));
  add('tickets', 'support', () => ticketsSection(a));
  add('broadcasts', 'notif', () => broadcastsSection());
  add('config', null, async () => ({ values: Object.fromEntries(CONFIG_KEYS.map((k) => [k, cfg(k)])), stored: Object.keys(storedConfig()) }));
  add('content', null, () => (can(a, 'stories') || can(a, 'academy') ? contentSection() : Promise.resolve(null)));
  add('custom', 'catalog', () => customSection());
  add('qa', 'qa', () => qaSection(a));
  add('tx', 'pay', () => txSection(a));
  add('status', 'status', () => statusSection());
  add('sessions', 'admins', () => sessionsSection());
}
