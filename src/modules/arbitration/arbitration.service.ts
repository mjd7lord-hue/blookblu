import { and, desc, eq, inArray, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  arbiterRatings,
  arbiters,
  arbitrationCases,
  disputes,
  profiles,
  projects,
  users,
  type ArbReport,
} from '../../db/schema';
import { env } from '../../config/env';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { emitTo } from '../../lib/events';
import { normalizeFa } from '../../lib/text';
import { fileUrl, publicFileUrl, purgeFiles, saveUpload } from '../files/files.service';
import { notify } from '../notifications/notify';
import { faNum } from '../contracts/contract.service';
import { projectFor, projectSysMessage } from '../projects/access';
import { adminLog } from '../admin/admin.service';
import { ARB_FIELDS, appealFee, arbFee, fieldsForRole, type ArbField, type TravelKind } from './fees';

type Dispute = typeof disputes.$inferSelect;
type Case = typeof arbitrationCases.$inferSelect;
type Arbiter = typeof arbiters.$inferSelect;
type User = typeof users.$inferSelect;
type Profile = typeof profiles.$inferSelect;

export const DISPUTE_REASONS = ['تأخیر در پرداخت', 'تأخیر در اجرا', 'کیفیت کار', 'ترک کار', 'مصالح و ابزار', 'رفتار نامناسب'] as const;
export const DISPUTE_ASKS = ['پرداخت باقی‌مانده', 'اصلاح کار', 'بازگشت پیش‌پرداخت', 'ادامهٔ کار طبق قرارداد', 'فسخ توافقی'] as const;
export const STAGES = ['ثبت شد', 'گفت‌وگو ۴۸ ساعت', 'حل‌کنندهٔ حضوری', 'بازدید و گزارش', 'رأی و بستن پرونده'] as const;
const TALK_HOURS = 48;
const APPEAL_HOURS = 72;
const LIVE_CASE = ['awaiting_payment', 'matching', 'offered', 'assigned', 'reported', 'appealed', 'final'] as const;
const hours = (h: number) => new Date(Date.now() + h * 3600_000);

/* ================= حل‌کننده‌های مناسب (بی‌طرفی) ================= */

type Candidate = { id: string; userId: string; profileId: string; city: string; province: string; ratingAvg: number };

/**
 * حل‌کننده‌های تأییدشدهٔ همان حوزه که با هیچ‌کدام از دو طرف پروژه یا گفت‌وگوی مشترک ندارند؛
 * اول هم‌شهر، بعد هم‌استان، بعد امتیاز بیشتر و سرِ کار کمتر.
 */
async function candidates(field: ArbField, d: Pick<Dispute, 'city' | 'province'>, partyUserIds: string[], skip: string[] = []): Promise<Candidate[]> {
  const who = ARB_FIELDS[field].who;
  const partyList = sql.join(partyUserIds.map((u) => sql`${u}::uuid`), sql`, `);
  const skipList = skip.length ? sql`and a.id not in (${sql.join(skip.map((s) => sql`${s}::uuid`), sql`, `)})` : sql``;
  const { rows } = await db.execute<Candidate & { busy: number }>(sql`
    select a.id, a.user_id as "userId", a.profile_id as "profileId", p.city, p.province, a.rating_avg as "ratingAvg",
      (select count(*)::int from ${arbitrationCases} c where c.arbiter_id = a.id and c.status in ('offered', 'assigned')) as busy
    from ${arbiters} a
    join ${profiles} p on p.id = a.profile_id
    join ${users} u on u.id = a.user_id
    where a.status = 'approved' and u.status = 'active' and p.role = ${who}
      and ${field} = any(a.fields)
      and a.user_id not in (${partyList})
      ${skipList}
      and (a.range <> 'city' or p.city = ${d.city})
      and (a.range <> 'province' or p.province = ${d.province})
      and not exists (
        select 1 from conversation_members m1 join conversation_members m2 on m2.conversation_id = m1.conversation_id
        where m1.user_id = a.user_id and m2.user_id in (${partyList}))
      and not exists (
        select 1 from ${projects} pr
        join ${profiles} x on x.id in (pr.client_profile_id, pr.provider_profile_id)
        join ${profiles} y on y.id in (pr.client_profile_id, pr.provider_profile_id)
        where x.user_id = a.user_id and y.user_id in (${partyList}))
    order by (p.city = ${d.city}) desc, (p.province = ${d.province}) desc, busy asc, a.rating_avg desc, a.cases_done desc
    limit 20`);
  return rows;
}

const travelOf = (c: Candidate | undefined, d: Pick<Dispute, 'city' | 'province'>): TravelKind =>
  !c ? 'far' : c.city === d.city ? 'city' : c.province === d.province ? 'prov' : 'far';

/* ================= پرونده از دید یکی از دو طرف ================= */

async function disputeFor(userId: string, id: string) {
  const [d] = await db.select().from(disputes).where(eq(disputes.id, id)).limit(1);
  if (!d) throw notFound('پرونده پیدا نشد');
  const v = await projectFor(userId, d.projectId); // غیرِ طرفین: «پیدا نشد»
  const mine = d.openedByProfileId === v.me.id;
  return { d, v, mine };
}
type DView = Awaited<ReturnType<typeof disputeFor>>;

async function casesOf(disputeId: string) {
  return db.select().from(arbitrationCases).where(eq(arbitrationCases.disputeId, disputeId)).orderBy(arbitrationCases.round, arbitrationCases.createdAt);
}
const activeCase = (cs: Case[]) => [...cs].reverse().find((c) => (LIVE_CASE as readonly string[]).includes(c.status));

function stageOf(d: Dispute, cs: Case[]) {
  if (d.status === 'settled' || d.status === 'decided' || d.status === 'cancelled') return 4;
  const c = activeCase(cs);
  if (!c) return 1;
  if (c.status === 'reported' || c.status === 'appealed' || (c.round === 2 && c.status !== 'final')) return 3;
  return 2;
}

