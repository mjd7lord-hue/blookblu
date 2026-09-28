import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { documents, files, portfolioItems, profiles, type Role } from '../../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { normalizeFa } from '../../lib/text';
import { getOwnProfile } from '../profiles/profiles.service';
import { fileUrl, publicFileUrl, purgeFiles, saveUpload } from './files.service';

type Upload = { buffer: Buffer; originalname?: string };

export const MAX_PORTFOLIO = 12;
export const MAX_DOCUMENTS = 30;

/* ---------- عکس پروفایل ---------- */

export async function setAvatar(userId: string, role: Role, file: Upload) {
  const p = await getOwnProfile(userId, role);
  const f = await saveUpload(userId, 'avatar', file);
  await db.update(profiles).set({ avatarFileId: f.id, updatedAt: new Date() }).where(eq(profiles.id, p.id));
  await purgeFiles([p.avatarFileId]);
  return publicFileUrl(f.id)!;
}

export async function removeAvatar(userId: string, role: Role) {
  const p = await getOwnProfile(userId, role);
  if (!p.avatarFileId) return;
  await db.update(profiles).set({ avatarFileId: null, updatedAt: new Date() }).where(eq(profiles.id, p.id));
  await purgeFiles([p.avatarFileId]);
}

/* ---------- نمونه‌کار ---------- */

type PortfolioRow = typeof portfolioItems.$inferSelect;
const shapePortfolio = (x: PortfolioRow) => ({
  id: x.id,
  title: x.title,
  place: x.place,
  when: x.whenText,
  url: publicFileUrl(x.fileId)!,
  sort: x.sort,
  createdAt: x.createdAt,
});

export async function listPortfolio(profileId: string) {
  const rows = await db
    .select()
    .from(portfolioItems)
    .where(eq(portfolioItems.profileId, profileId))
    .orderBy(asc(portfolioItems.sort), desc(portfolioItems.createdAt));
  return rows.map(shapePortfolio);
}

export async function addPortfolio(
  userId: string,
  role: Role,
  file: Upload,
  input: { title: string; place?: string | null; when?: string | null },
) {
  const p = await getOwnProfile(userId, role);
  const [{ n }] = await db.select({ n: count() }).from(portfolioItems).where(eq(portfolioItems.profileId, p.id));
  if (n >= MAX_PORTFOLIO) throw badRequest(`حداکثر ${MAX_PORTFOLIO} نمونه‌کار؛ اول یکی را حذف کن`, 'PORTFOLIO_FULL');
  const f = await saveUpload(userId, 'portfolio', file);
  try {
    // تازه‌ترین اول
    const [item] = await db
      .insert(portfolioItems)
      .values({
        profileId: p.id,
        fileId: f.id,
        title: normalizeFa(input.title),
        place: input.place ? normalizeFa(input.place) : null,
        whenText: input.when ? normalizeFa(input.when) : null,
        sort: -n,
      })
      .returning();
    return shapePortfolio(item);
  } catch (e) {
    await purgeFiles([f.id]);
    throw e;
  }
}

async function ownPortfolioItem(userId: string, id: string) {
  const [row] = await db
    .select({ item: portfolioItems })
    .from(portfolioItems)
    .innerJoin(profiles, eq(profiles.id, portfolioItems.profileId))
    .where(and(eq(portfolioItems.id, id), eq(profiles.userId, userId)))
    .limit(1);
  if (!row) throw notFound('نمونه‌کار پیدا نشد');
  return row.item;
}

export async function updatePortfolio(
  userId: string,
  id: string,
  input: { title?: string; place?: string | null; when?: string | null; sort?: number },
) {
  await ownPortfolioItem(userId, id);
  const set: Partial<PortfolioRow> = {};
  if (input.title !== undefined) set.title = normalizeFa(input.title);
  if (input.place !== undefined) set.place = input.place ? normalizeFa(input.place) : null;
  if (input.when !== undefined) set.whenText = input.when ? normalizeFa(input.when) : null;
  if (input.sort !== undefined) set.sort = input.sort;
  if (!Object.keys(set).length) throw badRequest('چیزی برای تغییر فرستاده نشده');
  const [item] = await db.update(portfolioItems).set(set).where(eq(portfolioItems.id, id)).returning();
  return shapePortfolio(item);
}

