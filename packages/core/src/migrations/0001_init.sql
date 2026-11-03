-- Initial schema. All ids are UUIDv7, timestamps are timestamptz (UTC).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);
  uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  uuid_bytes := set_byte(uuid_bytes, 8, (b'10' || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$ LANGUAGE plpgsql VOLATILE;

CREATE SCHEMA IF NOT EXISTS archive;

-- ---------------------------------------------------------------- admin
CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  email text NOT NULL,
  password_hash text NOT NULL,
  totp_secret text,
  totp_pending_secret text,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  disabled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX admin_users_email_uq ON admin_users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  -- 'pending_totp' sessions can only call /auth/totp
  stage text NOT NULL DEFAULT 'full' CHECK (stage IN ('pending_totp', 'full')),
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions (user_id);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE bootstrap_tokens (
  token_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  actor_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  actor_label text,
  action text NOT NULL,
  entity text,
  entity_id text,
  diff jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_channels (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  kind text NOT NULL CHECK (kind IN ('email', 'ntfy', 'webhook')),
  -- encrypted JSON (secretbox, base64)
  config text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- content
CREATE TABLE videos (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'processing', 'ready', 'failed', 'archived')),
  duration_ms int,
  width int,
  height int,
  original_path text,
  original_sha256 text,
  original_size_bytes bigint,
  hls_version int NOT NULL DEFAULT 0,
  poster_asset_id uuid,
  poster_at_ms int,
  autoplay_muted boolean NOT NULL DEFAULT false,
  loudnorm boolean NOT NULL DEFAULT false,
  cta_config jsonb NOT NULL DEFAULT '[]',
  error text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX videos_created_idx ON videos (created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE video_renditions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  hls_version int NOT NULL,
  height int NOT NULL,
  width int NOT NULL,
  bitrate_kbps int NOT NULL,
  codec text NOT NULL,
  playlist_path text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0
);
CREATE INDEX video_renditions_video_idx ON video_renditions (video_id, hls_version);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('poster', 'sprite', 'sprite_vtt', 'captions', 'attachment', 'download_mp4')),
  path text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  lang text,
  label text,
  filename text,
  hls_version int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_video_idx ON assets (video_id, kind);

CREATE TABLE transcode_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  progress_pct numeric(5, 2) NOT NULL DEFAULT 0,
  ffmpeg_log text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX transcode_jobs_video_idx ON transcode_jobs (video_id, created_at DESC);

CREATE TABLE share_links (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  slug text NOT NULL,
  label text NOT NULL,
  recipient_name text,
  recipient_org text,
  note text,
  password_hash text,
  expires_at timestamptz,
  max_sessions int,
  is_active boolean NOT NULL DEFAULT true,
  allow_download boolean NOT NULL DEFAULT false,
  allow_embed boolean NOT NULL DEFAULT false,
  notify_on_open boolean NOT NULL DEFAULT true,
  notify_every_open boolean NOT NULL DEFAULT false,
  cta_config jsonb,
  session_count int NOT NULL DEFAULT 0,
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX share_links_slug_uq ON share_links (slug);
CREATE INDEX share_links_video_idx ON share_links (video_id, created_at DESC);

-- Old slugs kept as 301 redirects after a slug change.
CREATE TABLE share_link_redirects (
  slug text PRIMARY KEY,
  link_id uuid NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- telemetry
CREATE TABLE visitors (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  label text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  session_count int NOT NULL DEFAULT 0,
  link_count int NOT NULL DEFAULT 0,
  merged_into uuid REFERENCES visitors(id) ON DELETE SET NULL
);

CREATE TABLE browser_fingerprints (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  visitor_id uuid REFERENCES visitors(id) ON DELETE CASCADE,
  fp_hash text NOT NULL,
  stable_hash text NOT NULL,
  signals jsonb,
  randomized boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_count int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX browser_fingerprints_hash_uq ON browser_fingerprints (fp_hash);
CREATE INDEX browser_fingerprints_stable_idx ON browser_fingerprints (stable_hash);

CREATE TABLE ip_intel (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  ip inet NOT NULL,
  prefix cidr,
  asn int,
  as_org text,
  rdap_netname text,
  rdap_cidr text,
  rdap_org text,
  rdap_org_handle text,
  rdap_country text,
  abuse_email text,
  ptr text,
  ptr_confirmed boolean,
  network_type text NOT NULL DEFAULT 'unknown',
  org_guess text,
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('high', 'medium', 'low')),
  country text,
  region text,
  city text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ip_intel_ip_idx ON ip_intel (ip, fetched_at DESC);
CREATE INDEX ip_intel_prefix_gist ON ip_intel USING gist (prefix inet_ops);

CREATE TABLE ip_org_overrides (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  cidr cidr NOT NULL,
  org_label text NOT NULL,
  note text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ip_org_overrides_gist ON ip_org_overrides USING gist (cidr inet_ops);

CREATE TABLE view_sessions (
  id uuid PRIMARY KEY,
  link_id uuid NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  visitor_id uuid REFERENCES visitors(id) ON DELETE SET NULL,
  visitor_confidence text CHECK (visitor_confidence IN ('exact', 'probable', 'hash')),
  fingerprint_id uuid REFERENCES browser_fingerprints(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  telemetry_level text NOT NULL DEFAULT 'full',
  ip inet,
  ip_trunc inet,
  ip_intel_id uuid REFERENCES ip_intel(id) ON DELETE SET NULL,
  visitor_hash text,
  country text,
  region text,
  city text,
  asn int,
  as_org text,
  user_agent text,
  device_type text,
  os text,
  browser text,
  browser_version text,
  screen_w int,
  screen_h int,
  lang text,
  tz text,
  referrer_host text,
  utm jsonb,
  is_bot boolean NOT NULL DEFAULT false,
  bot_name text,
  dnt boolean,
  gpc boolean,
  http_version text,
  tls_version text,
  ja4 text,
  has_client_telemetry boolean NOT NULL DEFAULT false,
  notified_at timestamptz
);
CREATE INDEX view_sessions_link_idx ON view_sessions (link_id, started_at DESC);
CREATE INDEX view_sessions_video_idx ON view_sessions (video_id, started_at DESC);
CREATE INDEX view_sessions_visitor_idx ON view_sessions (visitor_id);
CREATE INDEX view_sessions_open_idx ON view_sessions (last_seen_at) WHERE closed_at IS NULL;
CREATE INDEX view_sessions_ip_idx ON view_sessions USING gist (ip inet_ops);
CREATE INDEX view_sessions_started_idx ON view_sessions (started_at DESC);

CREATE TABLE session_summaries (
  session_id uuid PRIMARY KEY REFERENCES view_sessions(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'server' CHECK (source IN ('server', 'client')),
  watch_ms bigint NOT NULL DEFAULT 0,
  unique_watched_ms bigint NOT NULL DEFAULT 0,
  max_position_ms int NOT NULL DEFAULT 0,
  completion_pct numeric(5, 2) NOT NULL DEFAULT 0,
  play_count int NOT NULL DEFAULT 0,
  seek_count int NOT NULL DEFAULT 0,
  rebuffer_count int NOT NULL DEFAULT 0,
  rebuffer_ms bigint NOT NULL DEFAULT 0,
  startup_ms int,
  ttff_ms int,
  quality_switches int NOT NULL DEFAULT 0,
  ended boolean NOT NULL DEFAULT false,
  quartiles int[] NOT NULL DEFAULT '{}',
  -- merged unique played ranges [[from_ms,to_ms],...]
  played_ranges jsonb NOT NULL DEFAULT '[]',
  -- raw (non-merged) play ranges for the rewatch heatmap, capped
  raw_ranges jsonb NOT NULL DEFAULT '[]',
  -- server-side estimate from segment fetches, kept for comparison
  server_played_ranges jsonb NOT NULL DEFAULT '[]',
  server_unique_watched_ms bigint NOT NULL DEFAULT 0,
  server_watch_ms bigint NOT NULL DEFAULT 0,
  renditions jsonb NOT NULL DEFAULT '{}',
  errors int NOT NULL DEFAULT 0,
  cta_clicks int NOT NULL DEFAULT 0,
  attachment_downloads int NOT NULL DEFAULT 0,
  video_downloads int NOT NULL DEFAULT 0,
  exit_reason text,
  last_seq int NOT NULL DEFAULT -1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  session_id uuid NOT NULL REFERENCES view_sessions(id) ON DELETE CASCADE,
  seq int NOT NULL,
  type text NOT NULL,
  client_ts timestamptz,
  client_ts_trusted boolean NOT NULL DEFAULT true,
  server_ts timestamptz NOT NULL DEFAULT now(),
  position_ms int,
  payload jsonb NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (server_ts);
CREATE INDEX events_session_seq_idx ON events (session_id, seq);
CREATE TABLE events_default PARTITION OF events DEFAULT;

CREATE TABLE segment_fetches (
  session_id uuid NOT NULL REFERENCES view_sessions(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  rendition int,
  segment_index int,
  file text,
  status int,
  bytes bigint,
  request_time_ms int,
  http_version text,
  tls_version text,
  ja4 text
) PARTITION BY RANGE (ts);
CREATE INDEX segment_fetches_session_idx ON segment_fetches (session_id, ts);
CREATE TABLE segment_fetches_default PARTITION OF segment_fetches DEFAULT;

CREATE TABLE link_previews (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  link_id uuid NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  bot_name text,
  user_agent text,
  ip inet,
  ip_intel_id uuid REFERENCES ip_intel(id) ON DELETE SET NULL,
  country text
);
CREATE INDEX link_previews_link_idx ON link_previews (link_id, fetched_at DESC);

CREATE TABLE daily_rollups (
  date date NOT NULL,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  sessions int NOT NULL DEFAULT 0,
  unique_visitors int NOT NULL DEFAULT 0,
  plays int NOT NULL DEFAULT 0,
  views int NOT NULL DEFAULT 0,
  watch_ms bigint NOT NULL DEFAULT 0,
  unique_watched_ms bigint NOT NULL DEFAULT 0,
  completions int NOT NULL DEFAULT 0,
  avg_completion_pct numeric(5, 2) NOT NULL DEFAULT 0,
  bot_sessions int NOT NULL DEFAULT 0,
  previews int NOT NULL DEFAULT 0,
  cta_clicks int NOT NULL DEFAULT 0,
  attachment_downloads int NOT NULL DEFAULT 0,
  by_country jsonb NOT NULL DEFAULT '{}',
  by_device jsonb NOT NULL DEFAULT '{}',
  by_referrer jsonb NOT NULL DEFAULT '{}',
  by_network_type jsonb NOT NULL DEFAULT '{}',
  by_org jsonb NOT NULL DEFAULT '{}',
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, video_id, link_id)
);
CREATE INDEX daily_rollups_video_idx ON daily_rollups (video_id, date);
CREATE INDEX daily_rollups_link_idx ON daily_rollups (link_id, date);

CREATE TABLE retention_buckets (
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  bucket smallint NOT NULL CHECK (bucket BETWEEN 0 AND 99),
  viewers int NOT NULL DEFAULT 0,
  rewatches int NOT NULL DEFAULT 0,
  PRIMARY KEY (video_id, link_id, bucket)
);

-- ---------------------------------------------------------------- partitions
-- Creates monthly partitions for [start month, start month + months_ahead].
CREATE OR REPLACE FUNCTION ensure_month_partitions(parent text, months_ahead int, months_back int DEFAULT 0) RETURNS int AS $$
DECLARE
  m date := (date_trunc('month', now()) - make_interval(months => months_back))::date;
  stop date := (date_trunc('month', now()) + make_interval(months => months_ahead))::date;
  part text;
  created int := 0;
BEGIN
  WHILE m <= stop LOOP
    part := format('%s_%s', parent, to_char(m, 'YYYYMM'));
    IF to_regclass('public.' || part) IS NULL AND to_regclass('archive.' || part) IS NULL THEN
      -- Move any rows of this range out of the default partition first.
      EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS)', part, parent);
      EXECUTE format(
        'WITH moved AS (DELETE FROM %I WHERE %s >= %L AND %s < %L RETURNING *) INSERT INTO %I SELECT * FROM moved',
        parent || '_default',
        CASE parent WHEN 'events' THEN 'server_ts' ELSE 'ts' END, m,
        CASE parent WHEN 'events' THEN 'server_ts' ELSE 'ts' END, (m + interval '1 month')::date,
        part);
      EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
        parent, part, m, (m + interval '1 month')::date);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END
$$ LANGUAGE plpgsql;

SELECT ensure_month_partitions('events', 3);
SELECT ensure_month_partitions('segment_fetches', 3);