async function arbiterCard(arbiterId: string | null) {
  if (!arbiterId) return null;
  const [r] = await db
    .select({ a: arbiters, p: profiles })
    .from(arbiters)
    .innerJoin(profiles, eq(profiles.id, arbiters.profileId))
    .where(eq(arbiters.id, arbiterId))
    .limit(1);
  if (!r) return null;
  return {
    code: r.p.code,
    name: r.p.displayName,
    role: r.p.role,
    title: r.p.title,
    city: r.p.city,
    avatarUrl: publicFileUrl(r.p.avatarFileId),
    rating: Math.round(r.a.ratingAvg * 10) / 10,
    casesDone: r.a.casesDone,
  };
}

async function shapeCase(c: Case, viewerProfileId: string | null, forArbiter = false) {
  // حل‌کننده تا قبول نکرده به طرفین معرفی نمی‌شود
  const showArbiter = forArbiter || ['assigned', 'reported', 'appealed', 'final'].includes(c.status);
  return {
    id: c.id,
    round: c.round,
    status: c.status,
    field: c.field,
    fieldName: ARB_FIELDS[c.field as ArbField]?.name ?? c.field,
    amountMillion: c.amountMillion,
    multi: c.multi,
    fee: c.fee,
    travel: c.travel,
    travelKind: c.travelKind,
    commissionPct: c.commissionPct,
    commission: c.commission,
    arbiterShare: c.arbiterShare,
    total: c.total,
    paymentStatus: c.paymentStatus,
    paidByMe: !!viewerProfileId && c.payerProfileId === viewerProfileId,
    arbiter: showArbiter ? await arbiterCard(c.arbiterId) : null,
    visitText: c.visitText,
    report: c.report,
    photos: c.photoFileIds.map((id) => fileUrl({ id, isPublic: false })),
    reportedAt: c.reportedAt,
    appealUntil: c.appealUntil,
    appealReason: c.appealReason,
    feeReturnDue: c.feeReturnDue,
    closedAt: c.closedAt,
    rejectUsed: !!viewerProfileId && c.partyRejects.includes(viewerProfileId),
    accepted: !!viewerProfileId && c.partyAccepts.includes(viewerProfileId),
  };
}

async function shapeDispute(dv: DView, cs?: Case[]) {
  const { d, v, mine } = dv;
  cs = cs ?? (await casesOf(d.id));
  const cur = activeCase(cs);
  const stage = stageOf(d, cs);
  const [rated] = cur
    ? await db
        .select({ r: arbiterRatings.rating })
        .from(arbiterRatings)
        .where(and(eq(arbiterRatings.caseId, cur.id), eq(arbiterRatings.fromProfileId, v.me.id)))
        .limit(1)
    : [];
  const open = d.status === 'open' || d.status === 'arbitration';
  return {
    id: d.id,
    projectId: d.projectId,
    projectTitle: v.p.title,
    mine,
    other: { code: v.other.code, name: v.other.name, role: v.other.role },
    reason: d.reason,
    ask: d.ask,
    description: d.description,
    city: d.city,
    province: d.province,
    status: d.status,
    stage,
    stageName: STAGES[stage],
    talkUntil: d.talkUntil,
    talkOver: d.talkUntil.getTime() <= Date.now(),
    case: cur ? await shapeCase(cur, v.me.id) : null,
    history: await Promise.all(cs.filter((c) => c !== cur).map((c) => shapeCase(c, v.me.id))),
    can: {
      settle: open && !(cur && cur.paymentStatus !== 'unpaid'),
      requestArbitration: open && mine && !cur && d.talkUntil.getTime() <= Date.now(),
      rejectArbiter: !!cur && cur.status === 'assigned' && !cur.partyRejects.includes(v.me.id),
      appeal: !!cur && cur.status === 'reported' && cur.round === 1 && !!cur.appealUntil && cur.appealUntil.getTime() > Date.now(),
      accept: !!cur && cur.status === 'reported' && !cur.partyAccepts.includes(v.me.id),
      rate: !!cur && (cur.status === 'final' || d.status === 'decided') && !!cur.arbiterId && !rated,
    },
    createdAt: d.createdAt,
  };
}

/* ================= طرفین: ثبت، توافق، درخواست حل‌کننده ================= */

export async function openDispute(userId: string, projectId: string, input: { reason: string; ask: string; description: string; city?: string }) {
  const v = await projectFor(userId, projectId);
  if (v.p.status === 'cancelled') throw conflict('این پروژه لغو شده است', 'PROJECT_CLOSED');
  const [busy] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.projectId, projectId), inArray(disputes.status, ['open', 'arbitration'])))
    .limit(1);
  if (busy) throw conflict('برای این پروژه یک پروندهٔ باز هست', 'DISPUTE_OPEN', { id: busy.id });
  const [me] = await db.select().from(profiles).where(eq(profiles.id, v.me.id)).limit(1);
  const [d] = await db
    .insert(disputes)
    .values({
      projectId,
      openedByProfileId: v.me.id,
      againstProfileId: v.other.id,
      reason: input.reason,
      ask: input.ask,
      description: normalizeFa(input.description),
      city: input.city ? normalizeFa(input.city) : me.city,
      province: me.province,
      talkUntil: hours(TALK_HOURS),
    })
    .returning();
  await projectSysMessage(v.p, `پروندهٔ اختلاف ثبت شد (${d.reason}). ۴۸ ساعت برای گفت‌وگو و توافق فرصت هست؛ بعد از آن داوری حضوری بلوک.`);
  await notify(v.other.userId, {
    type: 'req',
    title: 'پروندهٔ اختلاف برای پروژه ثبت شد',
    body: `${v.me.name}: ${d.reason} — ۴۸ ساعت برای گفت‌وگو فرصت دارید`,
    link: { screen: 'disp', id: d.id },
  });
  return shapeDispute({ d, v, mine: true }, []);
}

