-- Link-level server events that happen before (or without) a viewing session:
-- link_expired_hit, password_ok, password_fail, max_sessions_hit, blocked.
CREATE TABLE link_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  link_id uuid NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  type text NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  ip inet,
  user_agent text
);
CREATE INDEX link_events_link_idx ON link_events (link_id, ts DESC);

ALTER TABLE view_sessions ADD COLUMN unlocked boolean NOT NULL DEFAULT false;
ALTER TABLE view_sessions ADD COLUMN embed boolean NOT NULL DEFAULT false;