export async function deletePortfolio(userId: string, id: string) {
  const item = await ownPortfolioItem(userId, id);
  await purgeFiles([item.fileId]); // ردیف نمونه‌کار با cascade پاک می‌شود
}

/* ---------- مدارک ---------- */

type DocumentRow = typeof documents.$inferSelect;

export async function listDocuments(userId: string) {
  const rows = await db
    .select({ d: documents, f: files, role: profiles.role })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .leftJoin(profiles, eq(profiles.id, documents.profileId))
    .where(eq(documents.userId, userId))
    .orderBy(desc(documents.createdAt));
  return rows.map(({ d, f, role }) => shapeDocument(d, f, role));
}

function shapeDocument(d: DocumentRow, f: typeof files.$inferSelect, role: Role | null) {
  return {
    id: d.id,
    title: d.title,
    group: d.group,
    role,
    status: d.status,
    rejectReason: d.rejectReason,
    expiresAt: d.expiresAt,
    reviewedAt: d.reviewedAt,
    file: { url: fileUrl(f), mime: f.mime, size: f.size, name: f.originalName },
    createdAt: d.createdAt,
  };
}

export async function addDocument(
  userId: string,
  file: Upload,
  input: { title: string; group?: string | null; role?: Role | null },
) {
  const profileId = input.role ? (await getOwnProfile(userId, input.role)).id : null;
  const [{ n }] = await db.select({ n: count() }).from(documents).where(eq(documents.userId, userId));
  if (n >= MAX_DOCUMENTS) throw badRequest('تعداد مدارک زیاد است؛ مدارک قدیمی یا ردشده را حذف کن', 'DOCUMENTS_FULL');
  const title = normalizeFa(input.title);
  // یک مدرک در حال بررسی با همین عنوان کافی است
  const [dup] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.title, title),
        eq(documents.status, 'pending'),
        profileId ? eq(documents.profileId, profileId) : isNull(documents.profileId),
      ),
    )
    .limit(1);
  if (dup) throw conflict('این مدرک در حال بررسی است؛ اگر اشتباه فرستادی، اول آن را حذف کن', 'DOCUMENT_PENDING');

  const f = await saveUpload(userId, 'document', file);
  try {
    const [d] = await db
      .insert(documents)
      .values({ userId, profileId, fileId: f.id, title, group: input.group ? normalizeFa(input.group) : null })
      .returning();
    return shapeDocument(d, f, input.role ?? null);
  } catch (e) {
    await purgeFiles([f.id]);
    throw e;
  }
}

export async function deleteDocument(userId: string, id: string) {
  const [d] = await db.select().from(documents).where(and(eq(documents.id, id), eq(documents.userId, userId))).limit(1);
  if (!d) throw notFound('مدرک پیدا نشد');
  if (d.status === 'approved') throw forbidden('مدرک تأییدشده حذف نمی‌شود؛ برای تمدید، نسخهٔ تازه را بفرست', 'DOCUMENT_APPROVED');
  await purgeFiles([d.fileId]);
}

/* ---------- پاک‌سازی ---------- */

/** همهٔ فایل‌های یک پروفایل (عکس، نمونه‌کار، مدارک همان نقش) — پیش از حذف نقش */
export async function profileFileIds(profileId: string) {
  const [p] = await db.select({ a: profiles.avatarFileId }).from(profiles).where(eq(profiles.id, profileId)).limit(1);
  const [pf, docs] = await Promise.all([
    db.select({ id: portfolioItems.fileId }).from(portfolioItems).where(eq(portfolioItems.profileId, profileId)),
    db.select({ id: documents.fileId }).from(documents).where(eq(documents.profileId, profileId)),
  ]);
  return [p?.a, ...pf.map((x) => x.id), ...docs.map((x) => x.id)];
}

/** همهٔ فایل‌های کاربر — هنگام حذف حساب */
export async function purgeUserFiles(userId: string) {
  const rows = await db.select({ id: files.id }).from(files).where(eq(files.ownerUserId, userId));
  await purgeFiles(rows.map((r) => r.id));
}

