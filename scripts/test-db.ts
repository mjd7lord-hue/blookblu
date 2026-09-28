/**
 * PostgreSQL محلی برای تست، بدون Docker و بدون نصب (مخصوصاً ویندوز).
 * اجرا: npm run test:db  — سرور در پس‌زمینه روشن می‌ماند، بعد npm test
 * خاموش کردن: npm run test:db -- stop
 * داده در پوشهٔ .pgdata می‌ماند (در .gitignore است).
 */
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

const dir = path.resolve(__dirname, '../.pgdata');
const port = 5432;

function binDir() {
  const pkg = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  return path.resolve(__dirname, '../node_modules', pkg, 'native', 'bin');
}
const pgCtl = path.join(binDir(), process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');

async function main() {
  if (process.argv[2] === 'stop') {
    execFileSync(pgCtl, ['stop', '-D', dir, '-m', 'fast'], { stdio: 'inherit' });
    return;
  }
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) {
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'blook', password: 'blook', port, persistent: true });
    await pg.initialise();
  }
  // pg_ctl (نه postgres مستقیم) تا روی ویندوزِ ادمین هم اجرا شود
  try {
    execFileSync(pgCtl, ['status', '-D', dir], { stdio: 'ignore' });
  } catch {
    execFileSync(pgCtl, ['start', '-w', '-D', dir, '-o', `-p ${port}`, '-l', path.join(dir, 'server.log')], { stdio: 'ignore' });
  }
  const c = new Client({ connectionString: `postgresql://blook:blook@localhost:${port}/postgres` });
  await c.connect();
  const { rowCount } = await c.query(`select 1 from pg_database where datname = 'blook_test'`);
  // UTF8 صریح؛ پیش‌فرض ویندوز (مثلاً WIN1256) متن فارسی را خراب می‌کند
  if (!rowCount) await c.query(`create database blook_test encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
  await c.end();
  console.log(`✅ PostgreSQL تست روی localhost:${port} آماده است (blook/blook، دیتابیس blook_test)`);
}

main().catch((e) => {
  console.error('❌ راه‌اندازی PostgreSQL تست نشد:', e);
  process.exit(1);
});
