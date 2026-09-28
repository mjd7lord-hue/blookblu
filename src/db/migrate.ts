import path from 'path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { env } from '../config/env';

/**
 * Supabase جدول‌های public را از راه REST API خودش (با کلید عمومی anon) در دسترس می‌گذارد.
 * بک‌اند ما مستقیم با نقش postgres وصل می‌شود (RLS رویش اثر ندارد)، پس:
 * RLS روی همهٔ جدول‌ها روشن و دسترسی anon/authenticated گرفته می‌شود — جدول‌های تازه هم خودکار.
 * روی PostgreSQL معمولی (تست، لیارا) نقش anon نیست و فقط RLS روشن می‌شود که بی‌اثر است.
 */
const LOCKDOWN = `
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and not rowsecurity loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
  end if;
end $$;`;

async function main() {
  // migration با اتصال مستقیم/Session (در Supabase: پورت 5432)، نه transaction pooler
  const pool = new Pool({
    connectionString: env.DIRECT_URL ?? env.DATABASE_URL,
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
    max: 1,
  });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    await pool.query(LOCKDOWN);
    console.log('✅ migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌ migration failed', e);
  process.exit(1);
});
