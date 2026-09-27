import { env } from './config/env';
import { createApp } from './app';
import { pool } from './db';
import { logger } from './lib/logger';

const server = createApp().listen(env.PORT, () => {
  logger.info(`🧱 Block API on :${env.PORT} (${env.NODE_ENV}, sms=${env.SMS_PROVIDER})`);
});

function shutdown() {
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
