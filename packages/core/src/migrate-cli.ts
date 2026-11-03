import { createDatabase } from './db.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = createDatabase(url, { max: 1 });
const applied = await migrate(db.sql);
console.warn(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
await db.close();
