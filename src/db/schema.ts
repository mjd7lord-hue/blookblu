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
  serial,
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
    // با تمدید عادی پر می‌شود؛ خروج، تعلیق و سرقت خالی‌اش می‌کنند (مهلت جواب گم‌شده فقط برای تمدید)
    replacedAt: ts('replaced_at'),
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
    // بازدید پروفایل عمومی توسط دیگران (آمار عملکرد)
    views: integer('views').notNull().default(0),
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
    // اعلان همگانی پنل ادمین (برای درصد باز شدن)
    broadcastId: uuid('broadcast_id'),
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
    // قفل مدیر: پیام تازه پذیرفته نمی‌شود
    lockedAt: ts('locked_at'),
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
    // پنهان‌شده توسط مدیر: کاربران «پیام پنهان شد» می‌بینند، مدیر متن را
    hiddenAt: ts('hidden_at'),
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

export const FILE_PURPOSES = ['avatar', 'portfolio', 'document', 'chat', 'kyc', 'project', 'arbitration', 'receipt'] as const;
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
    // رسید واریز (عکس یا اسکرین‌شات) + شمارهٔ پیگیری بانک؛ برای جلوگیری از رسید تکراری/جعلی
    receiptFileId: uuid('receipt_file_id').references((): AnyPgColumn => files.id, { onDelete: 'set null' }),
    receiptHash: varchar('receipt_hash', { length: 64 }),
    trackingNo: varchar('tracking_no', { length: 40 }),
    bank: varchar('bank', { length: 40 }),
    checks: jsonb('checks').$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_project_idx').on(t.projectId, t.paidOn),
    uniqueIndex('payments_tracking_uq').on(t.trackingNo).where(sql`tracking_no is not null`),
    uniqueIndex('payments_receipt_hash_uq').on(t.receiptHash).where(sql`receipt_hash is not null`),
  ],
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

/* ================= فاز ۷: حل اختلاف و داوری حضوری ================= */

// حل‌کنندهٔ حضوری (مهندس یا متخصص تأییدشده توسط ادمین)
export const arbiterStatusEnum = pgEnum('arbiter_status', ['pending', 'approved', 'rejected', 'suspended']);
export const arbiterRangeEnum = pgEnum('arbiter_range', ['city', 'province', 'neighbors']);
export const disputeStatusEnum = pgEnum('dispute_status', ['open', 'arbitration', 'settled', 'decided', 'cancelled']);
export const arbCaseStatusEnum = pgEnum('arb_case_status', [
  'awaiting_payment', // ثبت شد؛ منتظر پرداخت امانی
  'matching', // پرداخت شد؛ دنبال حل‌کننده
  'offered', // به حل‌کننده پیشنهاد شد؛ منتظر قبول او
  'assigned', // حل‌کننده قبول کرد؛ زمان بازدید تعیین شد
  'reported', // گزارش و رأی ثبت شد؛ مهلت اعتراض
  'appealed', // اعتراض شد؛ دور بازبینی
  'final', // رأی نهایی
  'refunded', // حل‌کننده نیامد / لغو؛ پول برگشت
  'cancelled', // پیش از پرداخت لغو شد
]);
export const arbPaymentStatusEnum = pgEnum('arb_payment_status', ['unpaid', 'paid', 'released', 'refunded']);

export const arbiters = pgTable(
  'arbiters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .unique()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    fields: text('fields').array().notNull(), // struct, mas, fin, iso, elec, mech, qty
    range: arbiterRangeEnum('range').notNull().default('province'),
    docFileId: uuid('doc_file_id').references(() => files.id, { onDelete: 'set null' }),
    pledgedAt: ts('pledged_at').notNull(),
    status: arbiterStatusEnum('status').notNull().default('pending'),
    rejectReason: text('reject_reason'),
    reviewedBy: uuid('reviewed_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    reviewedAt: ts('reviewed_at'),
    ratingAvg: real('rating_avg').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    impartialNo: integer('impartial_no').notNull().default(0), // تعداد «بی‌طرف نبود»
    casesDone: integer('cases_done').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('arbiters_status_idx').on(t.status)],
);

