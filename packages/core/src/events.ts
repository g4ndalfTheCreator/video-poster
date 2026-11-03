import type { Sql } from './db.js';

export const VIDEO_EVENTS_CHANNEL = 'video_events';
export const LIVE_CHANNEL = 'live_sessions';

export interface VideoEvent {
  videoId: string;
  type: 'progress' | 'status' | 'job';
  status?: string;
  progressPct?: number;
  stage?: string;
  error?: string | null;
}

export async function publishVideoEvent(sql: Sql, e: VideoEvent): Promise<void> {
  await sql`SELECT pg_notify(${VIDEO_EVENTS_CHANNEL}, ${JSON.stringify(e)})`;
}
