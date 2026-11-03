# Changelog

All notable changes are documented here. Versions follow semantic versioning; database migrations are
forward-only.

## 0.2.0 – 2026-11-03

- Story mode: full-screen mobile flow (muted autoplay with tap for sound, captions on, chapters,
  tap/hold to pause, swipe up to the CV and cover letter page), a one-tap 👍/🤷/👎 feedback card after the
  video (repeated on the documents page), comment notifications, feedback and "reached documents"
  statistics in the admin. Enabled per video, overridable per link. Migration `0006_story_mode.sql`.

## 0.1.0 – 2026-11-03

First complete version (milestones M0–M7 of `docs/SPEC.md`):

- M0 monorepo, Docker Compose stack, migrations, `/healthz`, CI
- M1 admin authentication: bootstrap, argon2id, mandatory TOTP for write roles, roles, audit log, network allowlist
- M2 video pipeline: tus upload, ffprobe validation, HLS ladder, poster, sprite, SSE progress, retry
- M3 share links and watch page: slugs, passwords, expiry, view limits, signed media, Open Graph, player, CTAs, attachments
- M4 telemetry: client SDK, browser profile, ingest, server-side segment log, IP owner lookup, returning viewers, notifications
- M5 rollups, retention curves, dashboards, live view, export
- M6 telemetry levels, retention jobs, GDPR search/export/delete, security headers
- M7 backups, restore procedure, Prometheus metrics, documentation
