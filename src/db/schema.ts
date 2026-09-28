import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  bigint,
  bigserial,
  date,
  smallint,
  timestamp,
  jsonb,
  real,
  index,
  uniqueIndex,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* ---------- Enums ---------- */

// شش نقش شخصی اپ بلوک
export const ROLES = ['worker', 'specialist', 'engineer', 'contractor', 'company', 'general'] as const;
export type Role = (typeof ROLES)[number];
export const roleEnum = pgEnum('role', ROLES);

export const kycStatusEnum = pgEnum('kyc_status', ['none', 'pending', 'verified', 'rejected']);
export const userStatusEnum = pgEnum('user_status', ['active', 'suspended', 'deleted']);

// شهر، تا ۵۰ کیلومتر، استان، کل کشور
export const WORK_RANGES = ['city', 'km50', 'province', 'country'] as const;
export const workRangeEnum = pgEnum('work_range', WORK_RANGES);

// work = آمادهٔ همکاری، job = نیاز به نیرو، consult = پرسش تخصصی
export const AD_TYPES = ['work', 'job', 'consult'] as const;
export const adTypeEnum = pgEnum('ad_type', AD_TYPES);
export const adStatusEnum = pgEnum('ad_status', ['active', 'paused', 'closed', 'removed']);
export const responseStatusEnum = pgEnum('response_status', ['pending', 'accepted', 'rejected', 'withdrawn']);
export const guaranteeStatusEnum = pgEnum('guarantee_status', ['pending', 'accepted', 'rejected']);
export const savedKindEnum = pgEnum('saved_kind', ['ad', 'profile']);
export const reportStatusEnum = pgEnum('report_status', ['open', 'reviewing', 'resolved', 'dismissed']);

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

/* ---------- کاربران و احراز هویت ---------- */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: varchar('phone', { length: 11 }).notNull().unique(), // 09xxxxxxxxx
  firstName: varchar('first_name', { length: 60 }),
  lastName: varchar('last_name', { length: 60 }),
  activeRole: roleEnum('active_role'),
  kycStatus: kycStatusEnum('kyc_status').notNull().default('none'),
  status: userStatusEnum('status').notNull().default('active'),
  // کارشناس/ادمین بلوک (فاز ۴) — با npm run admin:grant
  isAdmin: boolean('is_admin').notNull().default(false),
  // ترجیحات اعلان و نمایش
  prefs: jsonb('prefs').$type<UserPrefs>().notNull().default(sql`'{}'::jsonb`),
  lastSeenAt: ts('last_seen_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type UserPrefs = {
  notif?: { requests?: boolean; messages?: boolean; ads?: boolean; reviews?: boolean };
  lang?: 'fa' | 'en' | 'ps';
};

export const otpCodes = pgTable(
  'otp_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: varchar('phone', { length: 11 }).notNull(),
    codeHash: text('code_hash').notNull(),
    purpose: varchar('purpose', { length: 20 }).notNull().default('login'),
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    ip: varchar('ip', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [index('otp_phone_created_idx').on(t.phone, t.createdAt)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: varchar('user_agent', { length: 255 }),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_user_idx').on(t.userId)],
);

/* ---------- پروفایل نقش‌ها (هر کاربر می‌تواند چند نقش داشته باشد) ---------- */

// وضعیت هفت روز هفته از شنبه: a=آزاد، b=رزرو، o=تعطیل
export type WeekState = ('a' | 'b' | 'o')[];

export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    code: varchar('code', { length: 10 }).notNull().unique(), // شناسهٔ کاری، مثل B-7K31
    displayName: varchar('display_name', { length: 120 }).notNull(),
    title: varchar('title', { length: 160 }),
    bio: text('bio'),
    province: varchar('province', { length: 60 }).notNull(),
    city: varchar('city', { length: 60 }).notNull(),
    workRange: workRangeEnum('work_range').notNull().default('city'),
    isPublic: boolean('is_public').notNull().default(true),
    showPhone: boolean('show_phone').notNull().default(false),
    // فیلدهای مخصوص هر نقش (رشته، پایه، رتبه، نوع قرارداد، ...)؛ با zod اعتبارسنجی می‌شود
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    week: jsonb('week').$type<WeekState>().notNull().default(sql`'["o","o","o","o","o","o","o"]'::jsonb`),
    // نشان «دارای مدرک/پروانه» پس از بررسی مدارک
    verified: boolean('verified').notNull().default(false),
    ratingAvg: real('rating_avg').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    doneCount: integer('done_count').notNull().default(0),
    referredBy: uuid('referred_by'),
    // عکس پروفایل (برای شرکت: لوگو) — فاز ۳
    avatarFileId: uuid('avatar_file_id').references((): AnyPgColumn => files.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('profiles_user_role_uq').on(t.userId, t.role),
    index('profiles_role_idx').on(t.role),
    index('profiles_place_idx').on(t.province, t.city),
  ],
);

// مهارت/خدمت با تعرفه (در پروفایل عمومی و فرم درخواست استفاده می‌شود)
export const profileSkills = pgTable(
  'profile_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 80 }).notNull(),
    experience: varchar('experience', { length: 40 }),
    rateType: varchar('rate_type', { length: 30 }), // روزانه، متری، تنی، پروژه‌ای، هر بازدید، توافقی
    rateAmount: bigint('rate_amount', { mode: 'number' }), // تومان؛ null یعنی توافقی
    sort: smallint('sort').notNull().default(0),
  },
  (t) => [index('skills_profile_idx').on(t.profileId)],
);