export const disputes = pgTable(
  'disputes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    openedByProfileId: uuid('opened_by_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    againstProfileId: uuid('against_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    reason: varchar('reason', { length: 40 }).notNull(), // تأخیر در پرداخت، کیفیت کار، ...
    ask: varchar('ask', { length: 60 }).notNull(), // پرداخت باقی‌مانده، اصلاح کار، ...
    description: text('description').notNull(),
    city: varchar('city', { length: 60 }).notNull(), // محل بازدید
    province: varchar('province', { length: 60 }).notNull(),
    status: disputeStatusEnum('status').notNull().default('open'),
    talkUntil: ts('talk_until').notNull(), // ۴۸ ساعت گفت‌وگو
    settledAt: ts('settled_at'),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('disputes_project_idx').on(t.projectId), index('disputes_status_idx').on(t.status)],
);

export type ArbReport = {
  measure: string; // اندازه‌گیری و مشاهده
  compare: string; // مطابق / مغایرت جزئی / مغایرت اساسی
  verdict: string; // حق با کارفرما / حق با مجری / تقسیم مسئولیت
  remedy: string; // کار اصلاحی یا مبلغ
  upholds?: boolean; // فقط دور بازبینی: رأی قبلی تأیید شد؟
};

export const arbitrationCases = pgTable(
  'arbitration_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    round: smallint('round').notNull().default(1), // ۱ = داوری، ۲ = بازبینی
    payerProfileId: uuid('payer_profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    field: varchar('field', { length: 10 }).notNull(),
    amountMillion: integer('amount_million').notNull(),
    multi: boolean('multi').notNull().default(false),
    fee: bigint('fee', { mode: 'number' }).notNull(),
    travel: bigint('travel', { mode: 'number' }).notNull().default(0),
    travelKind: varchar('travel_kind', { length: 8 }).notNull().default('city'),
    commissionPct: smallint('commission_pct').notNull(),
    commission: bigint('commission', { mode: 'number' }).notNull(),
    arbiterShare: bigint('arbiter_share', { mode: 'number' }).notNull(), // سهم حل‌کننده + رفت‌وآمد
    total: bigint('total', { mode: 'number' }).notNull(),
    status: arbCaseStatusEnum('status').notNull().default('awaiting_payment'),
    paymentStatus: arbPaymentStatusEnum('payment_status').notNull().default('unpaid'),
    paymentRef: varchar('payment_ref', { length: 80 }),
    paidAt: ts('paid_at'),
    releasedAt: ts('released_at'),
    refundedAt: ts('refunded_at'),
    refundReason: text('refund_reason'),
    arbiterId: uuid('arbiter_id').references(() => arbiters.id, { onDelete: 'set null' }),
    skipArbiterIds: uuid('skip_arbiter_ids').array().notNull().default(sql`'{}'::uuid[]`),
    partyRejects: uuid('party_rejects').array().notNull().default(sql`'{}'::uuid[]`), // پروفایل طرف‌هایی که حق رد را استفاده کردند
    offeredAt: ts('offered_at'),
    acceptedAt: ts('accepted_at'),
    visitText: varchar('visit_text', { length: 80 }),
    report: jsonb('report').$type<ArbReport>(),
    photoFileIds: uuid('photo_file_ids').array().notNull().default(sql`'{}'::uuid[]`),
    reportedAt: ts('reported_at'),
    appealUntil: ts('appeal_until'),
    appealReason: text('appeal_reason'),
    partyAccepts: uuid('party_accepts').array().notNull().default(sql`'{}'::uuid[]`),
    feeReturnDue: boolean('fee_return_due').notNull().default(false), // بازبینی رأی را عوض کرد ← هزینهٔ بازبینی به معترض برمی‌گردد
    closedAt: ts('closed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // فقط یک پروندهٔ فعال در هر دور؛ پروندهٔ برگشت‌خورده/لغوشده جای درخواست تازه را باز می‌کند
    uniqueIndex('arb_case_dispute_round_uq').on(t.disputeId, t.round).where(sql`status not in ('refunded', 'cancelled')`),
    index('arb_case_arbiter_idx').on(t.arbiterId, t.status),
    index('arb_case_status_idx').on(t.status),
  ],
);

export const arbiterRatings = pgTable(
  'arbiter_ratings',
  {
    caseId: uuid('case_id')
      .notNull()
      .references(() => arbitrationCases.id, { onDelete: 'cascade' }),
    fromProfileId: uuid('from_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    impartial: boolean('impartial').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.fromProfileId] })],
);

/* ================= فاز ۸: نقش‌های مدیر و دسترسی‌ها (پنل ادمین) ================= */

// بخش‌های پنل — هم‌تراز با MODS در blookblu-admin/assets/js/data/sample-data.js
export const ADMIN_MODULES = [
  'dash', 'users', 'kyc', 'ads', 'chats', 'support', 'reports', 'qa', 'projects', 'pay', 'disputes', 'arbiters',
  'guar', 'score', 'notif', 'stories', 'academy', 'catalog', 'legal', 'coefs', 'settings', 'status', 'admins', 'audit',
] as const;
export type AdminModule = (typeof ADMIN_MODULES)[number];
/** ۰ = ندارد، ۱ = مشاهده، ۲ = ویرایش */
export type AdminPerms = Partial<Record<AdminModule, 0 | 1 | 2>>;

export const adminStatusEnum = pgEnum('admin_status', ['active', 'disabled']);

export const adminRoles = pgTable('admin_roles', {
  key: varchar('key', { length: 20 }).primaryKey(), // owner, content, support, finance, arbit, kyc
  name: varchar('name', { length: 40 }).notNull(),
  color: varchar('color', { length: 12 }).notNull().default('#888888'),
  perms: jsonb('perms').$type<AdminPerms>().notNull(),
  fixed: boolean('fixed').notNull().default(false), // مدیر ارشد: قابل تغییر نیست
  updatedAt: updatedAt(),
});

export const admins = pgTable(
  'admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleKey: varchar('role_key', { length: 20 })
      .notNull()
      .references(() => adminRoles.key),
    name: varchar('name', { length: 80 }).notNull(),
    // محدودهٔ استان؛ خالی = همهٔ ایران
    provinces: text('provinces').array().notNull().default(sql`'{}'::text[]`),
    status: adminStatusEnum('status').notNull().default('active'),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    lastSeenAt: ts('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('admins_role_idx').on(t.roleKey)],
);

/* ================= فاز ۸ ب: پنل ادمین — تنظیمات، پشتیبانی، اعلان همگانی، محتوا، تسویه ================= */

// تنظیمات قابل تغییر از پنل (کلید → JSON): settings, coefs, catalog, legal, notifTemplates, boost, stories, courses
export const appConfig = pgTable('app_config', {
  key: varchar('key', { length: 40 }).primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: uuid('updated_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

export const ticketStatusEnum = pgEnum('ticket_status', ['open', 'pending', 'closed']);
export const ticketPriorityEnum = pgEnum('ticket_priority', ['high', 'mid', 'low']);

// تیکت پشتیبانی = گفت‌وگوی «پشتیبانی بلوک» هر کاربر (conversations.kind = support) + وضعیت و مسئول
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    no: serial('no').notNull(), // شمارهٔ نمایشی T-1000+no
    conversationId: uuid('conversation_id')
      .notNull()
      .unique()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subject: varchar('subject', { length: 160 }),
    category: varchar('category', { length: 40 }).notNull().default('عمومی'),
    priority: ticketPriorityEnum('priority').notNull().default('mid'),
    status: ticketStatusEnum('status').notNull().default('open'),
    assigneeAdminId: uuid('assignee_admin_id').references(() => admins.id, { onDelete: 'set null' }),
    firstReplyAt: ts('first_reply_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tickets_status_idx').on(t.status, t.updatedAt)],
);

export const broadcasts = pgTable('broadcasts', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 160 }).notNull(),
  body: text('body'),
  link: jsonb('link').$type<{ screen: string; id?: string }>(),
  target: jsonb('target').$type<{ roles: string[]; provinces: string[]; userIds: string[] }>().notNull(),
  targetText: varchar('target_text', { length: 300 }).notNull(),
  sent: integer('sent').notNull().default(0),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

// شمارندهٔ بازدید استوری و دوره (محتوا خودش در app_config است)
export const contentStats = pgTable(
  'content_stats',
  {
    kind: varchar('kind', { length: 10 }).notNull(), // story | course
    itemId: varchar('item_id', { length: 40 }).notNull(),
    views: integer('views').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.kind, t.itemId] })],
);

// پیشرفت کاربر در دوره‌های آکادمی (درس‌های تمام‌شده)
export const courseProgress = pgTable(
  'course_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: varchar('course_id', { length: 40 }).notNull(),
    done: smallint('done').notNull().default(0),
    completedAt: ts('completed_at'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.courseId] })],
);

