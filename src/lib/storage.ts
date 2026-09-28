import fs from 'fs';
import path from 'path';
import type { Response } from 'express';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * لایهٔ ذخیره‌سازی فایل. سه حالت:
 * - supabase: Supabase Storage با کلید service_role؛ باکت خصوصی خودکار ساخته می‌شود.
 * - local: پوشهٔ روی همین سرور (توسعه و تست).
 * - s3: هر سرویس سازگار با S3 (مثلاً Object Storage لیارا در آینده).
 * در supabase و s3 باکت خصوصی می‌ماند و دانلود با لینک امضاشدهٔ کوتاه‌مدت انجام می‌شود.
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

class SupabaseStorage implements Storage {
  private base = `${env.SUPABASE_URL}/storage/v1`;
  private bucket = env.SUPABASE_BUCKET;
  private bucketReady: Promise<void> | null = null;

  private headers(extra: Record<string, string> = {}) {
    const key = env.SUPABASE_SERVICE_ROLE_KEY!;
    // کلیدهای جدید (sb_secret_...) JWT نیستند و فقط در apikey فرستاده می‌شوند
    return { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }), ...extra };
  }

  private async call(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.base}${path}`, { method, body, headers: this.headers(headers), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* پاسخ غیر JSON */
    }
    return { ok: res.ok, status: res.status, json, text };
  }

  private objectPath(key: string) {
    return `${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** باکت خصوصی را یک بار (اگر نیست) می‌سازد */
  private ensureBucket() {
    this.bucketReady ??= (async () => {
      const r = await this.call(
        'POST',
        '/bucket',
        JSON.stringify({ id: this.bucket, name: this.bucket, public: false, file_size_limit: 10 * 1024 * 1024 }),
        { 'Content-Type': 'application/json' },
      );
      if (!r.ok && !/already exists|Duplicate/i.test(r.text)) {
        this.bucketReady = null;
        throw new Error(`supabase bucket create failed (${r.status}): ${r.text.slice(0, 200)}`);
      }
    })();
    return this.bucketReady;
  }

  async put(key: string, body: Buffer, mime: string) {
    await this.ensureBucket();
    const r = await this.call('POST', `/object/${this.objectPath(key)}`, new Uint8Array(body), {
      'Content-Type': mime,
      'cache-control': 'max-age=31536000',
      'x-upsert': 'false',
    });
    if (!r.ok) throw new Error(`supabase upload failed (${r.status}): ${r.text.slice(0, 200)}`);
  }

  async remove(key: string) {
    const r = await this.call('DELETE', `/object/${this.objectPath(key)}`);
    if (!r.ok && r.status !== 404 && r.status !== 400) throw new Error(`supabase delete failed (${r.status}): ${r.text.slice(0, 200)}`);
  }

  async send(res: Response, key: string, _mime: string, opts: { isPublic: boolean; downloadName?: string }) {
    const r = await this.call('POST', `/object/sign/${this.objectPath(key)}`, JSON.stringify({ expiresIn: 600 }), {
      'Content-Type': 'application/json',
    });
    const signed = (r.json.signedURL ?? r.json.signedUrl) as string | undefined;
    if (!r.ok || !signed) {
      res.status(404).json({ error: { code: 'FILE_MISSING', message: 'فایل پیدا نشد' } });
      return;
    }
    let url = `${this.base}${signed.startsWith('/') ? '' : '/'}${signed}`;
    if (opts.downloadName) url += `&download=${encodeURIComponent(opts.downloadName)}`;
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.redirect(302, url);
  }
}

export const storage: Storage =
  env.STORAGE_DRIVER === 'supabase' ? new SupabaseStorage() : env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();

/** حذف بی‌صدا (اگر فایل در ذخیره‌ساز نبود یا خطا داد، فقط لاگ) */
export async function removeQuiet(keys: string[]) {
  for (const k of keys) {
    await storage.remove(k).catch((err) => logger.warn({ err, key: k }, 'storage remove failed'));
  }
}