/* ---------- آگهی‌ها ---------- */

export const ads = pgTable(
  'ads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    type: adTypeEnum('type').notNull(),
    title: varchar('title', { length: 120 }).notNull(),
    description: text('description'),
    province: varchar('province', { length: 60 }).notNull(),
    city: varchar('city', { length: 60 }).notNull(),
    wageType: varchar('wage_type', { length: 30 }),
    wageAmount: bigint('wage_amount', { mode: 'number' }),
    startWhen: varchar('start_when', { length: 40 }),
    range: workRangeEnum('range').notNull().default('city'),
    audience: roleEnum('audience').array().notNull(),
    needCount: smallint('need_count'),
    skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
    status: adStatusEnum('status').notNull().default('active'),
    views: integer('views').notNull().default(0),
    responsesCount: integer('responses_count').notNull().default(0),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ads_type_status_idx').on(t.type, t.status, t.createdAt),
    index('ads_profile_idx').on(t.profileId),
    index('ads_place_idx').on(t.province, t.city),
  ],
);

export const adResponses = pgTable(
  'ad_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adId: uuid('ad_id')
      .notNull()
      .references(() => ads.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    message: text('message').notNull(),
    offer: varchar('offer', { length: 120 }),
    status: responseStatusEnum('status').notNull().default('pending'),
    respondedAt: ts('responded_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('responses_ad_profile_uq').on(t.adId, t.profileId), index('responses_profile_idx').on(t.profileId)],
);

/* ---------- ذخیره‌ها ---------- */

export const savedItems = pgTable(
  'saved_items',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: savedKindEnum('kind').notNull(),
    targetId: uuid('target_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.targetId] })],
);

/* ---------- اعتبار: نظرها و قیم ---------- */

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // نظر فقط بعد از همکاری واقعی ثبت می‌شود: پروژهٔ تمام‌شده (فاز ۲) — responseId برای داده‌های فاز ۱ نگه داشته شده
    responseId: uuid('response_id').references(() => adResponses.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    fromProfileId: uuid('from_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    toProfileId: uuid('to_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    text: text('text'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reviews_response_from_uq').on(t.responseId, t.fromProfileId),
    uniqueIndex('reviews_project_from_uq').on(t.projectId, t.fromProfileId),
    index('reviews_to_idx').on(t.toProfileId, t.createdAt),
  ],
);

// قیم / ضامن: کسی که اعتبار یک پروفایل را تأیید می‌کند
export const guarantees = pgTable(
  'guarantees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    guarantorUserId: uuid('guarantor_user_id').references(() => users.id, { onDelete: 'set null' }),
    guarantorPhone: varchar('guarantor_phone', { length: 11 }).notNull(),
    guarantorName: varchar('guarantor_name', { length: 120 }).notNull(),
    relation: varchar('relation', { length: 120 }).notNull(),
    status: guaranteeStatusEnum('status').notNull().default('pending'),
    respondedAt: ts('responded_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('guarantees_profile_phone_uq').on(t.profileId, t.guarantorPhone),
    index('guarantees_guarantor_idx').on(t.guarantorUserId, t.status),
  ],
);

/* ---------- اعلان‌ها ---------- */

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 30 }).notNull(), // req, ad, star, id, msg, cal
    title: varchar('title', { length: 160 }).notNull(),
    body: text('body'),
    link: jsonb('link').$type<{ screen: string; id?: string }>(),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notif_user_idx').on(t.userId, t.createdAt)],
);

/* ---------- ایمنی: گزارش و مسدودسازی ---------- */

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporterUserId: uuid('reporter_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  targetProfileId: uuid('target_profile_id').references(() => profiles.id, { onDelete: 'set null' }),
  targetAdId: uuid('target_ad_id').references(() => ads.id, { onDelete: 'set null' }),
  reason: varchar('reason', { length: 60 }).notNull(),
  details: text('details'),
  status: reportStatusEnum('status').notNull().default('open'),
  // رسیدگی ادمین (فاز ۴)
  adminNote: text('admin_note'),
  handledBy: uuid('handled_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  handledAt: ts('handled_at'),
  createdAt: createdAt(),
});

export const blocks = pgTable(
  'blocks',
  {
    blockerUserId: uuid('blocker_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedUserId: uuid('blocked_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerUserId, t.blockedUserId] })],
);

