-- Admin hardening: time of the last password (+ TOTP) check in this session. Sensitive owner actions
-- require it to be recent (ADMIN_REAUTH_MINUTES).
ALTER TABLE admin_sessions ADD COLUMN reauth_at timestamptz;
UPDATE admin_sessions SET reauth_at = created_at WHERE stage = 'full';
-- Login alerts look up earlier sign-ins of the same user from the same address.
CREATE INDEX audit_log_login_idx ON audit_log (actor_user_id, created_at DESC) WHERE action = 'auth.login';