// تسویهٔ دستی سهم حل‌کننده‌ها (تا درگاه بانکی)
export const arbiterPayouts = pgTable('arbiter_payouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  arbiterId: uuid('arbiter_id')
    .notNull()
    .references(() => arbiters.id, { onDelete: 'cascade' }),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  ref: varchar('ref', { length: 120 }).notNull(),
  adminUserId: uuid('admin_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/* ================= تیم و حضور و غیاب (پیمانکار/شرکت/متخصص با نیروهای خودش) ================= */

export const attendanceEnum = pgEnum('attendance_status', ['p', 'a', 'l']); // حاضر، غایب، مرخصی

export const crewMembers = pgTable(
  'crew_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerProfileId: uuid('owner_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    // اگر نیرو خودش در بلوک پروفایل دارد
    memberProfileId: uuid('member_profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 80 }).notNull(),
    skill: varchar('skill', { length: 60 }).notNull(),
    dailyWage: bigint('daily_wage', { mode: 'number' }).notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('crew_owner_idx').on(t.ownerProfileId)],
);

export const attendance = pgTable(
  'attendance',
  {
    memberId: uuid('member_id')
      .notNull()
      .references(() => crewMembers.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    status: attendanceEnum('status').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.day] })],
);

/* ================= رزرو بازدید مهندس ================= */

