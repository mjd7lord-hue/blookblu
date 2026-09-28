import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  ads,
  conversationMembers,
  conversations,
  messages,
  profiles,
  projects,
  users,
  type DayPayload,
  type DealPayload,
  type Role,
} from '../../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { emitTo } from '../../lib/events';
import { isSuspicious } from '../../lib/flag';
import { blockedIds } from '../profiles/profiles.service';
import { notify } from '../notifications/notify';

type Profile = typeof profiles.$inferSelect;
type Conversation = typeof conversations.$inferSelect;
type Message = typeof messages.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

/* ---------- ساخت و یافتن گفت‌وگو ---------- */

/** گفت‌وگوی دونفره بین دو پروفایل (برای یک آگهی مشخص، یا مستقیم) — اگر هست همان را برمی‌گرداند */
export async function ensureConversation(
  a: Pick<Profile, 'id' | 'userId'>,
  b: Pick<Profile, 'id' | 'userId'>,
  opts: { adId?: string | null; title?: string | null } = {},
  exec: Exec = db,
): Promise<{ conv: Conversation; created: boolean }> {
  if (a.userId === b.userId) throw badRequest('با خودتان نمی‌توانید گفت‌وگو کنید', 'SELF_CHAT');
  const kind = opts.adId ? 'ad' : 'direct';
  const [existing] = await exec
    .select({ c: conversations })
    .from(conversations)
    .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
    .where(
      and(
        eq(conversationMembers.profileId, a.id),
        opts.adId ? eq(conversations.adId, opts.adId) : eq(conversations.kind, 'direct'),
        sql`exists (select 1 from ${conversationMembers} m2 where m2.conversation_id = ${conversations.id} and m2.profile_id = ${b.id})`,
      ),
    )
    .limit(1);
  if (existing) return { conv: existing.c, created: false };

  const [conv] = await exec
    .insert(conversations)
    .values({ kind, adId: opts.adId ?? null, title: opts.title?.slice(0, 160) ?? null })
    .returning();
  await exec.insert(conversationMembers).values([
    { conversationId: conv.id, profileId: a.id, userId: a.userId },
    { conversationId: conv.id, profileId: b.id, userId: b.userId },
  ]);
  return { conv, created: true };
}

/** عضویت کاربر در گفت‌وگو؛ اگر عضو نباشد «پیدا نشد» */
export async function membership(userId: string, conversationId: string) {
  const [row] = await db
    .select({ m: conversationMembers, c: conversations, me: profiles })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .innerJoin(profiles, eq(profiles.id, conversationMembers.profileId))
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
    .limit(1);
  if (!row) throw notFound('گفت‌وگو پیدا نشد');
  const [other] = await db
    .select({ m: conversationMembers, p: profiles })
    .from(conversationMembers)
    .innerJoin(profiles, eq(profiles.id, conversationMembers.profileId))
    .where(and(eq(conversationMembers.conversationId, conversationId), ne(conversationMembers.userId, userId)))
    .limit(1);
  return { member: row.m, conv: row.c, me: row.me, other: other ?? null };
}

/* ---------- پیام ---------- */

type NewMessage = {
  kind: Message['kind'];
  body?: string | null;
  payload?: Record<string, unknown> | null;
  status?: Message['status'];
  projectId?: string | null;
};

/** ثبت پیام + به‌روزرسانی شمارندهٔ خوانده‌نشده + ارسال رویداد لحظه‌ای */
export async function postMessage(conv: Conversation, sender: Pick<Profile, 'id'> | null, m: NewMessage, exec: Exec = db) {
  const flagged = m.kind === 'text' && !!m.body && isSuspicious(m.body);
  const [msg] = await exec
    .insert(messages)
    .values({
      conversationId: conv.id,
      senderProfileId: sender?.id ?? null,
      kind: m.kind,
      body: m.body ?? null,
      payload: m.payload ?? null,
      status: m.status ?? null,
      projectId: m.projectId ?? null,
      flagged,
    })
    .returning();
  await exec.update(conversations).set({ lastMessageAt: msg.createdAt }).where(eq(conversations.id, conv.id));
  // گفت‌وگوی پنهان‌شده با پیام تازه دوباره ظاهر می‌شود
  await exec
    .update(conversationMembers)
    .set({
      hiddenAt: null,
      unread: sender ? sql`case when ${conversationMembers.profileId} = ${sender.id} then 0 else ${conversationMembers.unread} + 1 end` : conversationMembers.unread,
    })
    .where(eq(conversationMembers.conversationId, conv.id));

  const members = await exec
    .select({ userId: conversationMembers.userId, profileId: conversationMembers.profileId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conv.id));
  for (const mem of members) {
    emitTo(mem.userId, { type: 'message', data: { conversationId: conv.id, message: shapeMessage(msg, mem.profileId) } });
  }
  return msg;
}