export async function listDisputes(userId: string) {
  await finalizeExpired();
  const mine = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId));
  const rows = await db
    .select()
    .from(disputes)
    .where(or(inArray(disputes.openedByProfileId, mine), inArray(disputes.againstProfileId, mine)))
    .orderBy(desc(disputes.createdAt))
    .limit(50);
  return Promise.all(
    rows.map(async (d) => {
      const v = await projectFor(userId, d.projectId);
      return shapeDispute({ d, v, mine: d.openedByProfileId === v.me.id });
    }),
  );
}

export async function getDispute(userId: string, id: string) {
  await finalizeExpired();
  return shapeDispute(await disputeFor(userId, id));
}

export async function settleDispute(userId: string, id: string) {
  const dv = await disputeFor(userId, id);
  const { d, v } = dv;
  if (d.status !== 'open' && d.status !== 'arbitration') throw conflict('این پرونده بسته شده است', 'DISPUTE_CLOSED');
  const cs = await casesOf(id);
  const cur = activeCase(cs);
  if (cur && cur.paymentStatus !== 'unpaid') throw conflict('هزینهٔ داوری پرداخت شده؛ پرونده با رأی حل‌کننده بسته می‌شود', 'ARB_IN_PROGRESS');
  await db.transaction(async (tx) => {
    if (cur) await tx.update(arbitrationCases).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(arbitrationCases.id, cur.id));
    await tx.update(disputes).set({ status: 'settled', settledAt: new Date(), updatedAt: new Date() }).where(eq(disputes.id, id));
  });
  await projectSysMessage(v.p, 'پروندهٔ اختلاف با توافق دو طرف بسته شد.');
  await notify(v.other.userId, { type: 'req', title: 'پروندهٔ اختلاف با توافق بسته شد', body: v.p.title, link: { screen: 'disp', id } });
  return getDispute(userId, id);
}

/** پیش‌نمایش هزینه (همان محاسبهٔ برگهٔ «درخواست حل‌کنندهٔ حضوری») */
export async function quote(userId: string, id: string, input: { field: ArbField; amountMillion: number; multi: boolean }) {
  const { d, v } = await disputeFor(userId, id);
  const cands = await candidates(input.field, d, [v.client.userId, v.provider.userId]);
  return { ...arbFee(input, travelOf(cands[0], d)), available: cands.length };
}

export async function requestArbitration(userId: string, id: string, input: { field: ArbField; amountMillion: number; multi: boolean }) {
  const dv = await disputeFor(userId, id);
  const { d, v, mine } = dv;
  if (!mine) throw forbidden('درخواست حل‌کننده با ثبت‌کنندهٔ اختلاف است', 'OPENER_ONLY');
  if (d.status !== 'open') throw conflict('این پرونده باز نیست', 'DISPUTE_CLOSED');
  if (d.talkUntil.getTime() > Date.now()) {
    const h = Math.ceil((d.talkUntil.getTime() - Date.now()) / 3600_000);
    throw conflict(`تا پایان مهلت گفت‌وگو ${faNum(h)} ساعت مانده؛ اول در چت تلاش کنید`, 'TALK_WINDOW', { hoursLeft: h });
  }
  if (activeCase(await casesOf(id))) throw conflict('برای این پرونده درخواست داوری ثبت شده است', 'ARB_EXISTS');
  const cands = await candidates(input.field, d, [v.client.userId, v.provider.userId]);
  const q = arbFee(input, travelOf(cands[0], d));
  const [c] = await db.transaction(async (tx) => {
    const row = await tx
      .insert(arbitrationCases)
      .values({
        disputeId: id,
        round: 1,
        payerProfileId: v.me.id,
        field: q.field,
        amountMillion: q.amountMillion,
        multi: input.multi,
        fee: q.fee,
        travel: q.travel,
        travelKind: q.travelKind,
        commissionPct: q.commissionPct,
        commission: q.commission,
        arbiterShare: q.arbiterShare,
        total: q.total,
      })
      .returning();
    await tx.update(disputes).set({ status: 'arbitration', updatedAt: new Date() }).where(eq(disputes.id, id));
    return row;
  });
  await notify(v.other.userId, {
    type: 'req',
    title: 'درخواست داوری حضوری ثبت شد',
    body: `${ARB_FIELDS[q.field].name} · پس از پرداخت، یک حل‌کنندهٔ بی‌طرف تعیین می‌شود`,
    link: { screen: 'disp', id },
  });
  return { dispute: await getDispute(userId, id), payment: paymentInfo(c) };
}

function paymentInfo(c: Case) {
  return {
    caseId: c.id,
    amount: c.total,
    method: 'manual',
    // فعلاً پرداخت دستی (کارت/پشتیبانی) و تأیید ادمین؛ درگاه بانکی بعداً
    instructions: env.ARB_PAYMENT_INFO ?? 'برای پرداخت امانی با پشتیبانی بلوک در چت هماهنگ کن؛ پس از تأیید پرداخت، حل‌کننده تعیین می‌شود.',
  };
}

/* ---- انتخاب حل‌کننده ---- */

async function partiesOf(disputeId: string) {
  const [r] = await db
    .select({ d: disputes, p: projects })
    .from(disputes)
    .innerJoin(projects, eq(projects.id, disputes.projectId))
    .where(eq(disputes.id, disputeId))
    .limit(1);
  const ps = await db
    .select({ id: profiles.id, userId: profiles.userId, name: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.id, [r.p.clientProfileId, r.p.providerProfileId]));
  return { d: r.d, project: r.p, parties: ps };
}

/** پیشنهاد پرونده به بهترین حل‌کنندهٔ بی‌طرف؛ اگر کسی نبود، در صف «matching» می‌ماند تا ادمین دستی تعیین کند */
export async function matchCase(caseId: string) {
  const [c] = await db.select().from(arbitrationCases).where(eq(arbitrationCases.id, caseId)).limit(1);
  if (!c || c.status !== 'matching') return null;
  const { d, parties } = await partiesOf(c.disputeId);
  // در بازبینی، حل‌کنندهٔ دور اول کنار می‌رود
  const earlier = await db
    .select({ a: arbitrationCases.arbiterId })
    .from(arbitrationCases)
    .where(and(eq(arbitrationCases.disputeId, c.disputeId), ne(arbitrationCases.id, c.id)));
  const skip = [...c.skipArbiterIds, ...earlier.map((x) => x.a).filter((x): x is string => !!x)];
  const [best] = await candidates(c.field as ArbField, d, parties.map((p) => p.userId), skip);
  if (!best) return null;
  return offerTo(c, best.id, d);
}

