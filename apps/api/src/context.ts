import type { FastifyBaseLogger } from 'fastify';
import type { Config, Database, PgBoss } from '@vs/core';

export interface AppContext {
  config: Config;
  database: Database;
  boss: PgBoss | null;
  log: FastifyBaseLogger;
}
