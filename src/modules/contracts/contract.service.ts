import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { contracts, contractSignatures, projects, users, type ContractTerms, type Milestone } from '../../db/schema';
import { sha256 } from '../../lib/crypto';
import { badRequest, conflict, forbidden } from '../../lib/errors';
import { emitTo } from '../../lib/events';
import { apiUrl, signedQuery } from '../../lib/signed';
import { consumeCode, sendOtp } from '../auth/auth.service';
import { notify } from '../notifications/notify';
import { ROLE_INFO } from '../roles/forms';
import { assertActive, projectFor, projectSysMessage, type Party, type Project } from '../projects/access';

type Contract = typeof contracts.$inferSelect;
type Signature = typeof contractSignatures.$inferSelect;
type View = Awaited<ReturnType<typeof projectFor>>;

/* ---------- ابزار ---------- */

const TZ = 'Asia/Tehran';
export const faDate = (d: Date) =>
  new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ }).format(d);
const jalaliYear = (d: Date) =>
  new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { year: 'numeric', timeZone: TZ }).formatToParts(d).find((p) => p.type === 'year')!.value;
export const faNum = (n: number) => n.toLocaleString('fa-IR');

/** JSON با ترتیب ثابت کلیدها (jsonb ترتیب را عوض می‌کند؛ هش باید پایدار باشد) */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
export const hashTerms = (t: ContractTerms) => sha256(canonicalJson(t));

/* ---------- متن قرارداد ---------- */

type Settings = {
  milestones: Milestone[];
  durationDays: number;
  retentionPct: number;
  retentionMonths: number;
  delayPenaltyPct: number;
  extraClauses: string[];
};

function partyTerms(p: Party, kyc: boolean) {
  return { name: p.name, code: p.code, role: ROLE_INFO[p.role as keyof typeof ROLE_INFO]?.name ?? p.role, identityVerified: kyc };
}

