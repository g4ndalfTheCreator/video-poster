-- Telemetry additions: notification bookkeeping, session-summary notifications, fingerprint link.
ALTER TABLE share_links ADD COLUMN first_notified_at timestamptz;
ALTER TABLE view_sessions ADD COLUMN summary_notified_at timestamptz;
ALTER TABLE view_sessions ADD COLUMN first_play_at timestamptz;
CREATE INDEX view_sessions_fingerprint_idx ON view_sessions (fingerprint_id);
CREATE INDEX browser_fingerprints_visitor_idx ON browser_fingerprints (visitor_id);
CREATE INDEX ip_intel_rdap_cidr_idx ON ip_intel USING gist ((rdap_cidr::cidr) inet_ops) WHERE rdap_cidr IS NOT NULL;
CREATE TABLE notifications_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  session_id uuid REFERENCES view_sessions(id) ON DELETE CASCADE,
  link_id uuid REFERENCES share_links(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES notification_channels(id) ON DELETE SET NULL,
  kind text NOT NULL,
  ok boolean NOT NULL,
  error text,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_log_session_idx ON notifications_log (session_id);

-- Tor exit nodes (refreshed hourly when external lookups are enabled).
CREATE TABLE tor_exits (
  ip inet PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now()
);
