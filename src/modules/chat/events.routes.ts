import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import { verifyAccess } from '../../lib/jwt';
import { subscribe } from '../../lib/events';

/**
 * جریان رویداد لحظه‌ای (Server-Sent Events).
 * اپ: new EventSource('/api/events?token=' + accessToken)
 * (EventSource هدر نمی‌پذیرد، برای همین توکن در query است)
 */
const r = Router();

r.get('/', async (req, res) => {
  const p = verifyAccess(String(req.query.token ?? ''));
  if (!p) return res.status(401).json({ error: { code: 'TOKEN_INVALID', message: 'نشست منقضی شده' } });
  const [u] = await db.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, p.sub)).limit(1);
  if (!u || u.status !== 'active') return res.status(401).json({ error: { code: 'TOKEN_INVALID', message: 'حساب فعال نیست' } });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: ready\ndata: {}\n\n`);

  const off = subscribe(u.id, (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`));
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    off();
  });
});

export default r;