async function offerTo(c: Case, arbiterId: string, d: Dispute) {
  const [nc] = await db
    .update(arbitrationCases)
    .set({ status: 'offered', arbiterId, offeredAt: new Date(), updatedAt: new Date() })
    .where(and(eq(arbitrationCases.id, c.id), inArray(arbitrationCases.status, ['matching', 'offered'])))
    .returning();
  if (!nc) return null;
  const [a] = await db.select({ userId: arbiters.userId }).from(arbiters).where(eq(arbiters.id, arbiterId)).limit(1);
  await notify(a.userId, {
    type: 'req',
    title: c.round === 2 ? 'پروندهٔ بازبینی داوری برای تو' : 'پروندهٔ داوری حضوری تازه',
    body: `${ARB_FIELDS[c.field as ArbField]?.name} · ${d.city} · سهم تو ${faNum(c.arbiterShare)} تومان`,
    link: { screen: 'arbj', id: c.id },
  });
  return nc;
}

export async function rejectArbiter(userId: string, id: string) {
  const { v } = await disputeFor(userId, id);
  const cur = activeCase(await casesOf(id));
  if (!cur || cur.status !== 'assigned' || !cur.arbiterId) throw conflict('الان حل‌کننده‌ای برای رد کردن نیست', 'NO_ARBITER');
  if (cur.partyRejects.includes(v.me.id)) throw conflict('حق رد حل‌کننده را قبلاً استفاده کرده‌ای', 'REJECT_USED');
  const old = cur.arbiterId;
  await db
    .update(arbitrationCases)
    .set({
      status: 'matching',
      arbiterId: null,
      visitText: null,
      acceptedAt: null,
      skipArbiterIds: sql`array_append(${arbitrationCases.skipArbiterIds}, ${old}::uuid)`,
      partyRejects: sql`array_append(${arbitrationCases.partyRejects}, ${v.me.id}::uuid)`,
      updatedAt: new Date(),
    })
    .where(eq(arbitrationCases.id, cur.id));
  const [a] = await db.select({ userId: arbiters.userId }).from(arbiters).where(eq(arbiters.id, old)).limit(1);
  if (a) await notify(a.userId, { type: 'req', title: 'یکی از طرفین حل‌کنندهٔ دیگری خواست', body: 'پرونده از فهرست تو برداشته شد', link: { screen: 'arbj' } });
  await notify(v.other.userId, { type: 'req', title: 'حل‌کنندهٔ تازه تعیین می‌شود', body: `${v.me.name} از حق رد استفاده کرد`, link: { screen: 'disp', id } });
  await matchCase(cur.id);
  return getDispute(userId, id);
}

/* ---- رأی: اعتراض، قبول، امتیاز ---- */

export async function appeal(userId: string, id: string, reason: string) {
  const { v } = await disputeFor(userId, id);
  const cs = await casesOf(id);
  const cur = activeCase(cs);
  if (!cur || cur.status !== 'reported' || cur.round !== 1) throw conflict('فقط به رأی دور اول و در مهلت ۷۲ ساعت می‌شود اعتراض کرد', 'NO_APPEAL');
  if (!cur.appealUntil || cur.appealUntil.getTime() <= Date.now()) throw conflict('مهلت اعتراض تمام شده است', 'APPEAL_EXPIRED');
  const f = appealFee(cur);
  await db.transaction(async (tx) => {
    const upd = await tx
      .update(arbitrationCases)
      .set({ status: 'appealed', appealReason: reason, updatedAt: new Date() })
      .where(and(eq(arbitrationCases.id, cur.id), eq(arbitrationCases.status, 'reported')))
      .returning({ id: arbitrationCases.id });
    if (!upd.length) throw conflict('وضعیت پرونده عوض شده؛ دوباره باز کن', 'NO_APPEAL');
    await tx.insert(arbitrationCases).values({
      disputeId: id,
      round: 2,
      payerProfileId: v.me.id,
      field: cur.field,
      amountMillion: cur.amountMillion,
      multi: cur.multi,
      ...f,
      appealReason: reason,
    });
  });
  await notify(v.other.userId, { type: 'req', title: 'به رأی داوری اعتراض شد', body: `${v.me.name}: ${reason.slice(0, 100)}`, link: { screen: 'disp', id } });
  const ac = activeCase(await casesOf(id))!;
  return { dispute: await getDispute(userId, id), payment: paymentInfo(ac) };
}

export async function acceptVerdict(userId: string, id: string) {
  const { v } = await disputeFor(userId, id);
  const cur = activeCase(await casesOf(id));
  if (!cur || cur.status !== 'reported') throw conflict('رأیی برای قبول کردن نیست', 'NO_VERDICT');
  if (cur.partyAccepts.includes(v.me.id)) return getDispute(userId, id);
  const [nc] = await db
    .update(arbitrationCases)
    .set({ partyAccepts: sql`array_append(${arbitrationCases.partyAccepts}, ${v.me.id}::uuid)`, updatedAt: new Date() })
    .where(eq(arbitrationCases.id, cur.id))
    .returning();
  // هر دو طرف قبول کردند ← لازم نیست تا پایان مهلت اعتراض صبر کنیم
  if (nc.partyAccepts.length >= 2) await finalizeCase(nc);
  else await notify(v.other.userId, { type: 'req', title: 'طرف مقابل رأی را قبول کرد', body: 'اگر تو هم قبول کنی، پرونده بسته می‌شود', link: { screen: 'disp', id } });
  return getDispute(userId, id);
}

