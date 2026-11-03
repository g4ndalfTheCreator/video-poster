-- TOTP replay protection and a small DB-backed rate limiter (logins, link passwords).
ALTER TABLE admin_users ADD COLUMN totp_last_step bigint;

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count int NOT NULL DEFAULT 0,
  reset_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_reset_idx ON rate_limits (reset_at);
