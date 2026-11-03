import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Db = PostgresJsDatabase<typeof schema>;

export interface Database {
  sql: Sql;
  db: Db;
  close(): Promise<void>;
}

export function createDatabase(url: string, opts: { max?: number } = {}): Database {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => undefined,
    types: {
      // bigint and numeric as JS numbers (values stay well below 2^53 for our use)
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
    },
    transform: { undefined: null },
  }) as unknown as Sql;
  const db = drizzle(sql as unknown as postgres.Sql, { schema });
  return { sql, db, close: () => sql.end({ timeout: 5 }) };
}