/* ================= فاز ۲: گفت‌وگو، توافق، پروژه ================= */

export const conversationKindEnum = pgEnum('conversation_kind', ['ad', 'direct', 'project', 'support']);
export const MESSAGE_KINDS = ['text', 'loc', 'phone', 'photo', 'file', 'voice', 'deal', 'day', 'sys', 'del'] as const;
export const messageKindEnum = pgEnum('message_kind', MESSAGE_KINDS);
export const proposalStatusEnum = pgEnum('proposal_status', ['pending', 'accepted', 'rejected', 'cancelled']);
export const projectStatusEnum = pgEnum('project_status', ['active', 'done', 'cancelled']);

// مراحل همکاری (هم‌تراز با اپ): ۰ پیشنهاد، ۱ توافق، ۲ در حال اجرا، ۳ تمام
export const STAGES = ['پیشنهاد', 'توافق', 'در حال اجرا', 'تمام'] as const;

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: conversationKindEnum('kind').notNull(),
    adId: uuid('ad_id').references(() => ads.id, { onDelete: 'set null' }),
    projectId: uuid('project_id'),
    title: varchar('title', { length: 160 }),
    stage: smallint('stage').notNull().default(0),
    lastMessageAt: ts('last_message_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('conv_ad_idx').on(t.adId)],
);

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    unread: integer('unread').notNull().default(0),
    lastReadAt: ts('last_read_at'),
    muted: boolean('muted').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    pinned: boolean('pinned').notNull().default(false),
    // «حذف گفت‌وگو» فقط برای خود کاربر پنهانش می‌کند؛ پیام تازه دوباره نشانش می‌دهد
    hiddenAt: ts('hidden_at'),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.profileId] }), index('conv_members_user_idx').on(t.userId)],
);

