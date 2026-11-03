/** Roles for admin users. `viewer` can only read telemetry. */
export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const VIDEO_STATUSES = ['uploading', 'processing', 'ready', 'failed', 'archived'] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const ASSET_KINDS = [
  'poster',
  'sprite',
  'sprite_vtt',
  'captions',
  'attachment',
  'download_mp4',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const TELEMETRY_LEVELS = ['full', 'server', 'minimal'] as const;
export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export const NETWORK_TYPES = [
  'residential_isp',
  'mobile',
  'business_isp',
  'corporate',
  'hosting_cloud',
  'security_proxy',
  'vpn',
  'tor',
  'edu',
  'lan',
  'unknown',
] as const;
export type NetworkType = (typeof NETWORK_TYPES)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const NOTIFICATION_KINDS = ['email', 'ntfy', 'webhook'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** HLS ladder. Never upscaled; for portrait video the height refers to the shorter side. */
export const LADDER = [
  { height: 1080, bitrateKbps: 5000 },
  { height: 720, bitrateKbps: 2800 },
  { height: 480, bitrateKbps: 1400 },
  { height: 360, bitrateKbps: 800 },
] as const;

export const HLS_SEGMENT_SECONDS = 4;
export const HLS_KEYFRAME_SECONDS = 2;
/** hls.js maxBufferLength; used by the server-side watch estimator. */
export const PLAYER_MAX_BUFFER_SECONDS = 10;
export const SPRITE_INTERVAL_SECONDS = 2;
export const SPRITE_THUMB_WIDTH = 160;
export const SPRITE_COLUMNS = 10;

export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const LIVE_WINDOW_MS = 15_000;
export const VIEW_MIN_WATCHED_MS = 2000;
export const COMPLETION_THRESHOLD_PCT = 95;
export const RETENTION_BUCKETS = 100;

export const INGEST_MAX_EVENTS = 50;
export const INGEST_MAX_BYTES = 64 * 1024;
export const HEARTBEAT_INTERVAL_MS = 5000;
export const FLUSH_INTERVAL_MS = 10_000;
export const FLUSH_MAX_EVENTS = 20;

/** Slugs that may never be used as custom slugs. */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'media',
  't',
  'v',
  'e',
  'go',
  'health',
  'healthz',
  'metrics',
  'privacy',
  'static',
  'assets',
  'player',
  'login',
  'logout',
  'favicon',
  'robots',
  'well-known',
]);

export const DEFAULT_LOCALE = 'fi';
export const DEFAULT_TIMEZONE = 'Europe/Helsinki';

const ROLE_LEVEL: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
export function roleAtLeastFn(role: string, min: Role): boolean {
  return (ROLE_LEVEL[role] ?? 0) >= ROLE_LEVEL[min]!;
}