export const visitStatusEnum = pgEnum('visit_status', ['requested', 'confirmed', 'declined', 'cancelled', 'done']);

export const visits = pgTable(
  'visits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientProfileId: uuid('client_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    engineerProfileId: uuid('engineer_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    typeName: varchar('type_name', { length: 80 }).notNull(),
    duration: varchar('duration', { length: 30 }),
    price: bigint('price', { mode: 'number' }).notNull(),
    day: date('day').notNull(),
    slot: varchar('slot', { length: 10 }).notNull(), // «۸:۰۰» همان‌طور که در اپ است
    address: text('address').notNull(),
    note: text('note'),
    status: visitStatusEnum('status').notNull().default('requested'),
    declineReason: text('decline_reason'),
    // گزارش مهندس پس از بازدید
    checklist: jsonb('checklist').$type<{ item: string; ok: boolean }[]>(),
    report: text('report'),
    doneAt: ts('done_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('visits_engineer_idx').on(t.engineerProfileId, t.day),
    index('visits_client_idx').on(t.clientProfileId),
    // یک ساعت از یک روز مهندس فقط یک رزرو فعال
    uniqueIndex('visits_slot_uq')
      .on(t.engineerProfileId, t.day, t.slot)
      .where(sql`status in ('requested', 'confirmed')`),
  ],
);

/* ================= آمار عملکرد: بازدید روزانهٔ پروفایل و آگهی ================= */

export const viewDays = pgTable(
  'view_days',
  {
    kind: varchar('kind', { length: 8 }).notNull(), // profile | ad
    itemId: uuid('item_id').notNull(),
    day: date('day').notNull(),
    n: integer('n').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.kind, t.itemId, t.day] })],
);

/* ================= درخواست همکاری مستقیم (دعوت یک نفر به کار) و رأی به پاسخ پرسش ================= */

export const inviteStatusEnum = pgEnum('invite_status', ['pending', 'accepted', 'rejected', 'withdrawn']);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromProfileId: uuid('from_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    toProfileId: uuid('to_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    adId: uuid('ad_id').references(() => ads.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 160 }).notNull(),
    startWhen: varchar('start_when', { length: 60 }),
    offer: varchar('offer', { length: 120 }),
    message: text('message'),
    status: inviteStatusEnum('status').notNull().default('pending'),
    respondedAt: ts('responded_at'),
    createdAt: createdAt(),
  },
  (t) => [index('invites_to_idx').on(t.toProfileId, t.status), index('invites_from_idx').on(t.fromProfileId)],
);

export const answerVotes = pgTable(
  'answer_votes',
  {
    responseId: uuid('response_id')
      .notNull()
      .references(() => adResponses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    value: smallint('value').notNull(), // ۱ = مفید بود، ‎-۱ = مفید نبود
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.responseId, t.userId] })],
);
