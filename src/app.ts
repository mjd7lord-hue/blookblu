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
import kycRoutes from './modules/kyc/kyc.routes';
import adminRoutes from './modules/admin/admin.routes';
import adminPanelRoutes from './modules/admin/panel';
import { panelMoreRoutes } from './modules/admin/panel-more';
import { contractPrintRouter, projectContractRouter } from './modules/contracts/contract.routes';
import { paymentsRouter, projectPaymentsRouter } from './modules/projects/payments';
import { projectStatementsRouter, statementsRouter } from './modules/projects/statements';
import { dailyRouter, projectDailyRouter, projectFilesRouter } from './modules/projects/worksite';
import appContentRoutes from './modules/content/content.routes';
import teamRoutes from './modules/team/team.routes';
import statsRoutes from './modules/profiles/stats.routes';
import inviteRoutes from './modules/invites/invites.routes';
import visitRoutes from './modules/visits/visits.routes';
import { cfg, configReady } from './lib/appConfig';
import { countRequests } from './lib/metrics';
import { adminArbitrationRouter, arbiterRouter, disputesRouter, projectDisputesRouter } from './modules/arbitration/arbitration.routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // پشت پروکسی Render/لیارا
  app.disable('x-powered-by');
  app.use(helmet());
  // فرانت روی گیت‌هاب (اینترنت) → API روی کامپیوتر خود کاربر: کروم این مجوز را در preflight می‌خواهد
  app.use((req, res, next) => {
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
  });
  app.use(
    cors({
      origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((s) => s.trim()),
    }),
  );
  app.use(express.json({ limit: '400kb' }));
  app.use(countRequests);
  if (env.NODE_ENV !== 'test') app.use(pinoHttp({ logger }));

  app.get('/api/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ ok: true, db: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // تنظیمات پنل (app_config) پیش از اولین درخواست خوانده می‌شود
  app.use(configReady);
  // حالت تعمیر (پنل ← تنظیمات): اپ فقط پیام «در حال به‌روزرسانی» می‌گیرد؛ ورود، پنل ادمین و تنظیمات باز است
  app.use((req, res, next) => {
    if (cfg('settings').flags.maintenance !== true || /^\/api\/(health|app|meta|auth|admin|events)(\/|$)/.test(req.path)) return next();
    res.status(503).json({ error: { code: 'MAINTENANCE', message: 'بلوک در حال به‌روزرسانی است؛ کمی بعد دوباره سر بزن' } });
  });

  app.use('/api/meta', metaRoutes);
  app.use('/api/app', appContentRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/me', mediaRoutes);
  app.use('/api/me', kycRoutes);
  app.use('/api/me/team', teamRoutes);
  app.use('/api/me/stats', statsRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/profiles', profileRoutes);
  app.use('/api/ads', adRoutes);
  app.use('/api/responses', responsesRouter);
  app.use('/api/saved', savedRoutes);
  app.use('/api/conversations', chatRoutes);
  app.use('/api/messages', messagesRouter);
  app.use('/api/projects', projectRoutes);
  // فاز ۵: قرارداد، دفترچهٔ پرداخت، صورت‌وضعیت، گزارش روزانه و فایل‌های هر پروژه
  app.use('/api/projects/:id/contract', projectContractRouter);
  app.use('/api/projects/:id/payments', projectPaymentsRouter);
  app.use('/api/projects/:id/statements', projectStatementsRouter);
  app.use('/api/projects/:id/daily', projectDailyRouter);
  app.use('/api/projects/:id/files', projectFilesRouter);
  app.use('/api/contracts', contractPrintRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/statements', statementsRouter);
  app.use('/api/daily', dailyRouter);
  // فاز ۷: حل اختلاف و داوری حضوری
  app.use('/api/projects/:id/disputes', projectDisputesRouter);
  app.use('/api/disputes', disputesRouter);
  app.use('/api/arbitration', arbiterRouter);
  app.use('/api/admin/arbitration', adminArbitrationRouter);
  // فاز ۸: پنل ادمین (نقش‌ها، مدیران، تصویر لحظه‌ای)
  app.use('/api/admin/panel', adminPanelRoutes);
  app.use('/api/admin/panel', panelMoreRoutes);
  app.use('/api/visits', visitRoutes);
  app.use('/api/invites', inviteRoutes);
  app.use('/api/events', eventsRoutes);
  app.use('/api/guarantees', guaranteesRouter);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api', safetyRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
