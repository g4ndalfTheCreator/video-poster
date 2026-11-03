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
import type { TranscodeJob, PosterJob, DownloadJob } from '@vs/core';
import type { WorkerContext } from './context.js';
import { ensurePartitions, purgeTrash } from './jobs/maintenance.js';
import { transcodeVideo, regeneratePoster, importPoster, makeDownload } from './media/transcode.js';

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
  const media = { sql: database.sql, config, log };

  // Transcoding: TRANSCODE_CONCURRENCY parallel workers, one job each.
  for (let i = 0; i < config.TRANSCODE_CONCURRENCY; i++) {
    await boss.work<TranscodeJob>(
      QUEUES.transcode,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async ([job]) => {
        if (job) await transcodeVideo(media, job.data.videoId, job.data.jobId);
      },
    );
  }
  await boss.work<PosterJob>(QUEUES.poster, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    if (job.data.imagePath) await importPoster(media, job.data.videoId, job.data.imagePath);
    else await regeneratePoster(media, job.data.videoId, job.data.atMs ?? 0);
  });
  await boss.work<DownloadJob>(
    QUEUES.makeDownload,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async ([job]) => {
      if (job) await makeDownload(media, job.data.videoId);
    },
  );

  await boss.work(QUEUES.partitions, async () => {
    const n = await ensurePartitions(ctx.database.sql);
    log.info({ created: n }, 'partitions ensured');
  });
  await boss.schedule(QUEUES.partitions, '17 2 * * *');
  await boss.work(QUEUES.purgeTrash, async () => {
    const n = await purgeTrash(database.sql, config.MEDIA_ROOT);
    if (n) log.info({ purged: n }, 'trash purged');
  });
  await boss.schedule(QUEUES.purgeTrash, '43 3 * * *');
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