export function shapeMessage(m: Message, viewerProfileId: string) {
  return {
    id: m.id,
    kind: m.kind,
    body: m.body,
    payload: m.payload,
    status: m.status,
    flagged: m.flagged && m.senderProfileId !== viewerProfileId,
    mine: m.senderProfileId === viewerProfileId,
    system: m.senderProfileId === null,
    projectId: m.projectId,
    createdAt: m.createdAt,
  };
}

async function assertNotBlocked(userId: string, otherUserId?: string) {
  if (otherUserId && (await blockedIds(userId)).includes(otherUserId)) {
    throw forbidden('امکان گفت‌وگو با این کاربر نیست', 'BLOCKED');
  }
}

export async function sendMessage(
  userId: string,
  conversationId: string,
  input: { kind: 'text' | 'loc' | 'phone'; body?: string; payload?: Record<string, unknown> },
) {
  const { conv, me, other } = await membership(userId, conversationId);
  await assertNotBlocked(userId, other?.p.userId);
  if (input.kind === 'phone') {
    // شمارهٔ خود فرستنده از حسابش برداشته می‌شود، نه از ورودی
    const [u] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1);
    return postMessage(conv, me, { kind: 'phone', body: u.phone });
  }
  return postMessage(conv, me, { kind: input.kind, body: input.body ?? null, payload: input.payload ?? null });
}

export async function listMessages(userId: string, conversationId: string, q: { before?: string; limit: number }) {
  const { member, conv, me, other } = await membership(userId, conversationId);
  const conds = [eq(messages.conversationId, conversationId)];
  if (q.before) conds.push(lt(messages.createdAt, new Date(q.before)));
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.createdAt))
    .limit(q.limit);

  // باز کردن گفت‌وگو = خواندن پیام‌ها
  if (member.unread > 0 || !q.before) {
    await db
      .update(conversationMembers)
      .set({ unread: 0, lastReadAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.profileId, me.id)));
    if (other) emitTo(other.p.userId, { type: 'read', data: { conversationId, at: new Date() } });
  }

  let project = null;
  if (conv.projectId) {
    const [p] = await db.select().from(projects).where(eq(projects.id, conv.projectId)).limit(1);
    project = p ?? null;
  }
  return {
    conversation: {
      id: conv.id,
      kind: conv.kind,
      title: conv.title,
      stage: conv.stage,
      adId: conv.adId,
      projectId: conv.projectId,
      muted: member.muted,
      archived: member.archived,
      pinned: member.pinned,
      // تیک دوم: طرف مقابل تا این زمان خوانده
      otherLastReadAt: other?.m.lastReadAt ?? null,
    },
    me: { code: me.code, role: me.role, name: me.displayName },
    other: other && {
      code: other.p.code,
      role: other.p.role,
      name: other.p.displayName,
      title: other.p.title,
      verified: other.p.verified,
    },
    project,
    items: rows.reverse().map((m) => shapeMessage(m, me.id)),
    hasMore: rows.length === q.limit,
  };
}

