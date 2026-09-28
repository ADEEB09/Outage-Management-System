import 'dotenv/config';
import { db, migrate } from './src/infra/db.js';

await migrate();
console.log('Migrate call completed');

const tables = await db.any("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
console.log('Tables visible from this same connection:', tables);

process.exit(0);