export type DealPayload = {
  job: string;
  qty?: string | null;
  price: string;
  amount?: number | null;
  start: string;
  durationDays: number;
  plan: { title: string; pct: number }[];
  retentionPct: number;
};
export type DayPayload = { date: string; hour: string };

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderProfileId: uuid('sender_profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    kind: messageKindEnum('kind').notNull(),
    body: text('body'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    // برای پیشنهاد توافق و روز شروع
    status: proposalStatusEnum('status'),
    // پیام مشکوک (درخواست پیش‌پرداخت، شمارهٔ کارت)
    flagged: boolean('flagged').notNull().default(false),
    projectId: uuid('project_id'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_conv_idx').on(t.conversationId, t.createdAt)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 160 }).notNull(),
    clientProfileId: uuid('client_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    dealMessageId: uuid('deal_message_id'),
    adId: uuid('ad_id').references(() => ads.id, { onDelete: 'set null' }),
    stage: smallint('stage').notNull().default(1),
    status: projectStatusEnum('status').notNull().default('active'),
    quantity: varchar('quantity', { length: 80 }),
    priceText: varchar('price_text', { length: 120 }).notNull(),
    amount: bigint('amount', { mode: 'number' }),
    startText: varchar('start_text', { length: 80 }),
    startDate: varchar('start_date', { length: 40 }),
    durationDays: smallint('duration_days'),
    paymentPlan: jsonb('payment_plan').$type<{ title: string; pct: number }[]>().notNull(),
    retentionPct: smallint('retention_pct').notNull().default(0),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_client_idx').on(t.clientProfileId), index('projects_provider_idx').on(t.providerProfileId)],
);

/* ================= فاز ۳: فایل‌ها (عکس پروفایل، نمونه‌کار، مدارک، عکس چت) ================= */

export const FILE_PURPOSES = ['avatar', 'portfolio', 'document', 'chat', 'kyc', 'project'] as const;
export const filePurposeEnum = pgEnum('file_purpose', FILE_PURPOSES);
export const documentStatusEnum = pgEnum('document_status', ['pending', 'approved', 'rejected']);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: filePurposeEnum('purpose').notNull(),
    // مسیر در ذخیره‌ساز (تصادفی، بدون نام اصلی)
    storageKey: varchar('storage_key', { length: 200 }).notNull().unique(),
    mime: varchar('mime', { length: 60 }).notNull(),
    size: integer('size').notNull(),
    originalName: varchar('original_name', { length: 160 }),
    // عمومی: عکس پروفایل و نمونه‌کار. خصوصی: مدرک و عکس چت (فقط با لینک امضاشده)
    isPublic: boolean('is_public').notNull().default(false),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    // فایل پروژه و عکس گزارش روزانه — فقط دو طرف پروژه (فاز ۵)
    projectId: uuid('project_id').references((): AnyPgColumn => projects.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('files_owner_idx').on(t.ownerUserId, t.purpose), index('files_project_idx').on(t.projectId)],
);

export const portfolioItems = pgTable(
  'portfolio_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 120 }).notNull(),
    place: varchar('place', { length: 60 }),
    whenText: varchar('when_text', { length: 40 }), // مثل «مهر ۱۴۰۵»
    sort: smallint('sort').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('portfolio_profile_idx').on(t.profileId, t.sort)],
);

// مدارک و گواهی‌ها — هرگز در پروفایل عمومی نمی‌آیند؛ فقط نتیجهٔ بررسی (نشان) دیده می‌شود
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // مدرک مخصوص یک نقش (مثل پروانهٔ نظام مهندسی)؛ null = مدرک هویتی مشترک همهٔ نقش‌ها
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 80 }).notNull(), // «کارت ملی»، «پروانهٔ اشتغال نظام مهندسی»، ...
    group: varchar('group', { length: 30 }), // هویت، مهارت، پروانه، بیمه، ...
    status: documentStatusEnum('status').notNull().default('pending'),
    rejectReason: text('reject_reason'),
    expiresAt: ts('expires_at'),
    reviewedAt: ts('reviewed_at'),
    reviewedBy: uuid('reviewed_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('documents_user_idx').on(t.userId, t.createdAt), index('documents_status_idx').on(t.status)],
);

/* ================= فاز ۴: احراز هویت (KYC) و پنل ادمین ================= */

export const kycIdTypeEnum = pgEnum('kyc_id_type', ['national', 'foreign']);

// درخواست تأیید هویت — دادهٔ کاملاً خصوصی؛ فقط خود کاربر (وضعیت) و ادمین (جزئیات) می‌بینند
export const kycRequests = pgTable(
  'kyc_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    firstName: varchar('first_name', { length: 60 }).notNull(),
    lastName: varchar('last_name', { length: 60 }).notNull(),
    idType: kycIdTypeEnum('id_type').notNull().default('national'),
    // کد ملی یا شمارهٔ مدرک اقامت اتباع (برای جلوگیری از چند حساب با یک هویت)
    idNumber: varchar('id_number', { length: 30 }),
    // عکس‌ها بعد از بررسی پاک می‌شوند (وعدهٔ حریم خصوصی اپ) → null
    cardFileId: uuid('card_file_id').references(() => files.id, { onDelete: 'set null' }),
    selfieFileId: uuid('selfie_file_id').references(() => files.id, { onDelete: 'set null' }),
    status: documentStatusEnum('status').notNull().default('pending'),
    rejectReason: text('reject_reason'),
    reviewedBy: uuid('reviewed_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('kyc_user_idx').on(t.userId, t.createdAt),
    index('kyc_status_idx').on(t.status, t.createdAt),
    index('kyc_id_number_idx').on(t.idNumber),
  ],
);

// ردپای همهٔ کارهای ادمین
export const adminActions = pgTable(
  'admin_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminUserId: uuid('admin_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 40 }).notNull(), // kyc.approve, document.reject, user.suspend, ...
    targetType: varchar('target_type', { length: 20 }).notNull(), // kyc, document, report, user, ad
    targetId: uuid('target_id').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('admin_actions_created_idx').on(t.createdAt), index('admin_actions_target_idx').on(t.targetType, t.targetId)],
);

/* ================= فاز ۵: قرارداد، پرداخت، صورت‌وضعیت، گزارش روزانه ================= */