export async function listConversations(userId: string, q: { filter: 'all' | 'unread' | 'archived' | 'project'; q?: string }) {
  const rows = await db
    .select({ m: conversationMembers, c: conversations, me: profiles })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .innerJoin(profiles, eq(profiles.id, conversationMembers.profileId))
    .where(
      and(
        eq(conversationMembers.userId, userId),
        sql`(${conversationMembers.hiddenAt} is null or ${conversationMembers.hiddenAt} < ${conversations.lastMessageAt})`,
      ),
    )
    .orderBy(desc(conversationMembers.pinned), desc(conversations.lastMessageAt))
    .limit(200);
  if (!rows.length) return { items: [], unreadTotal: 0 };

  const ids = rows.map((r) => r.c.id);
  const [others, lasts] = await Promise.all([
    db
      .select({ conversationId: conversationMembers.conversationId, p: profiles })
      .from(conversationMembers)
      .innerJoin(profiles, eq(profiles.id, conversationMembers.profileId))
      .where(and(inArray(conversationMembers.conversationId, ids), ne(conversationMembers.userId, userId))),
    db
      .selectDistinctOn([messages.conversationId], {
        conversationId: messages.conversationId,
        kind: messages.kind,
        body: messages.body,
        payload: messages.payload,
        sender: messages.senderProfileId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(inArray(messages.conversationId, ids), ne(messages.kind, 'sys')))
      .orderBy(messages.conversationId, desc(messages.createdAt)),
  ]);

  const PREVIEW: Record<string, string> = {
    loc: '📍 موقعیت', phone: '📞 شمارهٔ تماس', photo: '🖼 عکس', file: '📎 فایل', voice: '🎤 پیام صوتی',
    deal: '🤝 پیشنهاد توافق', day: '📅 پیشنهاد روز شروع', del: 'این پیام حذف شد',
  };
  let items = rows.map(({ m, c, me }) => {
    const o = others.find((x) => x.conversationId === c.id)?.p;
    const last = lasts.find((x) => x.conversationId === c.id);
    return {
      id: c.id,
      kind: c.kind,
      title: c.title,
      stage: c.stage,
      projectId: c.projectId,
      asRole: me.role,
      other: o ? { code: o.code, role: o.role, name: o.displayName, verified: o.verified } : null,
      last: last
        ? {
            text: last.kind === 'text' ? last.body : PREVIEW[last.kind] ?? '',
            mine: last.sender === me.id,
            at: last.createdAt,
          }
        : null,
      unread: m.unread,
      muted: m.muted,
      archived: m.archived,
      pinned: m.pinned,
      lastMessageAt: c.lastMessageAt,
    };
  });

  const unreadTotal = items.reduce((s, x) => s + (x.archived || x.muted ? 0 : x.unread), 0);
  if (q.filter === 'archived') items = items.filter((x) => x.archived);
  else items = items.filter((x) => !x.archived);
  if (q.filter === 'unread') items = items.filter((x) => x.unread > 0);
  if (q.filter === 'project') items = items.filter((x) => !!x.projectId);
  if (q.q) {
    const t = q.q.trim();
    items = items.filter((x) => (x.other?.name ?? '').includes(t) || (x.title ?? '').includes(t) || (x.last?.text ?? '').includes(t));
  }
  return { items, unreadTotal };
}

export async function startConversation(me: Profile, input: { profileCode: string; adId?: string }) {
  const [other] = await db.select().from(profiles).where(eq(profiles.code, input.profileCode.toUpperCase())).limit(1);
  if (!other) throw notFound('کاربر پیدا نشد');
  const [ou] = await db.select({ status: users.status }).from(users).where(eq(users.id, other.userId)).limit(1);
  if (ou?.status !== 'active') throw notFound('کاربر پیدا نشد');
  if (!other.isPublic) throw forbidden('این پروفایل خصوصی است', 'PROFILE_PRIVATE');
  await assertNotBlocked(me.userId, other.userId);

  let title: string | null = null;
  if (input.adId) {
    const [ad] = await db.select({ title: ads.title, profileId: ads.profileId }).from(ads).where(eq(ads.id, input.adId)).limit(1);
    if (!ad || ad.profileId !== other.id) throw badRequest('آگهی مربوط به این کاربر نیست', 'BAD_AD');
    title = ad.title;
  }
  const { conv, created } = await ensureConversation(me, other, { adId: input.adId, title });
  if (created) {
    await postMessage(conv, null, {
      kind: 'sys',
      body: title ? `این گفت‌وگو از آگهی «${title}» شروع شد.` : 'گفت‌وگوی مستقیم در بلوک. شماره‌ات تا خودت نفرستی نمایش داده نمی‌شود.',
    });
  }
  return conv;
}

export async function updateMembership(
  userId: string,
  conversationId: string,
  set: Partial<{ muted: boolean; archived: boolean; pinned: boolean }>,
) {
  const { me } = await membership(userId, conversationId);
  await db
    .update(conversationMembers)
    .set(set)
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.profileId, me.id)));
}

