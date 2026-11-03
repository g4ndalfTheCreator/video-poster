import {
  loadConfig,
  ConfigError,
  createDatabase,
  migrate,
  createLogger,
  createBoss,
  ensureQueues,
  QUEUES,
} from '@vs/core';
import type { WorkerContext } from './context.js';
import { ensurePartitions } from './jobs/maintenance.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(78);
    }
    throw e;
  }
  const log = createLogger('worker', config.LOG_LEVEL);
  const database = createDatabase(config.DATABASE_URL);
  await migrate(database.sql);
  const boss = createBoss(config.DATABASE_URL);
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();
  await ensureQueues(boss);
  const ctx: WorkerContext = { config, database, boss, log };

  await boss.work(QUEUES.partitions, async () => {
    const n = await ensurePartitions(ctx.database.sql);
    log.info({ created: n }, 'partitions ensured');
  });
  await boss.schedule(QUEUES.partitions, '17 2 * * *');
  await ensurePartitions(database.sql);

  log.info('worker started');
  const shutdown = async () => {
    await boss.stop({ graceful: true, timeout: 30_000 });
    await database.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
