import crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { conversationMembers, files, type FILE_PURPOSES } from '../../db/schema';
import { env } from '../../config/env';
import { hmac, safeEqual } from '../../lib/crypto';
import { badRequest, notFound } from '../../lib/errors';
import { removeQuiet, storage } from '../../lib/storage';

type FileRow = typeof files.$inferSelect;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/* ---------- نوع فایل: از روی محتوا، نه از نام یا هدر مرورگر ---------- */

const MB = 1024 * 1024;
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const RULES: Record<FilePurpose, { mimes: readonly string[]; maxBytes: number; isPublic: boolean }> = {
  avatar: { mimes: IMAGE_MIMES, maxBytes: 5 * MB, isPublic: true },
  portfolio: { mimes: IMAGE_MIMES, maxBytes: 5 * MB, isPublic: true },
  document: { mimes: [...IMAGE_MIMES, 'application/pdf'], maxBytes: 10 * MB, isPublic: false },
  chat: { mimes: [...IMAGE_MIMES, 'application/pdf'], maxBytes: 10 * MB, isPublic: false },
};
export const MAX_UPLOAD_BYTES = 10 * MB;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export function sniffMime(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * بخش‌های APP1 (EXIF/XMP) را از JPEG حذف می‌کند — عکس گوشی معمولاً مختصات GPS خانه/کارگاه را دارد.
 * اگر ساختار فایل غیرعادی بود، همان فایل اصلی برمی‌گردد.
 */
export function stripJpegMeta(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const marker = b[i + 1];
    // شروع دادهٔ تصویر: بقیه دست‌نخورده
    if (marker === 0xda) {
      out.push(b.subarray(i));
      return Buffer.concat(out);
    }
    // نشانگرهای بدون طول
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return b;
    if (marker !== 0xe1) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return b;
}

/* ---------- ذخیره ---------- */

export async function saveUpload(
  ownerUserId: string,
  purpose: FilePurpose,
  file: { buffer: Buffer; originalname?: string },
  opts: { conversationId?: string } = {},
): Promise<FileRow> {
  const rule = RULES[purpose];
  const mime = sniffMime(file.buffer);
  if (!mime || !rule.mimes.includes(mime)) {
    throw badRequest(
      rule.mimes.includes('application/pdf') ? 'فقط عکس (JPG، PNG، WebP) یا PDF قبول است' : 'فقط عکس (JPG، PNG، WebP) قبول است',
      'FILE_TYPE',
    );
  }
  const body = mime === 'image/jpeg' ? stripJpegMeta(file.buffer) : file.buffer;
  if (body.length > rule.maxBytes) {
    throw badRequest(`حجم فایل حداکثر ${rule.maxBytes / MB} مگابایت است`, 'FILE_TOO_LARGE');
  }
  const d = new Date();
  const key = `${purpose}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${EXT[mime]}`;
  await storage.put(key, body, mime);
  try {
    const [row] = await db
      .insert(files)
      .values({
        ownerUserId,
        purpose,
        storageKey: key,
        mime,
        size: body.length,
        originalName: cleanName(file.originalname),
        isPublic: rule.isPublic,
        conversationId: opts.conversationId ?? null,
      })
      .returning();
    return row;
  } catch (e) {
    await removeQuiet([key]);
    throw e;
  }
}

function cleanName(n?: string) {
  if (!n) return null;
  // multer نام را latin1 می‌خواند؛ نام فارسی را درست کن
  const fixed = Buffer.from(n, 'latin1').toString('utf8');
  const name = (fixed.includes('�') ? n : fixed).replace(/[\\/\r\n\0]/g, '_').trim();
  return name.slice(-160) || null;
}

/** حذف ردیف فایل‌ها و خودِ فایل از ذخیره‌ساز */
export async function purgeFiles(ids: (string | null | undefined)[]) {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return;
  const rows = await db.delete(files).where(inArray(files.id, list)).returning({ key: files.storageKey });
  await removeQuiet(rows.map((r) => r.key));
}

/* ---------- لینک ---------- */

function sign(id: string, exp: number) {
  return hmac(env.JWT_ACCESS_SECRET, `file:${id}:${exp}`).slice(0, 32);
}

/**
 * لینک فایل برای نمایش در اپ (<img src>).
 * عمومی: ثابت. خصوصی: امضاشده و موقت؛ فقط به کسی داده می‌شود که اجازهٔ دیدن دارد.
 * زمان انقضا گرد می‌شود تا لینک در بازهٔ کوتاه ثابت بماند و کش مرورگر کار کند.
 */
export function fileUrl(f: Pick<FileRow, 'id' | 'isPublic'> | { id: string; isPublic: boolean }): string {
  const base = `${env.PUBLIC_BASE_URL ?? ''}/api/files/${f.id}`;
  if (f.isPublic) return base;
  const ttl = env.FILE_URL_TTL_SECONDS;
  const exp = Math.ceil((Date.now() / 1000 + ttl) / ttl) * ttl;
  return `${base}?exp=${exp}&sig=${sign(f.id, exp)}`;
}

export const publicFileUrl = (id: string | null | undefined) => (id ? fileUrl({ id, isPublic: true }) : null);

export function checkSignature(id: string, exp: unknown, sig: unknown): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e * 1000 < Date.now() || typeof sig !== 'string') return false;
  return safeEqual(sign(id, e), sig);
}

export async function getFile(id: string) {
  const [f] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  if (!f) throw notFound('فایل پیدا نشد', 'FILE_NOT_FOUND');
  return f;
}

/** دسترسی با توکن ورود (وقتی لینک امضاشده نیست): صاحب فایل یا عضو همان گفت‌وگو */
export async function canAccess(f: FileRow, userId: string) {
  if (f.isPublic || f.ownerUserId === userId) return true;
  if (f.purpose === 'chat' && f.conversationId) {
    const [m] = await db
      .select({ u: conversationMembers.userId })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, f.conversationId), eq(conversationMembers.userId, userId)))
      .limit(1);
    return !!m;
  }
  return false;
}
