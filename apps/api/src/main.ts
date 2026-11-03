import {
  loadConfig,
  ConfigError,
  createDatabase,
  migrate,
  createLogger,
  createBoss,
  ensureQueues,
} from '@vs/core';
import { buildApp } from './app.js';

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
  const log = createLogger('api', config.LOG_LEVEL);
  const database = createDatabase(config.DATABASE_URL);
  const applied = await migrate(database.sql);
  if (applied.length) log.info({ applied }, 'migrations applied');

  const boss = createBoss(config.DATABASE_URL);
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();
  await ensureQueues(boss);

  const app = await buildApp({ config, database, boss, log });
  await app.listen({ port: config.PORT, host: config.HOST });

  const shutdown = async () => {
    log.info('shutting down');
    await app.close();
    await boss.stop({ graceful: true, timeout: 10_000 });
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
