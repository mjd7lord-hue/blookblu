import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { sql } from 'drizzle-orm';
import { env } from './config/env';
import { db } from './db';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middlewares/error';
import authRoutes from './modules/auth/auth.routes';
import meRoutes from './modules/profiles/me.routes';
import profileRoutes from './modules/profiles/profiles.routes';
import adRoutes, { responsesRouter } from './modules/ads/ads.routes';
import savedRoutes from './modules/saved/saved.routes';
import { guaranteesRouter } from './modules/trust/trust.routes';
import chatRoutes, { messagesRouter } from './modules/chat/chat.routes';
import eventsRoutes from './modules/chat/events.routes';
import projectRoutes from './modules/projects/projects.routes';
import notificationRoutes from './modules/notifications/notifications.routes';
import safetyRoutes from './modules/safety/safety.routes';
import metaRoutes from './modules/meta.routes';
import fileRoutes from './modules/files/files.routes';
import mediaRoutes from './modules/files/media.routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // پشت پروکسی لیارا
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((s) => s.trim()),
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  if (env.NODE_ENV !== 'test') app.use(pinoHttp({ logger }));

  app.get('/api/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ ok: true, db: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  app.use('/api/meta', metaRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/me', mediaRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/api/profiles', profileRoutes);
  app.use('/api/ads', adRoutes);
  app.use('/api/responses', responsesRouter);
  app.use('/api/saved', savedRoutes);
  app.use('/api/conversations', chatRoutes);
  app.use('/api/messages', messagesRouter);
  app.use('/api/projects', projectRoutes);
  app.use('/api/events', eventsRoutes);
  app.use('/api/guarantees', guaranteesRouter);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api', safetyRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
