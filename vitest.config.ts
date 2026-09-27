import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://blook:blook@localhost:5432/blook_test',
      DB_SSL: 'false',
      JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-00',
      JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-0',
      OTP_DEV_ECHO: 'true',
      OTP_RESEND_SECONDS: '0',
      OTP_MAX_PER_HOUR: '100',
      SMS_PROVIDER: 'console',
    },
  },
});
