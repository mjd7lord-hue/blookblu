import { describe, it, expect, vi, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import type { Response } from 'express';

/* شبیه‌ساز کوچک Supabase Storage API برای تست درایور بدون اینترنت */
type Req = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
const calls: Req[] = [];
const objects = new Map<string, Buffer>();
const buckets = new Set<string>();
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    calls.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const url = decodeURIComponent(req.url!.split('?')[0]).replace(/^\/storage\/v1/, '');
    const json = (s: number, b: unknown) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(b));
    if (req.headers.apikey !== 'service-key') return json(401, { message: 'no key' });
    if (req.method === 'POST' && url === '/bucket') {
      const { id } = JSON.parse(body.toString());
      if (buckets.has(id)) return json(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      buckets.add(id);
      return json(200, { name: id });
    }
    let m = url.match(/^\/object\/sign\/(.+)$/);
    if (req.method === 'POST' && m) {
      if (!objects.has(m[1])) return json(400, { message: 'Object not found' });
      return json(200, { signedURL: `/object/sign/${m[1]}?token=abc` });
    }
    m = url.match(/^\/object\/(.+)$/);
    if (m && req.method === 'POST') {
      objects.set(m[1], body);
      return json(200, { Key: m[1] });
    }
    if (m && req.method === 'DELETE') {
      objects.delete(m[1]);
      return json(200, {});
    }
    json(404, {});
  });
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

describe('supabase storage driver', () => {
  it('creates private bucket once, uploads, signs, deletes', async () => {
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    vi.stubEnv('STORAGE_DRIVER', 'auto');
    vi.stubEnv('SUPABASE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
    vi.resetModules();
    const { env } = await import('../src/config/env');
    const { storage } = await import('../src/lib/storage');
    expect(env.STORAGE_DRIVER).toBe('supabase');

    await storage.put('chat/2026/09/a.jpg', Buffer.from('img-1'), 'image/jpeg');
    await storage.put('chat/2026/09/b.pdf', Buffer.from('pdf-2'), 'application/pdf');
    expect(calls.filter((c) => c.url.endsWith('/bucket'))).toHaveLength(1);
    const bucketReq = JSON.parse(calls[0].body.toString());
    expect(bucketReq).toMatchObject({ id: 'blook-files', public: false });
    const up = calls.find((c) => c.url === '/storage/v1/object/blook-files/chat/2026/09/a.jpg')!;
    expect(up.headers['content-type']).toBe('image/jpeg');
    expect(up.headers.authorization).toBe('Bearer service-key');
    expect(objects.get('blook-files/chat/2026/09/a.jpg')!.toString()).toBe('img-1');

    let location = '';
    const res = {
      setHeader: () => undefined,
      redirect: (_s: number, u: string) => (location = u),
      status: () => res,
      json: () => undefined,
    } as unknown as Response;
    await storage.send(res, 'chat/2026/09/b.pdf', 'application/pdf', { isPublic: false, downloadName: 'برآورد.pdf' });
    expect(location).toBe(
      `http://127.0.0.1:${port}/storage/v1/object/sign/blook-files/chat/2026/09/b.pdf?token=abc&download=${encodeURIComponent('برآورد.pdf')}`,
    );

    await storage.remove('chat/2026/09/a.jpg');
    expect(objects.has('blook-files/chat/2026/09/a.jpg')).toBe(false);
  });
});
