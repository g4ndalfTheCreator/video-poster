import PgBoss from 'pg-boss';

export const QUEUES = {
  transcode: 'transcode',
  ipEnrich: 'ip_enrich',
  matchVisitor: 'match_visitor',
  notify: 'notify',
  closeSessions: 'close_sessions',
  rollups: 'rollups',
  rollupsNightly: 'rollups_nightly',
  partitions: 'partitions',
  retention: 'retention',
  purgeTrash: 'purge_trash',
  geoipUpdate: 'geoip_update',
  torList: 'tor_list',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface TranscodeJob {
  videoId: string;
  jobId: string;
}
export interface IpEnrichJob {
  ip: string;
}
export interface MatchVisitorJob {
  sessionId: string;
  fingerprintId: string;
}
export interface NotifyJob {
  sessionId: string;
  kind: 'open' | 'summary';
}

export function createBoss(databaseUrl: string): PgBoss {
  return new PgBoss({ connectionString: databaseUrl, schema: 'pgboss', max: 4 });
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    const existing = await boss.getQueue(name);
    if (!existing) {
      await boss.createQueue(name, {
        name,
        policy: name === QUEUES.closeSessions || name === QUEUES.rollups ? 'singleton' : 'standard',
        retryLimit: name === QUEUES.transcode ? 0 : 3,
        retryBackoff: true,
        expireInSeconds: name === QUEUES.transcode ? 4 * 3600 : 15 * 60,
      });
    }
  }
}

export { PgBoss };