export const contractStatusEnum = pgEnum('contract_status', ['draft', 'signing', 'active', 'void']);
export const partySideEnum = pgEnum('party_side', ['client', 'provider']);
export const paymentStatusEnum = pgEnum('payment_status', ['recorded', 'confirmed', 'disputed']);
export const statementStatusEnum = pgEnum('statement_status', ['draft', 'sent', 'approved', 'rejected']);

export type Milestone = { title: string; pct: number };
/** متن کامل قرارداد؛ امضاها به هش همین شیء گره خورده‌اند */
export type ContractTerms = {
  number: string;
  dateFa: string;
  title: string;
  client: { name: string; code: string; role: string; identityVerified: boolean };
  provider: { name: string; code: string; role: string; identityVerified: boolean };
  quantity: string | null;
  priceText: string;
  amount: number | null;
  startText: string | null;
  durationDays: number;
  milestones: Milestone[];
  retentionPct: number;
  retentionMonths: number;
  delayPenaltyPct: number;
  extraClauses: string[];
  clauses: { title: string; text: string }[];
};

export const contracts = pgTable('contracts', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  number: varchar('number', { length: 30 }).notNull(), // BLK-1405-000123
  version: smallint('version').notNull().default(1),
  status: contractStatusEnum('status').notNull().default('draft'),
  terms: jsonb('terms').$type<ContractTerms>().notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  activatedAt: ts('activated_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const contractSignatures = pgTable(
  'contract_signatures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    version: smallint('version').notNull(),
    side: partySideEnum('side').notNull(),
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    phone: varchar('phone', { length: 11 }).notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 255 }),
    signedAt: ts('signed_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('contract_sig_uq').on(t.contractId, t.version, t.side)],
);

// دفترچهٔ پرداخت — بلوک واسطهٔ مالی نیست؛ فقط ثبت و تأیید دوطرفه
export const projectPayments = pgTable(
  'project_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordedByProfileId: uuid('recorded_by_profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    amount: bigint('amount', { mode: 'number' }).notNull(), // تومان
    label: varchar('label', { length: 40 }).notNull(), // پیش‌پرداخت، قسط مرحله، دستمزد هفتگی، تسویهٔ نهایی
    milestoneIndex: smallint('milestone_index'),
    statementId: uuid('statement_id').references((): AnyPgColumn => statements.id, { onDelete: 'set null' }),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    note: text('note'),
    status: paymentStatusEnum('status').notNull().default('recorded'),
    disputeReason: text('dispute_reason'),
    respondedAt: ts('responded_at'),
    createdAt: createdAt(),
  },
  (t) => [index('payments_project_idx').on(t.projectId, t.paidOn)],
);

export type StatementItem = {
  key: string; // شناسهٔ ثابت ردیف بین صورت‌وضعیت‌ها
  title: string;
  unit: string;
  qty: number; // مقدار کل طبق متره
  unitPrice: number; // فی (تومان)
  prevDone: number; // انجام‌شده تا صورت‌وضعیت تأییدشدهٔ قبلی
  done: number; // انجام‌شده تا امروز (تجمعی)
};
export type StatementTotals = {
  contractValue: number;
  doneValue: number;
  prevValue: number;
  periodValue: number;
  retention: number;
  insurance: number;
  payable: number;
  progressPct: number;
};

export const statements = pgTable(
  'statements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: smallint('number').notNull(),
    status: statementStatusEnum('status').notNull().default('draft'),
    items: jsonb('items').$type<StatementItem[]>().notNull(),
    retentionPct: real('retention_pct').notNull().default(0),
    insurancePct: real('insurance_pct').notNull().default(0),
    totals: jsonb('totals').$type<StatementTotals>().notNull(),
    note: text('note'),
    rejectReason: text('reject_reason'),
    createdByProfileId: uuid('created_by_profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    sentAt: ts('sent_at'),
    approvedAt: ts('approved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('statements_project_number_uq').on(t.projectId, t.number)],
);

export const dailyReports = pgTable(
  'daily_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    authorProfileId: uuid('author_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    weather: varchar('weather', { length: 30 }),
    crew: smallint('crew').notNull().default(0),
    done: text('done').notNull(),
    issues: text('issues'),
    photoFileIds: uuid('photo_file_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('daily_project_author_date_uq').on(t.projectId, t.authorProfileId, t.reportDate),
    index('daily_project_idx').on(t.projectId, t.reportDate),
  ],
);