export async function rateArbiter(userId: string, id: string, input: { rating: number; impartial: boolean }) {
  const { v, d } = await disputeFor(userId, id);
  if (d.status !== 'decided') throw conflict('امتیاز بعد از بسته شدن پرونده با رأی ثبت می‌شود', 'NOT_DECIDED');
  const cs = await casesOf(id);
  const last = [...cs].reverse().find((c) => c.status === 'final' && c.arbiterId);
  if (!last) throw conflict('حل‌کننده‌ای برای امتیاز نیست', 'NO_ARBITER');
  await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(arbiterRatings)
      .values({ caseId: last.id, fromProfileId: v.me.id, rating: input.rating, impartial: input.impartial })
      .onConflictDoNothing()
      .returning();
    if (!r) throw conflict('به این حل‌کننده قبلاً امتیاز داده‌ای', 'ALREADY_RATED');
    await tx
      .update(arbiters)
      .set({
        ratingAvg: sql`(${arbiters.ratingAvg} * ${arbiters.ratingCount} + ${input.rating}) / (${arbiters.ratingCount} + 1)`,
        ratingCount: sql`${arbiters.ratingCount} + 1`,
        impartialNo: input.impartial ? arbiters.impartialNo : sql`${arbiters.impartialNo} + 1`,
      })
      .where(eq(arbiters.id, last.arbiterId!));
  });
  return getDispute(userId, id);
}

/* ---- بستن پرونده و آزاد کردن سهم حل‌کننده ---- */

async function finalizeCase(c: Case) {
  const closed = await db.transaction(async (tx) => {
    const [nc] = await tx
      .update(arbitrationCases)
      .set({ status: 'final', closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(arbitrationCases.id, c.id), inArray(arbitrationCases.status, ['reported'])))
      .returning();
    if (!nc) return null;
    // پول امانی همهٔ دورهای این پرونده (داوری و بازبینی) برای حل‌کننده‌ها آزاد می‌شود
    const paid = await tx
      .update(arbitrationCases)
      .set({ paymentStatus: 'released', releasedAt: new Date() })
      .where(and(eq(arbitrationCases.disputeId, c.disputeId), eq(arbitrationCases.paymentStatus, 'paid'), inArray(arbitrationCases.status, ['final', 'appealed'])))
      .returning({ arbiterId: arbitrationCases.arbiterId });
    const ids = paid.map((x) => x.arbiterId).filter((x): x is string => !!x);
    if (ids.length) await tx.update(arbiters).set({ casesDone: sql`${arbiters.casesDone} + 1` }).where(inArray(arbiters.id, ids));
    await tx.update(disputes).set({ status: 'decided', decidedAt: new Date(), updatedAt: new Date() }).where(eq(disputes.id, c.disputeId));
    return nc;
  });
  if (!closed) return;
  const { project, parties } = await partiesOf(c.disputeId);
  await projectSysMessage(project, `پروندهٔ اختلاف با رأی حل‌کنندهٔ حضوری بسته شد: ${closed.report?.remedy ?? ''}`.trim());
  for (const p of parties) {
    await notify(p.userId, { type: 'req', title: 'پروندهٔ اختلاف با رأی بسته شد', body: closed.report?.remedy?.slice(0, 120), link: { screen: 'disp', id: c.disputeId } });
  }
}

/** رأی‌های دور اول که مهلت اعتراضشان گذشته ← نهایی (در sweeper ساعتی و هنگام خواندن پرونده‌ها) */
export async function finalizeExpired() {
  const due = await db
    .select()
    .from(arbitrationCases)
    .where(and(eq(arbitrationCases.status, 'reported'), eq(arbitrationCases.round, 1), lt(arbitrationCases.appealUntil, new Date())));
  for (const c of due) await finalizeCase(c);
  return due.length;
}

/* ================= سمت حل‌کننده (مهندس/متخصص) ================= */

async function myArbiterRow(userId: string) {
  const [a] = await db.select().from(arbiters).where(eq(arbiters.userId, userId)).orderBy(desc(arbiters.createdAt)).limit(1);
  return a ?? null;
}

export async function arbiterHome(user: User, profile: Profile | undefined) {
  const a = await myArbiterRow(user.id);
  const [p] = a ? await db.select().from(profiles).where(eq(profiles.id, a.profileId)).limit(1) : [profile];
  const role = p?.role;
  const exp = (p?.data?.exp as string | undefined) ?? '';
  const years = { 'کمتر از ۱ سال': 1, '۱ تا ۳ سال': 2, '۳ تا ۵ سال': 4, '۵ تا ۱۰ سال': 7, 'بیش از ۱۰ سال': 12 }[exp] ?? (role === 'engineer' ? 5 : 0);
  const trust = p ? Math.round((p.ratingAvg / 5) * 55) + Math.min(25, p.doneCount) + Math.min(10, Math.round(p.ratingCount / 2)) + (user.kycStatus === 'verified' ? 10 : 0) : 0;
  const checklist = [
    { key: 'role', label: 'نقش مهندس یا متخصص', ok: role === 'engineer' || role === 'specialist' },
    { key: 'exp', label: 'حداقل ۵ سال سابقه', ok: years >= 5 },
    { key: 'trust', label: `امتیاز بلوک ۸۰ به بالا (${trust})`, ok: trust >= 80 },
    { key: 'kyc', label: 'هویت تأییدشده', ok: user.kycStatus === 'verified' },
  ];
  let stats = null;
  if (a) {
    const [s] = await db
      .select({
        done: sql<number>`count(*) filter (where ${arbitrationCases.status} in ('final', 'appealed'))::int`,
        active: sql<number>`count(*) filter (where ${arbitrationCases.status} in ('offered', 'assigned', 'reported'))::int`,
        released: sql<number>`coalesce(sum(${arbitrationCases.arbiterShare}) filter (where ${arbitrationCases.paymentStatus} = 'released'), 0)::bigint`,
        pending: sql<number>`coalesce(sum(${arbitrationCases.arbiterShare}) filter (where ${arbitrationCases.paymentStatus} = 'paid' and ${arbitrationCases.status} in ('assigned', 'reported', 'appealed')), 0)::bigint`,
      })
      .from(arbitrationCases)
      .where(eq(arbitrationCases.arbiterId, a.id));
    stats = { done: s.done, active: s.active, earned: Number(s.released), pending: Number(s.pending) };
  }
  return {
    arbiter: a && {
      id: a.id,
      status: a.status,
      fields: a.fields,
      range: a.range,
      rejectReason: a.rejectReason,
      rating: Math.round(a.ratingAvg * 10) / 10,
      ratingCount: a.ratingCount,
      casesDone: a.casesDone,
      createdAt: a.createdAt,
    },
    allowedFields: role ? fieldsForRole(role).map((k) => ({ key: k, name: ARB_FIELDS[k].name, examples: ARB_FIELDS[k].examples })) : [],
    checklist,
    stats,
  };
}

