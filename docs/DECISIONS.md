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

## D16 – Link-level server events in `link_events`

`link_expired_hit`, `password_ok`, `password_fail` and `max_sessions_hit` happen before a viewing
session exists, so they are stored per link in `link_events` instead of the session-scoped `events`
table. Server-generated session events (CTA click via `/go`, attachment and MP4 download) are written to
`events` with negative sequence numbers so they never collide with client `seq` values.

## D17 – Uniform 404

Unknown, expired, closed, deleted, not-ready and exhausted (`max_sessions`) links all return the same
404 page body (no CSP-nonce inline style on that page) and every `/v/*` response is padded to at least
150 ms.

## D18 – Link-preview bots

Requests whose User-Agent is a known preview/crawler bot (LinkedInBot, Slackbot, Teams, WhatsApp, …,
`isbot`, headless browsers) get the Open Graph page without a player or session and are stored in
`link_previews`; they never count against `max_sessions`.

## D19 – Player bundle

The player uses the hls.js _light_ build (no EME, alternate audio, subtitle playlists or CMCD — captions
are sidecar WebVTT `<track>`s). The page budget is enforced at build time
(`packages/player/build.mjs`): player.js + player.css + HTML ≈ 113 kB gzip of the 120 kB budget, of which
hls.js light is ~108 kB. Signed media tokens live in the URL path, so hls.js `xhrSetup` rewrites the
token prefix after a playback-token refresh.

## D20 – Password unlock cookie

A correct link password sets a 12-hour `HttpOnly; SameSite=Lax` cookie containing an HMAC over the link
id, expiry and the tail of the password hash, so changing the password invalidates existing unlocks.

## D21 – Server-side watch estimate

Without client JS the watched ranges are estimated from the nginx media log (one JSON line per request,
shipped over UDP syslog to the worker). Segment k is requested when the playhead is roughly at
`4k − 10 s` (hls.js `maxBufferLength = 10`), so a run of consecutive segments a…b is counted as watched
from `4a` to the middle of `[4b − 10, 4(b+1) − 10)`, capped by wall-clock time until the next run (seek)
or session close; a run that reaches the last segment counts to the end. The tail is stored as
"fetched, not certainly watched". The client estimate replaces it as `source = client` when JS telemetry
exists; both are kept. Safari's native player buffers differently and is less accurate (as the spec
notes). JA4 is not collected: stock nginx has no JA4 module (setting kept, default off).

## D22 – Raw vs. merged played ranges

The SDK sends raw played ranges per heartbeat (not `video.played`, which is already a union), so the
server can count rewatches (`raw_ranges`, capped at 2000 per session) and compute unique time
(`played_ranges`, union) separately.

## D23 – Browser profile storage

The full signal set is stored once per distinct profile in `browser_fingerprints` (retention 180 days);
the `fingerprint` event keeps only a reference. `fp_hash` = SHA-256 of the canonical stable subset;
`stable_hash` additionally drops signals that privacy browsers randomise, and is used for randomised
profiles. Client-side hashes use cyrb53 because SubtleCrypto is unavailable on plain-HTTP LAN pages.

## D24 – IP owner lookup

Order: LAN check (no external calls) → local mmdb (country/city/ASN) → PTR with forward confirmation
(2 s timeout, `DNS_RESOLVER`) → RDAP via the IANA bootstrap (1 request/s, 256 kB limit, 5 s timeout,
cached per allocation for 30 days) → classification heuristics (`apps/worker/src/ipintel/classify.ts`,
ASN lists for hosting/security proxies/VPNs, PTR patterns) → admin overrides. The Tor exit list is
refreshed hourly only while external lookups are enabled. The real-network test runs in CI only
(`RUN_NETWORK_TESTS=1`); this development environment has no outbound DNS/RDAP.

## D25 – GeoIP databases

The worker downloads DB-IP Lite City + ASN (CC BY 4.0, no licence key) monthly into `GEOIP_DIR`
(`GEOIP_AUTO_UPDATE=dbip`, set `off` to manage files manually, e.g. MaxMind GeoLite2). This is an
outbound request that carries no viewer data. Attribution: "IP geolocation by DB-IP" (shown in the
admin System page).

## D26 – Notifications

"Link opened" is sent for the first human `play` on a link (every open if `notify_every_open`), claimed
atomically so it goes out once; it waits up to 10 s for IP enrichment. Channels: ntfy, email (SMTP via
nodemailer), webhook (HMAC-signed JSON). Optional end-of-session summary via the setting
`notifications.sessionSummary`. Every delivery attempt is logged in `notifications_log`.

## D27 – Rollups and retention

`daily_rollups` rows are (date in the configured UI time zone, video, link); the job recomputes today
and yesterday every 5 minutes and yesterday again nightly; `rebuildAllRollups` backfills everything
(seed, GDPR deletions). Unique visitors for a date range are counted from `view_sessions`
(visitor id, falling back to the daily `visitor_hash`) because daily uniques cannot be summed.
`retention_buckets` is all-time per link (the spec's table has no date), recomputed for links with
session activity since the last run; date filters therefore do not apply to the retention curve.

## D28 – Headless browsers are bots

Sessions whose page reports `navigator.webdriver = true` (automation, including Playwright) or a 0×0
screen are flagged `is_bot` and excluded from dashboards (they are still stored and visible with
"hide bots" off). End-to-end tests therefore assert on session details, not on dashboard counts.
