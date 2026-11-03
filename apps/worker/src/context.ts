import type { Logger } from 'pino';
import type { Config, Database, PgBoss } from '@vs/core';

export interface WorkerContext {
  config: Config;
  database: Database;
  boss: PgBoss;
  log: Logger;
}