export async function applyArbiter(user: User, profile: Profile, file: { buffer: Buffer; originalname?: string }, input: { fields: string[]; range: 'city' | 'province' | 'neighbors' }) {
  if (profile.role !== 'engineer' && profile.role !== 'specialist') throw forbidden('حل‌کنندهٔ حضوری فقط مهندس یا متخصص است؛ نقش فعالت را عوض کن', 'ROLE_NOT_ALLOWED');
  const allowed = fieldsForRole(profile.role);
  const bad = input.fields.filter((f) => !(allowed as string[]).includes(f));
  if (bad.length || !input.fields.length) throw badRequest(`حوزه‌های مجاز برای نقش تو: ${allowed.map((k) => ARB_FIELDS[k].name).join('، ')}`, 'BAD_FIELDS');
  const cur = await myArbiterRow(user.id);
  if (cur && (cur.status === 'pending' || cur.status === 'approved')) throw conflict(cur.status === 'pending' ? 'درخواستت در حال بررسی است' : 'تو حل‌کنندهٔ تأییدشده هستی', 'ARBITER_EXISTS');
  if (cur && cur.status === 'suspended') throw forbidden('همکاری تو به‌عنوان حل‌کننده متوقف شده؛ با پشتیبانی تماس بگیر', 'ARBITER_SUSPENDED');
  const f = await saveUpload(user.id, 'document', file);
  try {
    const values = { userId: user.id, profileId: profile.id, fields: [...new Set(input.fields)], range: input.range, docFileId: f.id, pledgedAt: new Date(), status: 'pending' as const, rejectReason: null, reviewedAt: null, reviewedBy: null, updatedAt: new Date() };
    // درخواست ردشدهٔ قبلی به‌روز می‌شود (یک ردیف برای هر پروفایل)
    const [a] = await db
      .insert(arbiters)
      .values(values)
      .onConflictDoUpdate({ target: arbiters.profileId, set: values })
      .returning();
    if (cur?.docFileId && cur.docFileId !== f.id) await purgeFiles([cur.docFileId]);
    return a;
  } catch (e) {
    await purgeFiles([f.id]);
    throw e;
  }
}

async function jobFor(userId: string, caseId: string) {
  const a = await myArbiterRow(userId);
  const [c] = await db.select().from(arbitrationCases).where(eq(arbitrationCases.id, caseId)).limit(1);
  if (!a || !c || c.arbiterId !== a.id) throw notFound('پرونده پیدا نشد');
  const { d, project, parties } = await partiesOf(c.disputeId);
  return { a, c, d, project, parties };
}

async function shapeJob(c: Case) {
  const { d, project, parties } = await partiesOf(c.disputeId);
  const [opener] = parties.filter((p) => p.id === d.openedByProfileId);
  const base = await shapeCase(c, null, true);
  return {
    ...base,
    dispute: {
      id: d.id,
      projectTitle: project.title,
      reason: d.reason,
      ask: d.ask,
      description: d.description,
      city: d.city,
      province: d.province,
      // طرفین فقط بعد از قبول پرونده معرفی می‌شوند (برای بی‌طرفی کافی است بدانی کیستند)
      parties: parties.map((p) => ({ name: p.name, opener: p.id === opener?.id })),
    },
    can: {
      accept: c.status === 'offered',
      decline: c.status === 'offered' || c.status === 'assigned',
      report: c.status === 'assigned',
    },
  };
}

export async function myJobs(userId: string) {
  const a = await myArbiterRow(userId);
  if (!a) return [];
  const rows = await db
    .select()
    .from(arbitrationCases)
    .where(and(eq(arbitrationCases.arbiterId, a.id), notInArray(arbitrationCases.status, ['cancelled'])))
    .orderBy(desc(arbitrationCases.updatedAt))
    .limit(100);
  return Promise.all(rows.map(shapeJob));
}

export async function acceptJob(userId: string, caseId: string, visitText: string) {
  const { c, d, parties } = await jobFor(userId, caseId);
  if (c.status !== 'offered') throw conflict('این پرونده منتظر قبول تو نیست', 'NOT_OFFERED');
  await db
    .update(arbitrationCases)
    .set({ status: 'assigned', acceptedAt: new Date(), visitText: normalizeFa(visitText), updatedAt: new Date() })
    .where(and(eq(arbitrationCases.id, caseId), eq(arbitrationCases.status, 'offered')));
  const card = await arbiterCard(c.arbiterId);
  for (const p of parties) {
    await notify(p.userId, {
      type: 'req',
      title: 'حل‌کنندهٔ حضوری تعیین شد',
      body: `${card?.name} — بازدید: ${visitText}`,
      link: { screen: 'disp', id: d.id },
    });
  }
  const [nc] = await db.select().from(arbitrationCases).where(eq(arbitrationCases.id, caseId)).limit(1);
  return shapeJob(nc);
}

