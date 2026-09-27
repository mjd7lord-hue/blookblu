import path from 'path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';

async function main() {
  const folder = path.resolve(__dirname, '../../drizzle');
  await migrate(db, { migrationsFolder: folder });
  console.log('✅ migrations applied');
  await pool.end();
}

main().catch(async (e) => {
  console.error('❌ migration failed', e);
  await pool.end();
  process.exit(1);
});
