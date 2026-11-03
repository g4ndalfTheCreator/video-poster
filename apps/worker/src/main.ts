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
import type { TranscodeJob, PosterJob, DownloadJob, IpEnrichJob, MatchVisitorJob, NotifyJob } from '@vs/core';
import type { WorkerContext } from './context.js';
import { ensurePartitions, purgeTrash } from './jobs/maintenance.js';
import { transcodeVideo, regeneratePoster, importPoster, makeDownload } from './media/transcode.js';
import { defaultResolver, enrichIp, refreshTorExits } from './ipintel/enrich.js';
import { matchVisitor } from './telemetry/visitors.js';
import { notifyOpen, notifySummary, notifyTest } from './telemetry/notify.js';
import { closeIdleSessions } from './telemetry/sessions.js';
import { startSyslogReceiver } from './telemetry/syslog.js';
import { updateGeoIp } from './jobs/geoip.js';
import { runRollups } from './telemetry/rollups.js';
import { runRetention } from './jobs/retention.js';

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
  await ensureQueues(boss, database.sql);
  const ctx: WorkerContext = { config, database, boss, log };
  const sql = database.sql;
  const media = { sql, config, log };
  const intel = { sql, config, log, resolver: defaultResolver(config) };
  const work = <T extends object>(
    queue: string,
    handler: (data: T) => Promise<unknown>,
    pollingIntervalSeconds = 2,
  ) =>
    boss.work<T>(queue, { batchSize: 1, pollingIntervalSeconds }, async ([job]) => {
      if (job) await handler(job.data);
    });

  // ---- media
  for (let i = 0; i < config.TRANSCODE_CONCURRENCY; i++) {
    await work<TranscodeJob>(QUEUES.transcode, (d) => transcodeVideo(media, d.videoId, d.jobId));
  }
  await work<PosterJob>(QUEUES.poster, (d) =>
    d.imagePath
      ? importPoster(media, d.videoId, d.imagePath)
      : regeneratePoster(media, d.videoId, d.atMs ?? 0),
  );
  await work<DownloadJob>(QUEUES.makeDownload, (d) => makeDownload(media, d.videoId), 5);

  // ---- telemetry
  for (let i = 0; i < 4; i++) await work<IpEnrichJob>(QUEUES.ipEnrich, (d) => enrichIp(intel, d.ip), 1);
  await work<MatchVisitorJob>(QUEUES.matchVisitor, (d) => matchVisitor(sql, d.sessionId, d.fingerprintId), 1);
  for (let i = 0; i < 2; i++) {
    await work<NotifyJob>(
      QUEUES.notify,
      (d) => {
        if (d.kind === 'test') return notifyTest(media, d.channelId);
        return d.kind === 'open' ? notifyOpen(media, d.sessionId) : notifySummary(media, d.sessionId);
      },
      1,
    );
  }
  await work(QUEUES.closeSessions, async () => {
    const closed = await closeIdleSessions(sql);
    for (const id of closed)
      await boss.send(QUEUES.notify, { kind: 'summary', sessionId: id } satisfies NotifyJob);
    if (closed.length) await boss.send(QUEUES.rollups, {});
  });
  await boss.schedule(QUEUES.closeSessions, '*/5 * * * *');
  await work(
    QUEUES.torList,
    async () => log.info({ n: await refreshTorExits(intel) }, 'tor exit list refreshed'),
    60,
  );
  await boss.schedule(QUEUES.torList, '7 * * * *');
  await work<{ videoId?: string }>(QUEUES.rollups, (d) => runRollups(sql, { videoId: d.videoId }), 10);
  await boss.schedule(QUEUES.rollups, '*/5 * * * *');
  await work<{ videoId?: string; full?: boolean }>(
    QUEUES.rollupsNightly,
    (d) => runRollups(sql, { full: true, videoId: d.videoId }),
    30,
  );
  await boss.schedule(QUEUES.rollupsNightly, '31 1 * * *');
  const syslog = startSyslogReceiver(sql, config.SYSLOG_PORT, log);
  await work(QUEUES.geoipUpdate, () => updateGeoIp(config, log), 60);
  await boss.schedule(QUEUES.geoipUpdate, '23 4 3 * *');
  await boss.send(QUEUES.geoipUpdate, {}, { singletonKey: 'startup' });

  // ---- maintenance
  await work(
    QUEUES.partitions,
    async () => log.info({ created: await ensurePartitions(sql) }, 'partitions ensured'),
    60,
  );
  await boss.schedule(QUEUES.partitions, '17 2 * * *');
  await ensurePartitions(sql);
  await work(
    QUEUES.purgeTrash,
    async () => {
      const n = await purgeTrash(sql, config.MEDIA_ROOT);
      if (n) log.info({ purged: n }, 'trash purged');
    },
    60,
  );
  await boss.schedule(QUEUES.purgeTrash, '43 3 * * *');
  await work(QUEUES.retention, () => runRetention(sql, log), 60);
  await boss.schedule(QUEUES.retention, '13 3 * * *');

  log.info('worker started');
  const shutdown = async () => {
    syslog.close();
    await boss.stop({ graceful: true, timeout: 30_000 });
    await ctx.database.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
