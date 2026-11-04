import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigint,
  inet,
  numeric,
  cidr,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  totpPendingSecret: text('totp_pending_secret'),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  role: text('role').$type<'owner' | 'editor' | 'viewer'>().notNull(),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: ts('locked_until'),
  disabled: boolean('disabled').notNull().default(false),
  lastLoginAt: ts('last_login_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const adminSessions = pgTable('admin_sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  csrfToken: text('csrf_token').notNull(),
  stage: text('stage').$type<'pending_totp' | 'full'>().notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  absoluteExpiresAt: ts('absolute_expires_at').notNull(),
  reauthAt: ts('reauth_at'),
});

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  actorUserId: uuid('actor_user_id'),
  actorLabel: text('actor_label'),
  action: text('action').notNull(),
  entity: text('entity'),
  entityId: text('entity_id'),
  diff: jsonb('diff'),
  ip: inet('ip'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const notificationChannels = pgTable('notification_channels', {
  id: uuid('id').primaryKey(),
  kind: text('kind').$type<'email' | 'ntfy' | 'webhook'>().notNull(),
  config: text('config').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const videos = pgTable('videos', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').$type<'uploading' | 'processing' | 'ready' | 'failed' | 'archived'>().notNull(),
  durationMs: integer('duration_ms'),
  width: integer('width'),
  height: integer('height'),
  originalPath: text('original_path'),
  originalSha256: text('original_sha256'),
  originalSizeBytes: bigint('original_size_bytes', { mode: 'number' }),
  hlsVersion: integer('hls_version').notNull().default(0),
  posterAssetId: uuid('poster_asset_id'),
  posterAtMs: integer('poster_at_ms'),
  autoplayMuted: boolean('autoplay_muted').notNull().default(false),
  loudnorm: boolean('loudnorm').notNull().default(false),
  ctaConfig: jsonb('cta_config').$type<{ id: string; label: string; href: string }[]>().notNull().default([]),
  error: text('error'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const videoRenditions = pgTable('video_renditions', {
  id: uuid('id').primaryKey(),
  videoId: uuid('video_id').notNull(),
  hlsVersion: integer('hls_version').notNull(),
  height: integer('height').notNull(),
  width: integer('width').notNull(),
  bitrateKbps: integer('bitrate_kbps').notNull(),
  codec: text('codec').notNull(),
  playlistPath: text('playlist_path').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
});

export const assets = pgTable('assets', {
  id: uuid('id').primaryKey(),
  videoId: uuid('video_id').notNull(),
  kind: text('kind')
    .$type<'poster' | 'sprite' | 'sprite_vtt' | 'captions' | 'attachment' | 'download_mp4'>()
    .notNull(),
  path: text('path').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  lang: text('lang'),
  label: text('label'),
  filename: text('filename'),
  hlsVersion: integer('hls_version'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const transcodeJobs = pgTable('transcode_jobs', {
  id: uuid('id').primaryKey(),
  videoId: uuid('video_id').notNull(),
  state: text('state').$type<'queued' | 'running' | 'done' | 'failed'>().notNull(),
  progressPct: numeric('progress_pct', { mode: 'number' }).notNull().default(0),
  ffmpegLog: text('ffmpeg_log'),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
});

export const shareLinks = pgTable('share_links', {
  id: uuid('id').primaryKey(),
  videoId: uuid('video_id').notNull(),
  slug: text('slug').notNull(),
  label: text('label').notNull(),
  recipientName: text('recipient_name'),
  recipientOrg: text('recipient_org'),
  note: text('note'),
  passwordHash: text('password_hash'),
  expiresAt: ts('expires_at'),
  maxSessions: integer('max_sessions'),
  isActive: boolean('is_active').notNull().default(true),
  allowDownload: boolean('allow_download').notNull().default(false),
  allowEmbed: boolean('allow_embed').notNull().default(false),
  notifyOnOpen: boolean('notify_on_open').notNull().default(true),
  notifyEveryOpen: boolean('notify_every_open').notNull().default(false),
  ctaConfig: jsonb('cta_config').$type<{ id: string; label: string; href: string }[] | null>(),
  sessionCount: integer('session_count').notNull().default(0),
  firstOpenedAt: ts('first_opened_at'),
  lastOpenedAt: ts('last_opened_at'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const shareLinkRedirects = pgTable('share_link_redirects', {
  slug: text('slug').primaryKey(),
  linkId: uuid('link_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const visitors = pgTable('visitors', {
  id: uuid('id').primaryKey(),
  label: text('label'),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  sessionCount: integer('session_count').notNull().default(0),
  linkCount: integer('link_count').notNull().default(0),
  mergedInto: uuid('merged_into'),
});

export const ipOrgOverrides = pgTable('ip_org_overrides', {
  id: uuid('id').primaryKey(),
  cidr: cidr('cidr').notNull(),
  orgLabel: text('org_label').notNull(),
  note: text('note'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});