export async function hideConversation(userId: string, conversationId: string) {
  const { me } = await membership(userId, conversationId);
  await db
    .update(conversationMembers)
    .set({ hiddenAt: new Date(), unread: 0 })
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.profileId, me.id)));
}

export async function deleteMessage(userId: string, messageId: string) {
  const [m] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!m) throw notFound('پیام پیدا نشد');
  const { me } = await membership(userId, m.conversationId);
  if (m.senderProfileId !== me.id) throw forbidden('فقط پیام‌های خودت را می‌توانی حذف کنی', 'NOT_OWNER');
  if (!['text', 'loc', 'phone'].includes(m.kind)) throw badRequest('پیشنهاد و پیام سیستمی حذف نمی‌شود؛ پیشنهاد را لغو کن', 'NOT_DELETABLE');
  if (Date.now() - m.createdAt.getTime() > 24 * 3600_000) throw badRequest('فقط تا ۲۴ ساعت بعد از ارسال می‌شود حذف کرد', 'TOO_OLD');
  await db.update(messages).set({ kind: 'del', body: null, payload: null, flagged: false }).where(eq(messages.id, messageId));
  const members = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, m.conversationId));
  emitTo(members.map((x) => x.userId), { type: 'conversation', data: { conversationId: m.conversationId, deletedMessageId: m.id } });
}

/* ---------- پیشنهاد توافق و روز شروع ---------- */

async function cancelPending(conversationId: string, kind: 'deal' | 'day', exec: Exec = db) {
  await exec
    .update(messages)
    .set({ status: 'cancelled' })
    .where(and(eq(messages.conversationId, conversationId), eq(messages.kind, kind), eq(messages.status, 'pending')));
}

export async function proposeDeal(userId: string, conversationId: string, d: DealPayload) {
  const { conv, me, other } = await membership(userId, conversationId);
  if (!other) throw badRequest('طرف مقابل در این گفت‌وگو نیست');
  await assertNotBlocked(userId, other.p.userId);
  if (conv.projectId) {
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, conv.projectId)).limit(1);
    if (p?.status === 'active') throw conflict('در این گفت‌وگو یک پروژهٔ فعال هست؛ اول آن را تمام یا لغو کن', 'PROJECT_ACTIVE');
  }
  const sum = d.plan.reduce((s, x) => s + x.pct, 0);
  if (sum !== 100) throw badRequest(`جمع درصدهای پرداخت باید ۱۰۰ باشد (الان ${sum})`, 'PLAN_SUM');

  const msg = await db.transaction(async (tx) => {
    await cancelPending(conversationId, 'deal', tx);
    return postMessage(conv, me, { kind: 'deal', payload: d, status: 'pending' }, tx);
  });
  await notify(other.p.userId, {
    type: 'req',
    title: 'پیشنهاد توافق تازه',
    body: `${me.displayName}: ${d.job} · ${d.price}`,
    link: { screen: 'chat', id: conversationId },
  });
  return msg;
}

export async function proposeDay(userId: string, conversationId: string, d: DayPayload) {
  const { conv, me, other } = await membership(userId, conversationId);
  if (!other) throw badRequest('طرف مقابل در این گفت‌وگو نیست');
  await assertNotBlocked(userId, other.p.userId);
  const msg = await db.transaction(async (tx) => {
    await cancelPending(conversationId, 'day', tx);
    return postMessage(conv, me, { kind: 'day', payload: d, status: 'pending' }, tx);
  });
  await notify(other.p.userId, {
    type: 'cal',
    title: 'پیشنهاد روز شروع',
    body: `${me.displayName}: ${d.date} ساعت ${d.hour}`,
    link: { screen: 'chat', id: conversationId },
  });
  return msg;
}

const ROLE_RANK: Record<Role, number> = { worker: 1, specialist: 2, engineer: 3, contractor: 4, company: 5, general: 6 };

