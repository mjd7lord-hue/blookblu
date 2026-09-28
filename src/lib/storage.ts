import fs from 'fs';
import path from 'path';
import type { Response } from 'express';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * لایهٔ ذخیره‌سازی فایل. دو حالت:
 * - local: پوشهٔ روی همین سرور (توسعه و تست). روی لیارا فقط با «دیسک» ماندگار است.
 * - s3: Object Storage لیارا (یا هر سرویس سازگار با S3 داخل ایران). باکت خصوصی می‌ماند؛
 *   دانلود با لینک امضاشدهٔ کوتاه‌مدت انجام می‌شود.
 * کلید فایل‌ها تصادفی است و هرگز عوض نمی‌شود، پس کش طولانی بی‌خطر است.
 */
export interface Storage {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** فرستادن فایل به کاربر (استریم یا ریدایرکت) */
  send(res: Response, key: string, mime: string, opts: { isPublic: boolean; downloadName?: string }): Promise<void>;
}

function disposition(name?: string) {
  return name ? `inline; filename*=UTF-8''${encodeURIComponent(name)}` : 'inline';
}

class LocalStorage implements Storage {
  private root = path.resolve(env.STORAGE_LOCAL_DIR);

  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('bad storage key');
    return p;
  }

  async put(key: string, body: Buffer) {
    const p = this.file(key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, body);
  }

  async remove(key: string) {
    await fs.promises.rm(this.file(key), { force: true });
  }

  async send(res: Response, key: string, mime: string, opts: { isPublic: boolean; downloadName?: string }) {
    const p = this.file(key);
    const st = await fs.promises.stat(p).catch(() => null);
    if (!st) {
      res.status(404).json({ error: { code: 'FILE_MISSING', message: 'فایل پیدا نشد' } });
      return;
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Disposition', disposition(opts.downloadName));
    res.setHeader('Cache-Control', opts.isPublic ? 'public, max-age=31536000, immutable' : 'private, max-age=3600');
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(p).on('error', reject).on('end', resolve).pipe(res);
    });
  }
}

class S3Storage implements Storage {
  private client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY!, secretAccessKey: env.S3_SECRET_KEY! },
  });
  private bucket = env.S3_BUCKET!;

  async put(key: string, body: Buffer, mime: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime }));
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async send(res: Response, key: string, mime: string, opts: { isPublic: boolean; downloadName?: string }) {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: mime,
        ResponseContentDisposition: disposition(opts.downloadName),
        ResponseCacheControl: opts.isPublic ? 'public, max-age=31536000, immutable' : 'private, max-age=600',
      }),
      { expiresIn: 600 },
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.redirect(302, url);
  }
}

export const storage: Storage = env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();

/** حذف بی‌صدا (اگر فایل در ذخیره‌ساز نبود یا خطا داد، فقط لاگ) */
export async function removeQuiet(keys: string[]) {
  for (const k of keys) {
    await storage.remove(k).catch((err) => logger.warn({ err, key: k }, 'storage remove failed'));
  }
}