export async function declineJob(userId: string, caseId: string) {
  const { a, c } = await jobFor(userId, caseId);
  if (c.status !== 'offered' && c.status !== 'assigned') throw conflict('این پرونده دیگر قابل رد نیست', 'NOT_OFFERED');
  await db
    .update(arbitrationCases)
    .set({
      status: 'matching',
      arbiterId: null,
      visitText: null,
      acceptedAt: null,
      skipArbiterIds: sql`array_append(${arbitrationCases.skipArbiterIds}, ${a.id}::uuid)`,
      updatedAt: new Date(),
    })
    .where(eq(arbitrationCases.id, caseId));
  await matchCase(caseId);
  return { ok: true };
}

export async function submitReport(
  userId: string,
  caseId: string,
  photos: { buffer: Buffer; originalname?: string }[],
  input: { measure: string; compare: string; verdict: string; remedy: string; upholds?: boolean },
) {
  const { c, d, project, parties } = await jobFor(userId, caseId);
  if (c.status !== 'assigned') throw conflict('گزارش بعد از قبول پرونده و بازدید ثبت می‌شود', 'NOT_ASSIGNED');
  if (photos.length < 3) throw badRequest('حداقل ۳ عکس از محل لازم است', 'PHOTOS_REQUIRED');
  if (c.round === 2 && input.upholds === undefined) throw badRequest('در بازبینی بگو رأی قبلی تأیید می‌شود یا نه', 'UPHOLDS_REQUIRED');
  const saved: string[] = [];
  try {
    for (const f of photos) saved.push((await saveUpload(userId, 'arbitration', f, { projectId: project.id })).id);
    const report: ArbReport = {
      measure: normalizeFa(input.measure),
      compare: input.compare,
      verdict: input.verdict,
      remedy: normalizeFa(input.remedy),
      ...(c.round === 2 ? { upholds: !!input.upholds } : {}),
    };
    const [nc] = await db
      .update(arbitrationCases)
      .set({
        status: 'reported',
        report,
        photoFileIds: saved,
        reportedAt: new Date(),
        appealUntil: c.round === 1 ? hours(APPEAL_HOURS) : null,
        feeReturnDue: c.round === 2 && !input.upholds,
        updatedAt: new Date(),
      })
      .where(and(eq(arbitrationCases.id, caseId), eq(arbitrationCases.status, 'assigned')))
      .returning();
    if (!nc) throw conflict('گزارش این پرونده قبلاً ثبت شده', 'NOT_ASSIGNED');
    for (const p of parties) {
      await notify(p.userId, {
        type: 'req',
        title: c.round === 2 ? 'رأی بازبینی ثبت شد (نهایی)' : 'گزارش و رأی حل‌کننده ثبت شد',
        body: c.round === 2 ? report.remedy.slice(0, 120) : `${report.verdict} — ۷۲ ساعت مهلت اعتراض`,
        link: { screen: 'disp', id: d.id },
      });
    }
    // رأی بازبینی نهایی است
    if (c.round === 2) await finalizeCase(nc);
    emitTo(parties.map((p) => p.userId), { type: 'project', data: { projectId: project.id, disputeId: d.id } });
    const [fresh] = await db.select().from(arbitrationCases).where(eq(arbitrationCases.id, caseId)).limit(1);
    return shapeJob(fresh);
  } catch (e) {
    await purgeFiles(saved);
    throw e;
  }
}

/* ================= ادمین ================= */

export async function adminListArbiters(status: 'pending' | 'approved' | 'rejected' | 'suspended') {
  const rows = await db
    .select({ a: arbiters, p: profiles, u: users })
    .from(arbiters)
    .innerJoin(profiles, eq(profiles.id, arbiters.profileId))
    .innerJoin(users, eq(users.id, arbiters.userId))
    .where(eq(arbiters.status, status))
    .orderBy(status === 'pending' ? arbiters.createdAt : desc(arbiters.updatedAt))
    .limit(100);
  return rows.map(({ a, p, u }) => ({
    id: a.id,
    status: a.status,
    fields: a.fields.map((k) => ({ key: k, name: ARB_FIELDS[k as ArbField]?.name ?? k })),
    range: a.range,
    docUrl: a.docFileId ? fileUrl({ id: a.docFileId, isPublic: false }) : null,
    profile: { code: p.code, role: p.role, name: p.displayName, city: p.city, province: p.province, rating: p.ratingAvg, doneCount: p.doneCount, verified: p.verified },
    user: { id: u.id, phone: u.phone, kycStatus: u.kycStatus },
    rating: a.ratingAvg,
    ratingCount: a.ratingCount,
    impartialNo: a.impartialNo,
    casesDone: a.casesDone,
    rejectReason: a.rejectReason,
    createdAt: a.createdAt,
  }));
}