/** چه کسی کارفرما (client) است و چه کسی مجری (provider) */
async function decideParties(conv: Conversation, a: Profile, b: Profile): Promise<{ client: Profile; provider: Profile }> {
  if (conv.adId) {
    const [ad] = await db.select({ type: ads.type, profileId: ads.profileId }).from(ads).where(eq(ads.id, conv.adId)).limit(1);
    if (ad) {
      const owner = ad.profileId === a.id ? a : b;
      const responder = owner === a ? b : a;
      // «آمادهٔ همکاری»: صاحب آگهی مجری است؛ «نیاز به نیرو» و «پرسش»: صاحب آگهی کارفرماست
      return ad.type === 'work' ? { client: responder, provider: owner } : { client: owner, provider: responder };
    }
  }
  return ROLE_RANK[a.role] >= ROLE_RANK[b.role] ? { client: a, provider: b } : { client: b, provider: a };
}

export async function answerProposal(userId: string, messageId: string, status: 'accepted' | 'rejected') {
  const [m] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!m || (m.kind !== 'deal' && m.kind !== 'day')) throw notFound('پیشنهاد پیدا نشد');
  const { conv, me, other } = await membership(userId, m.conversationId);
  if (m.senderProfileId === me.id) throw forbidden('پیشنهاد خودت را نمی‌توانی تأیید کنی؛ طرف مقابل باید جواب بدهد', 'OWN_PROPOSAL');
  if (m.status !== 'pending') throw conflict('این پیشنهاد دیگر معتبر نیست', 'NOT_PENDING');
  if (!other) throw badRequest('طرف مقابل در این گفت‌وگو نیست');

  const result = await db.transaction(async (tx) => {
    // قفل خوش‌بینانه: فقط اگر هنوز pending است
    const upd = await tx
      .update(messages)
      .set({ status })
      .where(and(eq(messages.id, m.id), eq(messages.status, 'pending')))
      .returning({ id: messages.id });
    if (!upd.length) throw conflict('این پیشنهاد دیگر معتبر نیست', 'NOT_PENDING');

    if (status === 'rejected') {
      await postMessage(conv, null, { kind: 'sys', body: m.kind === 'deal' ? 'پیشنهاد توافق رد شد.' : 'روز پیشنهادی رد شد؛ روز دیگری پیشنهاد بده.' }, tx);
      return { project: null };
    }

    if (m.kind === 'day') {
      const d = m.payload as DayPayload;
      if (conv.projectId) {
        await tx
          .update(projects)
          .set({ startDate: d.date, startText: `${d.date}، ساعت ${d.hour}`, updatedAt: new Date() })
          .where(eq(projects.id, conv.projectId));
      }
      await postMessage(conv, null, { kind: 'sys', body: `روز شروع هماهنگ شد: ${d.date}، ساعت ${d.hour}` }, tx);
      if (conv.stage < 1) await tx.update(conversations).set({ stage: 1 }).where(eq(conversations.id, conv.id));
      return { project: null };
    }

    // توافق پذیرفته شد → پروژه ساخته می‌شود
    const d = m.payload as DealPayload;
    const { client, provider } = await decideParties(conv, me, other.p);
    const [project] = await tx
      .insert(projects)
      .values({
        title: d.job,
        clientProfileId: client.id,
        providerProfileId: provider.id,
        conversationId: conv.id,
        dealMessageId: m.id,
        adId: conv.adId,
        stage: 1,
        quantity: d.qty ?? null,
        priceText: d.price,
        amount: d.amount ?? null,
        startText: d.start,
        durationDays: d.durationDays,
        paymentPlan: d.plan,
        retentionPct: d.retentionPct,
      })
      .returning();
    await tx.update(messages).set({ projectId: project.id }).where(eq(messages.id, m.id));
    await tx.update(conversations).set({ stage: 1, projectId: project.id }).where(eq(conversations.id, conv.id));
    await postMessage(conv, null, { kind: 'sys', body: 'توافق ثبت شد؛ هر دو طرف تأیید کردند. به «پروژه‌های من» اضافه شد.', projectId: project.id }, tx);
    return { project };
  });

  await notify(other.p.userId, {
    type: 'req',
    title: status === 'accepted' ? (m.kind === 'deal' ? 'توافق شما پذیرفته شد' : 'روز شروع تأیید شد') : 'پیشنهاد شما رد شد',
    body: me.displayName,
    link: result.project ? { screen: 'pdet', id: result.project.id } : { screen: 'chat', id: conv.id },
  });
  if (result.project) emitTo([userId, other.p.userId], { type: 'project', data: { project: result.project } });
  return result;
}
