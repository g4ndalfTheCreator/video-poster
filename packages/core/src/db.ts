import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Db = PostgresJsDatabase<typeof schema>;

export interface Database {
  sql: Sql;
  /** Drizzle instance. Uses its own small pool because drizzle replaces the client's date (de)serializers. */
  readonly db: Db;
  close(): Promise<void>;
}

const numberType = (oid: number) => ({
  to: oid,
  from: [oid],
  serialize: (x: number) => String(x),
  parse: (x: string) => Number(x),
});

export function createDatabase(url: string, opts: { max?: number } = {}): Database {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => undefined,
    // bigint and numeric as JS numbers (values stay well below 2^53 for our use)
    types: { bigint: numberType(20), numeric: numberType(1700) },
    transform: { undefined: null },
  }) as unknown as Sql;
  let drizzleClient: postgres.Sql | undefined;
  let db: Db | undefined;
  return {
    sql,
    get db() {
      if (!db) {
        drizzleClient = postgres(url, { max: 3, onnotice: () => undefined });
        db = drizzle(drizzleClient, { schema });
      }
      return db;
    },
    close: async () => {
      await Promise.all([sql.end({ timeout: 5 }), drizzleClient?.end({ timeout: 5 })]);
    },
  };
}
