import PgBoss from 'pg-boss';
import type { Sql } from './db.js';

export const QUEUES = {
  transcode: 'transcode',
  poster: 'poster',
  makeDownload: 'make_download',
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
  backup: 'backup',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface TranscodeJob {
  videoId: string;
  jobId: string;
}
export interface PosterJob {
  videoId: string;
  atMs?: number;
  imagePath?: string;
}
export interface DownloadJob {
  videoId: string;
}
export interface IpEnrichJob {
  ip: string;
  sessionId?: string;
}
export interface MatchVisitorJob {
  sessionId: string;
  fingerprintId: string;
}
export type NotifyJob =
  | { kind: 'open' | 'summary' | 'feedback'; sessionId: string }
  | { kind: 'test'; channelId: string }
  /** Admin sign-in from an address not seen for this user in 90 days, or an account lockout. */
  | { kind: 'admin_login' | 'admin_lockout'; userId: string; ip: string | null; userAgent?: string };

export function createBoss(databaseUrl: string): PgBoss {
  return new PgBoss({ connectionString: databaseUrl, schema: 'pgboss', max: 4 });
}

/**
 * Creates missing queues. Serialised across processes with an advisory lock: api and worker start
 * at the same time and concurrent pgboss.create_queue calls can deadlock.
 */
export async function ensureQueues(boss: PgBoss, sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727002)`;
    await createMissing(boss);
  });
}

async function createMissing(boss: PgBoss): Promise<void> {
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
