import pgPromise from 'pg-promise';

const pgp = pgPromise({});
const db = pgp('postgres://oms:oms@localhost:5432/oms');

try {
  const tables = await db.any("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  console.log('Tables found:', tables);
} catch (err) {
  console.error('DB error:', err);
} finally {
  pgp.end();
}