export function buildTerms(p: Project, client: Party, provider: Party, kyc: { client: boolean; provider: boolean }, s: Settings, number: string, date: Date): ContractTerms {
  const c = partyTerms(client, kyc.client);
  const v = partyTerms(provider, kyc.provider);
  const who = (x: typeof c) => `${x.name} (${x.role}، شناسهٔ ${x.code}${x.identityVerified ? '، هویت تأییدشده' : ''})`;
  const total = p.amount ? `${faNum(p.amount)} تومان` : p.priceText;
  const ms = s.milestones
    .map((m, i) => `${faNum(i + 1)}) ${m.title}: ${faNum(m.pct)}٪${p.amount ? ` (${faNum(Math.round((p.amount * m.pct) / 100))} تومان)` : ''}`)
    .join('\n');

  const clauses = [
    { title: 'طرفین', text: `کارفرما: ${who(c)}\nمجری: ${who(v)}\nکه هر دو با شمارهٔ موبایل تأییدشده در بلوک شناخته می‌شوند.` },
    {
      title: 'موضوع',
      text: [
        `${p.title}، مطابق توافق ثبت‌شده در گفت‌وگوی بلوک.`,
        p.quantity ? `مقدار: ${p.quantity}` : null,
        `دستمزد: ${p.priceText}`,
        p.startText ? `شروع: ${p.startText}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    { title: 'مبلغ و پرداخت', text: `مبلغ کل: ${total}، در ${faNum(s.milestones.length)} مرحله:\n${ms}` },
    {
      title: 'مدت',
      text: `${faNum(s.durationDays)} روز از تاریخ شروع کار.${s.delayPenaltyPct > 0 ? ` هر روز تأخیر غیرموجه، ${faNum(s.delayPenaltyPct)}٪ از مبلغ مرحلهٔ جاری کسر می‌شود.` : ''}`,
    },
    {
      title: 'تضمین',
      text:
        s.retentionPct > 0
          ? `${faNum(s.retentionPct)}٪ از مبلغ کل به‌عنوان حسن انجام کار نزد کارفرما می‌ماند و ${faNum(s.retentionMonths)} ماه پس از تحویل پرداخت می‌شود.`
          : 'مبلغی به‌عنوان حسن انجام کار کسر نمی‌شود.',
    },
    { title: 'بیمه و ایمنی', text: 'ایمنی کارگاه و بیمهٔ نیروهای مجری بر عهدهٔ مجری است؛ استفاده از تجهیزات حفاظت فردی الزامی است.' },
    {
      title: 'اختلاف',
      text: 'در صورت اختلاف، ابتدا داوری بلوک با حضور یک مهندس ناظر مستقل انجام می‌شود و در صورت عدم توافق، مراجع قانونی صالح‌اند. بلوک طرف این قرارداد و واسطهٔ مالی نیست.',
    },
    ...s.extraClauses.map((text, i) => ({ title: `شرایط خاص ${faNum(i + 1)}`, text })),
  ];

  return {
    number,
    dateFa: faDate(date),
    title: p.title,
    client: c,
    provider: v,
    quantity: p.quantity,
    priceText: p.priceText,
    amount: p.amount,
    startText: p.startText,
    durationDays: s.durationDays,
    milestones: s.milestones,
    retentionPct: s.retentionPct,
    retentionMonths: s.retentionMonths,
    delayPenaltyPct: s.delayPenaltyPct,
    extraClauses: s.extraClauses,
    clauses,
  };
}

const settingsOf = (t: ContractTerms): Settings => ({
  milestones: t.milestones,
  durationDays: t.durationDays,
  retentionPct: t.retentionPct,
  retentionMonths: t.retentionMonths,
  delayPenaltyPct: t.delayPenaltyPct,
  extraClauses: t.extraClauses,
});

async function kycOf(v: View) {
  const rows = await db
    .select({ id: users.id, kyc: users.kycStatus })
    .from(users)
    .where(sql`${users.id} in (${v.client.userId}, ${v.provider.userId})`);
  const ok = (id: string) => rows.find((r) => r.id === id)?.kyc === 'verified';
  return { client: ok(v.client.userId), provider: ok(v.provider.userId) };
}

/* ---------- خواندن / ساختن ---------- */

async function signaturesOf(c: Contract) {
  return db
    .select()
    .from(contractSignatures)
    .where(and(eq(contractSignatures.contractId, c.id), eq(contractSignatures.version, c.version)));
}

function shape(c: Contract, sigs: Signature[], v: View) {
  const mine = sigs.find((s) => s.side === v.side);
  const theirs = sigs.find((s) => s.side !== v.side);
  const open = v.p.status === 'active' && (c.status === 'draft' || c.status === 'signing');
  const sig = (s?: Signature) => (s ? { signedAt: s.signedAt, signedAtFa: faDate(s.signedAt) } : null);
  return {
    id: c.id,
    number: c.number,
    version: c.version,
    status: c.status,
    statusName: { draft: 'پیش‌نویس', signing: 'منتظر امضای طرف مقابل', active: 'امضا شد و فعال است', void: 'باطل' }[c.status],
    contentHash: c.contentHash,
    terms: c.terms,
    mySide: v.side,
    signatures: { client: sig(sigs.find((s) => s.side === 'client')), provider: sig(sigs.find((s) => s.side === 'provider')) },
    activatedAt: c.activatedAt,
    can: { edit: open, sign: open && !mine, remind: open && !!mine && !theirs },
    printUrl: apiUrl(`/api/contracts/${c.id}/print?${signedQuery('contract', c.id)}`),
  };
}

async function ensureContract(v: View): Promise<Contract> {
  const [existing] = await db.select().from(contracts).where(eq(contracts.projectId, v.p.id)).limit(1);
  const kyc = await kycOf(v);
  if (existing) {
    // تا کسی امضا نکرده، نام‌ها و وضعیت احراز هویت تازه نگه داشته می‌شود
    if (existing.status === 'draft' && v.p.status === 'active') {
      const terms = buildTerms(v.p, v.client, v.provider, kyc, settingsOf(existing.terms), existing.number, existing.createdAt);
      const hash = hashTerms(terms);
      if (hash !== existing.contentHash) {
        const [c] = await db.update(contracts).set({ terms, contentHash: hash, updatedAt: new Date() }).where(eq(contracts.id, existing.id)).returning();
        return c;
      }
    }
    return existing;
  }
  assertActive(v.p);
  const now = new Date();
  const settings: Settings = {
    milestones: v.p.paymentPlan,
    durationDays: v.p.durationDays ?? 30,
    retentionPct: v.p.retentionPct,
    retentionMonths: 3,
    delayPenaltyPct: 0.5,
    extraClauses: [],
  };
  // شماره از sequence دیتابیس؛ اول ردیف با شمارهٔ موقت، بعد شمارهٔ نهایی
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(contracts)
      .values({ projectId: v.p.id, number: 'pending', terms: {} as ContractTerms, contentHash: '' })
      .onConflictDoNothing({ target: contracts.projectId })
      .returning();
    if (!row) {
      const [again] = await tx.select().from(contracts).where(eq(contracts.projectId, v.p.id)).limit(1);
      return again;
    }
    const number = `BLK-${jalaliYear(now)}-${String(row.seq).padStart(6, '0')}`;
    const terms = buildTerms(v.p, v.client, v.provider, kyc, settings, number, now);
    const [c] = await tx.update(contracts).set({ number, terms, contentHash: hashTerms(terms) }).where(eq(contracts.id, row.id)).returning();
    return c;
  });
}

export async function getContract(userId: string, projectId: string) {
  const v = await projectFor(userId, projectId);
  const c = await ensureContract(v);
  return shape(c, await signaturesOf(c), v);
}

/* ---------- ویرایش ---------- */

export async function updateContract(userId: string, projectId: string, input: Partial<Settings>) {
  const v = await projectFor(userId, projectId);
  assertActive(v.p);
  const c = await ensureContract(v);
  if (c.status !== 'draft' && c.status !== 'signing') throw conflict('قرارداد امضاشده دیگر ویرایش نمی‌شود', 'CONTRACT_LOCKED');
  const s = { ...settingsOf(c.terms), ...input };
  const sum = s.milestones.reduce((a, m) => a + m.pct, 0);
  if (sum !== 100) throw badRequest(`جمع درصدهای پرداخت باید ۱۰۰ باشد (الان ${faNum(sum)})`, 'PLAN_SUM');

  const hadSignature = c.status === 'signing';
  const terms = buildTerms(v.p, v.client, v.provider, await kycOf(v), s, c.number, c.createdAt);
  const hash = hashTerms(terms);
  if (hash === c.contentHash) return shape(c, await signaturesOf(c), v);

  const nc = await db.transaction(async (tx) => {
    // نسخهٔ تازه = امضاهای قبلی دیگر معتبر نیستند
    const [row] = await tx
      .update(contracts)
      .set({ terms, contentHash: hash, version: sql`${contracts.version} + 1`, status: 'draft', updatedAt: new Date() })
      .where(and(eq(contracts.id, c.id), ne(contracts.status, 'active')))
      .returning();
    if (!row) throw conflict('قرارداد همین حالا امضا شد و دیگر ویرایش نمی‌شود', 'CONTRACT_LOCKED');
    await tx
      .update(projects)
      .set({ paymentPlan: s.milestones, retentionPct: s.retentionPct, durationDays: s.durationDays, updatedAt: new Date() })
      .where(eq(projects.id, v.p.id));
    return row;
  });
  if (hadSignature) {
    await notify(v.other.userId, {
      type: 'req',
      title: 'قرارداد ویرایش شد؛ دوباره امضا لازم است',
      body: `${v.me.name}: ${v.p.title}`,
      link: { screen: 'ctr', id: v.p.id },
    });
  }
  emitTo([v.client.userId, v.provider.userId], { type: 'contract', data: { projectId: v.p.id, status: nc.status, version: nc.version } });
  return shape(nc, [], v);
}

/* ---------- امضا ---------- */

const signCtx = (c: Contract) => `${c.id}:${c.version}:${c.contentHash}`;

async function signable(userId: string, projectId: string) {
  const v = await projectFor(userId, projectId);
  assertActive(v.p);
  const c = await ensureContract(v);
  if (c.status === 'active') throw conflict('این قرارداد قبلاً امضا و فعال شده است', 'CONTRACT_LOCKED');
  if (c.status === 'void') throw conflict('این قرارداد باطل شده است', 'CONTRACT_VOID');
  const sigs = await signaturesOf(c);
  if (sigs.some((s) => s.side === v.side)) throw conflict('این نسخه را قبلاً امضا کرده‌ای', 'ALREADY_SIGNED');
  const [u] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1);
  return { v, c, sigs, phone: u.phone };
}

/** کد امضا به موبایل خود امضاکننده پیامک می‌شود */
export async function requestSignCode(userId: string, projectId: string, ip?: string) {
  const { c, phone } = await signable(userId, projectId);
  const r = await sendOtp(phone, ip, { kind: 'sign', ctx: signCtx(c) });
  return { sent: true, expiresIn: r.expiresIn, resendIn: r.resendIn, contentHash: c.contentHash, ...(r.devCode ? { devCode: r.devCode } : {}) };
}

export async function signContract(userId: string, projectId: string, input: { code: string; contentHash: string }, meta: { ip?: string; userAgent?: string }) {
  const { v, c, phone } = await signable(userId, projectId);
  // کاربر همان متنی را امضا می‌کند که دیده است
  if (input.contentHash !== c.contentHash) throw conflict('متن قرارداد عوض شده؛ دوباره بخوان و امضا کن', 'CONTRACT_CHANGED');
  await consumeCode(phone, input.code, { kind: 'sign', ctx: signCtx(c) });

  const nc = await db.transaction(async (tx) => {
    const [sig] = await tx
      .insert(contractSignatures)
      .values({
        contractId: c.id,
        version: c.version,
        side: v.side,
        profileId: v.me.id,
        userId,
        phone,
        contentHash: c.contentHash,
        ip: meta.ip?.slice(0, 64),
        userAgent: meta.userAgent?.slice(0, 255),
      })
      .onConflictDoNothing()
      .returning();
    if (!sig) throw conflict('این نسخه را قبلاً امضا کرده‌ای', 'ALREADY_SIGNED');
    const n = await tx
      .select({ id: contractSignatures.id })
      .from(contractSignatures)
      .where(and(eq(contractSignatures.contractId, c.id), eq(contractSignatures.version, c.version)));
    const both = n.length >= 2;
    const [row] = await tx
      .update(contracts)
      .set({ status: both ? 'active' : 'signing', activatedAt: both ? new Date() : null, updatedAt: new Date() })
      // اگر هم‌زمان نسخه عوض شده باشد، این امضا به نسخهٔ قدیمی خورده و قبول نیست
      .where(and(eq(contracts.id, c.id), eq(contracts.version, c.version), eq(contracts.contentHash, c.contentHash)))
      .returning();
    if (!row) throw conflict('متن قرارداد همین حالا عوض شد؛ دوباره امضا کن', 'CONTRACT_CHANGED');
    return row;
  });

  if (nc.status === 'active') {
    await projectSysMessage(v.p, `قرارداد ${c.number} را هر دو طرف امضا کردند و فعال شد.`);
    await notify(v.other.userId, { type: 'req', title: 'قرارداد امضا و فعال شد', body: v.p.title, link: { screen: 'ctr', id: v.p.id } });
  } else {
    await projectSysMessage(v.p, `${v.me.name} قرارداد را امضا کرد؛ منتظر امضای طرف مقابل.`);
    await notify(v.other.userId, { type: 'req', title: 'قرارداد منتظر امضای توست', body: `${v.me.name}: ${v.p.title}`, link: { screen: 'ctr', id: v.p.id } });
  }
  emitTo([v.client.userId, v.provider.userId], { type: 'contract', data: { projectId: v.p.id, status: nc.status, version: nc.version } });
  return shape(nc, await signaturesOf(nc), v);
}

/** لغو پروژه: قراردادِ هنوز فعال‌نشده باطل می‌شود */
export async function voidPendingContract(projectId: string) {
  await db.update(contracts).set({ status: 'void', updatedAt: new Date() }).where(and(eq(contracts.projectId, projectId), ne(contracts.status, 'active')));
}

/* ---------- نسخهٔ چاپی ---------- */

export async function contractForPrint(id: string) {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, id)).limit(1);
  if (!c) return null;
  const sigs = await signaturesOf(c);
  return { c, sigs };
}

export function assertSide(side: string, expected: 'client' | 'provider', msg: string) {
  if (side !== expected) throw forbidden(msg, expected === 'client' ? 'CLIENT_ONLY' : 'PROVIDER_ONLY');
}
