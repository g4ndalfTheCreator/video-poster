# Decisions and deviations from the specification

Each entry: what was decided, why, and where it applies. Newest at the bottom.

## D1 – Stable dependency majors instead of the newest

TypeScript 5.9, Vitest 3, pg-boss 10, postgres.js 3.4, Drizzle 0.44, zod 4, Playwright 1.63 (matches the
browsers installed in the build environment). These have well-known APIs; upgrades can follow separately.

## D2 – `packages/core` for server-side shared code

The spec lists `packages/shared` and `packages/player`. Database access, migrations, configuration, crypto,
IP helpers and queue definitions are needed by both api and worker but must not be shipped to browsers, so
they live in an additional server-only package `packages/core`. `packages/shared` stays browser-safe.

## D3 – Own SQL migration runner (Drizzle used for queries)

The schema relies on features drizzle-kit cannot express or diff reliably (declarative partitioning with a
default partition, GiST `inet_ops` indexes, plpgsql helpers, a UUIDv7 SQL function). Migrations are therefore
hand-written forward-only SQL files applied by a ~30 line runner under `pg_advisory_xact_lock`. Drizzle
table definitions (`packages/core/src/schema.ts`) are used for typed CRUD; analytics use raw SQL.

## D4 – `played_ranges` stored as jsonb

`[[from_ms,to_ms],…]` jsonb instead of `int4multirange`: the union is computed in TypeScript
(`packages/shared/src/ranges.ts`, unit-tested) during ingest, and jsonb is simpler to move between the
client, server and worker. A multirange column can be added later if SQL-side range queries are needed.

## D5 – Event de-duplication without a global unique index

`events` is partitioned by `server_ts`, so a unique `(session_id, seq)` index cannot be enforced across
partitions. Ingest instead locks the session's `session_summaries` row (`FOR UPDATE`) and skips sequence
numbers already present for that session. This serialises ingest per session, which is cheap.

## D6 – Media URL layout

HLS playlists reference segments by relative URL, and query strings are not inherited by relative URLs.
The signed token is therefore part of the path:
`/media/<md5token>/<expires>/<session_id>/<video_id>/<version>/<file>`.
nginx validates it with the stock `secure_link_md5` module over
`"<expires><session_id><video_id><version> <MEDIA_SIGNING_KEY>"`, so a token is bound to one video version
and one viewing session, which also lets the nginx access log attribute every segment fetch to a session.

## D7 – FFmpeg network isolation

Instead of a separate network-less container, FFmpeg runs as a child process of the worker with
`-protocol_whitelist file,pipe`, which disables every network protocol (the realistic risk is crafted
inputs referencing URLs via HLS/concat demuxers). CPU/memory limits are set on the worker service.

## D8 – nginx image and trusted proxies

nginx runs from `nginxinc/nginx-unprivileged` (non-root, ports 8080/8443 inside the container).
Two proxy lists exist: `EDGE_TRUSTED_PROXIES` (proxies/tunnels in front of nginx; empty by default) feeds
nginx `real_ip`, and `TRUSTED_PROXIES` (the nginx container network) is used by the api to read
`X-Forwarded-For`. The admin network check is enforced both in nginx (`geo`) and in the api.

## D9 – FFmpeg version

The production image is `node:22-trixie-slim` with Debian's FFmpeg 7.1. Nothing in the code depends on
FFmpeg 7 specifically; FFmpeg ≥ 6.1 works (used in CI on Ubuntu 24.04).

## D10 – Authorization before validation; viewer gets 403

Admin guards run in Fastify's `preValidation` phase so that a `viewer` (or an API token) receives 403
for every mutating route regardless of the request body, and nothing about payload schemas leaks to
unauthorised callers.

## D11 – TOTP enrollment flow and operator CLI

Owners/editors without TOTP get a session in an `enroll_required` stage that can only call the
enrollment endpoints. A small operator CLI in the api image (`node apps/api/dist/cli.js`) issues a new
bootstrap token and can create users or reset a password/TOTP (account recovery without database
access). Used codes are remembered per user (`totp_last_step`) to prevent replay.

## D12 – DB-backed rate limits

Login, TOTP and link-password attempt limits are fixed-window counters in a `rate_limits` table, so they
survive restarts. Request-rate limits for public routes (ingest 30 r/min, slug lookups 60 r/min) are
enforced by nginx `limit_req`.

## D13 – SBOM with cdxgen

`@cyclonedx/cyclonedx-npm` only understands npm's `node_modules` layout and fails on pnpm workspaces.
The CycloneDX SBOM is generated with CycloneDX's `cdxgen` (`pnpm sbom`), which reads `pnpm-lock.yaml`.

## D14 – Storage layout and file delivery

`MEDIA_ROOT/originals/<video>/source.<ext>` (immutable), `hls/<video>/<version>/` (playlists, segments,
`poster.jpg`, `sprite.jpg`, `sprite.vtt`, optional `download.mp4`), `assets/<video>/<asset>.<ext>`
(captions, attachments), `uploads/` (tus), `tmp/<job>/` (work dirs, renamed atomically into `hls/`). The
current and the previous HLS version are kept. Files that need authorisation and logging (captions,
attachments, MP4 download) go through the api, which hands the transfer to nginx with `X-Accel-Redirect`.

## D15 – Download MP4 is produced on demand

The 720p MP4 is transcoded by a separate `make_download` job the first time a link with
`allow_download` exists for the video version, instead of on every transcode (CPU-only host).