export async function adminReviewArbiter(admin: User, id: string, action: 'approve' | 'reject' | 'suspend', reason?: string) {
  const [a] = await db.select().from(arbiters).where(eq(arbiters.id, id)).limit(1);
  if (!a) throw notFound('درخواست پیدا نشد');
  const status = ({ approve: 'approved', reject: 'rejected', suspend: 'suspended' } as const)[action];
  if (action === 'approve' && a.status === 'approved') throw conflict('قبلاً تأیید شده', 'ALREADY_APPROVED');
  await db.transaction(async (tx) => {
    await tx
      .update(arbiters)
      .set({ status, rejectReason: action === 'approve' ? null : reason ?? null, reviewedBy: admin.id, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(arbiters.id, id));
    await adminLog(tx, admin, `arbiter.${action}`, 'arbiter', id, reason);
  });
  await notify(a.userId, {
    type: 'id',
    title: { approve: 'حل‌کنندهٔ حضوری بلوک شدی', reject: 'درخواست حل‌کنندگی تأیید نشد', suspend: 'همکاری داوری متوقف شد' }[action],
    body: action === 'approve' ? 'پرونده‌های حوزهٔ تو از این به بعد برایت فرستاده می‌شود' : reason,
    link: { screen: 'arbj' },
  });
  // پرونده‌هایی که منتظر حل‌کننده مانده بودند
  if (action === 'approve') {
    const waiting = await db.select({ id: arbitrationCases.id }).from(arbitrationCases).where(eq(arbitrationCases.status, 'matching'));
    for (const w of waiting) await matchCase(w.id);
  }
}

export async function adminListCases(status?: string) {
  const rows = await db
    .select({ c: arbitrationCases, d: disputes, p: projects })
    .from(arbitrationCases)
    .innerJoin(disputes, eq(disputes.id, arbitrationCases.disputeId))
    .innerJoin(projects, eq(projects.id, disputes.projectId))
    .where(status ? eq(arbitrationCases.status, status as Case['status']) : undefined)
    .orderBy(desc(arbitrationCases.updatedAt))
    .limit(100);
  return Promise.all(
    rows.map(async ({ c, d, p }) => ({
      ...(await shapeCase(c, null, true)),
      paymentRef: c.paymentRef,
      paidAt: c.paidAt,
      refundReason: c.refundReason,
      dispute: { id: d.id, reason: d.reason, ask: d.ask, description: d.description, city: d.city, status: d.status, projectTitle: p.title },
    })),
  );
}

async function adminCase(id: string) {
  const [c] = await db.select().from(arbitrationCases).where(eq(arbitrationCases.id, id)).limit(1);
  if (!c) throw notFound('پرونده پیدا نشد');
  return c;
}

/** تأیید پرداخت امانی (دستی) ← پیدا کردن حل‌کننده */
export async function adminConfirmPayment(admin: User, id: string, ref: string) {
  const c = await adminCase(id);
  if (c.status !== 'awaiting_payment' || c.paymentStatus !== 'unpaid') throw conflict('این پرونده منتظر پرداخت نیست', 'NOT_AWAITING_PAYMENT');
  await db.transaction(async (tx) => {
    await tx
      .update(arbitrationCases)
      .set({ status: 'matching', paymentStatus: 'paid', paymentRef: ref, paidAt: new Date(), updatedAt: new Date() })
      .where(eq(arbitrationCases.id, id));
    await adminLog(tx, admin, 'arbitration.paid', 'arbitration', id, `${faNum(c.total)} تومان · ${ref}`);
  });
  const { parties } = await partiesOf(c.disputeId);
  const payer = parties.find((p) => p.id === c.payerProfileId);
  if (payer) await notify(payer.userId, { type: 'req', title: 'پرداخت امانی تأیید شد', body: 'دنبال حل‌کنندهٔ بی‌طرف می‌گردیم', link: { screen: 'disp', id: c.disputeId } });
  const offered = await matchCase(id);
  return { matched: !!offered };
}

export async function adminAssign(admin: User, id: string, arbiterId: string) {
  const c = await adminCase(id);
  if (c.status !== 'matching' && c.status !== 'offered') throw conflict('این پرونده منتظر حل‌کننده نیست', 'NOT_MATCHING');
  const [a] = await db.select().from(arbiters).where(and(eq(arbiters.id, arbiterId), eq(arbiters.status, 'approved'))).limit(1);
  if (!a) throw notFound('حل‌کنندهٔ تأییدشده پیدا نشد');
  const { d, parties } = await partiesOf(c.disputeId);
  if (parties.some((p) => p.userId === a.userId)) throw badRequest('حل‌کننده نمی‌تواند یکی از طرفین باشد', 'NOT_IMPARTIAL');
  await offerTo({ ...c, status: 'matching' }, arbiterId, d);
  await adminLog(db, admin, 'arbitration.assign', 'arbitration', id, arbiterId);
  return { ok: true };
}

/** حل‌کننده نیامد یا پرونده پیش از رأی لغو شد ← کل مبلغ برمی‌گردد؛ ثبت‌کننده می‌تواند دوباره درخواست بدهد */
export async function adminRefund(admin: User, id: string, reason: string) {
  const c = await adminCase(id);
  if (c.paymentStatus !== 'paid' || !['matching', 'offered', 'assigned'].includes(c.status)) {
    throw conflict('فقط پرداختِ پرونده‌ای که هنوز رأی ندارد برمی‌گردد', 'NOT_REFUNDABLE');
  }
  await db.transaction(async (tx) => {
    await tx
      .update(arbitrationCases)
      .set({ status: 'refunded', paymentStatus: 'refunded', refundedAt: new Date(), refundReason: reason, updatedAt: new Date() })
      .where(eq(arbitrationCases.id, id));
    // دور اول برگشت ← پرونده دوباره «باز»؛ بازبینی برگشت ← رأی دور اول دوباره قابل قبول/نهایی
    if (c.round === 1) await tx.update(disputes).set({ status: 'open', updatedAt: new Date() }).where(eq(disputes.id, c.disputeId));
    else
      await tx
        .update(arbitrationCases)
        .set({ status: 'reported', appealUntil: new Date(), updatedAt: new Date() })
        .where(and(eq(arbitrationCases.disputeId, c.disputeId), eq(arbitrationCases.round, 1), eq(arbitrationCases.status, 'appealed')));
    await adminLog(tx, admin, 'arbitration.refund', 'arbitration', id, reason);
  });
  const { parties } = await partiesOf(c.disputeId);
  for (const p of parties) await notify(p.userId, { type: 'req', title: 'هزینهٔ داوری برگشت داده شد', body: reason, link: { screen: 'disp', id: c.disputeId } });
  if (c.round === 2) await finalizeExpired();
  return { ok: true };
}

export async function arbitrationStats() {
  const [s] = await db
    .select({
      unpaid: sql<number>`count(*) filter (where ${arbitrationCases.status} = 'awaiting_payment')::int`,
      matching: sql<number>`count(*) filter (where ${arbitrationCases.status} = 'matching')::int`,
    })
    .from(arbitrationCases);
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(arbiters).where(eq(arbiters.status, 'pending'));
  return { arbitersPending: a.n, casesAwaitingPayment: s.unpaid, casesWithoutArbiter: s.matching };
}

