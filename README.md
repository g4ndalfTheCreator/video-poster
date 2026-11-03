# video-share

Self-hosted service for sharing short videos (for example a CV introduction) through individual links,
with detailed per-link viewing telemetry. One installation = one organisation; a handful of admin users.

- Upload (resumable), automatic HLS transcoding (1080p/720p/480p/360p, never upscaled), poster and
  thumbnail sprite
- Unique links per recipient (random or custom slug, password, expiry, view limit, download/embed
  switches, call-to-action buttons, attachments), uniform 404 for anything invalid
- Telemetry per link: sessions, watched ranges, retention curve, rewatches, drop-off points, device,
  country, network owner (RDAP/PTR) with confidence, returning viewers, link-preview bots, notifications
  (ntfy, email, webhook) when a link is opened
- Works without client JavaScript too (server-side estimate from the HLS segment log)
- Admin SPA in Finnish and English, dark and light theme
- Everything on your own server: no CDN, no third-party scripts, fonts or analytics

The full specification (Finnish) is in [`docs/SPEC.md`](docs/SPEC.md); deviations and design decisions
are in [`docs/DECISIONS.md`](docs/DECISIONS.md).

> **Privacy note.** With the default telemetry level `full` the watch page collects a browser profile
> and client events without asking for consent. That is fine for LAN testing, but for public use with
> EU viewers it is very likely unlawful (Finnish Electronic Communications Services Act §205 /
> ePrivacy Art. 5(3), EDPB Guidelines 2/2023). Switch to `server` or `minimal` in _Settings → Telemetry_
> (no code change) or add a consent mechanism before publishing. GDPR applies to server-side data as
> well; the legal assessment is the operator's responsibility.

## Architecture

Four containers in one Docker Compose stack:

| Service    | Role                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nginx`    | Only public component. Serves the admin SPA and player bundle, validates signed media URLs (`secure_link`) and serves HLS files from disk, rate-limits ingest and slug lookups, restricts `/admin` to `ADMIN_ALLOW_CIDRS`, ships the media access log to the worker over syslog |
| `api`      | Fastify: watch pages (SSR), admin API, tus uploads, telemetry ingest, `/metrics`                                                                                                                                                                                                |
| `worker`   | pg-boss jobs: transcoding (FFmpeg), IP enrichment, visitor matching, notifications, rollups, retention, backups, media-log receiver                                                                                                                                             |
| `postgres` | PostgreSQL 16: metadata, job queue and telemetry (monthly partitions)                                                                                                                                                                                                           |

## Installation

Requirements: Linux server or VM with Docker Engine ≥ 24 and the Compose plugin, 2 vCPU / 4 GB RAM for
light use, disk ≈ 2–3 × the size of the original videos.

```bash
git clone https://github.com/g4ndalfTheCreator/video-poster.git video-share
cd video-share/deploy
cp .env.example .env
```

Edit `deploy/.env`:

```bash
# hostname or LAN IP the viewers use
PUBLIC_HOST=video.lan
PUBLIC_SCHEME=http
POSTGRES_PASSWORD=<long random string>
MEDIA_SIGNING_KEY=<openssl rand -hex 32>
INGEST_SIGNING_KEY=<openssl rand -hex 32>
APP_ENCRYPTION_KEY=<openssl rand -hex 32>
```

Every variable is documented in [`deploy/.env.example`](deploy/.env.example); a missing required value
stops the api/worker with a clear error. Start the stack:

```bash
docker compose up -d --build
docker compose logs api | grep -A3 bootstrap
```

Open `http://<PUBLIC_HOST>/admin/` from an address in `ADMIN_ALLOW_CIDRS` (RFC 1918, loopback, ULA and
CGNAT by default), enter the one-time bootstrap token from the log and create the owner account. TOTP
is mandatory for owners and editors and is set up right after.

### TLS

Put `fullchain.pem` and `privkey.pem` in `deploy/tls/` (for example from `mkcert` or `step-ca` on a
LAN, or an ACME client on a public host), set `PUBLIC_SCHEME=https` and restart nginx. nginx then also
listens on 443 and sends HSTS.

### Behind a reverse proxy or tunnel

Set `EDGE_TRUSTED_PROXIES` to the proxy's address(es) so the viewer IP from `X-Forwarded-For` is used;
otherwise geo-IP, rate limits and the admin allowlist would see the proxy. Publishing on the internet
needs no code changes.

### Operator CLI

```bash
docker compose exec api node apps/api/dist/cli.js bootstrap-token
docker compose exec -e VS_PASSWORD='…' api node apps/api/dist/cli.js create-user alice@example.com editor
docker compose exec -e VS_PASSWORD='…' api node apps/api/dist/cli.js reset-password alice@example.com
docker compose exec api node apps/api/dist/cli.js reset-totp alice@example.com
```

## Updating

```bash
cd deploy
git pull
docker compose pull   # when using published images
docker compose up -d --build
```

Database migrations are forward-only and run automatically when the api starts (under an advisory lock).
Read [`CHANGELOG.md`](CHANGELOG.md) before upgrading; take a backup first (below).

## Backups and restore

- The worker writes a `pg_dump -Fc` every night (`BACKUP_CRON`, default 01:47 UTC) to `BACKUP_DIR` and
  keeps the newest `BACKUP_KEEP` (14); status is shown on the admin _System_ page.
- Back up the media volume with ZFS snapshots or restic.

See [`deploy/RESTORE.md`](deploy/RESTORE.md) for restore steps; restoring a dump into an empty database is
covered by an automated test.

## Monitoring

`/metrics` (Prometheus format, admin network only): HTTP latency histogram, ingested events, queue
lengths, transcode durations, database size, media-volume free space, live sessions. Logs are structured
JSON on stdout without personal data (IP addresses truncated, tokens masked). See
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Development

```bash
pnpm install
pnpm fixtures            # generate test media with ffmpeg
pnpm test                # Vitest (Testcontainers PostgreSQL 16; needs Docker)
pnpm test:e2e            # Playwright against a running stack (E2E_BASE_URL)
pnpm seed:telemetry      # synthetic telemetry for dashboard work (DATABASE_URL)
pnpm --filter @vs/api dev
pnpm --filter @vs/worker dev
pnpm --filter @vs/admin dev   # http://localhost:5173/admin/
```

Conventions for contributors (and Claude Code) are in [`CLAUDE.md`](CLAUDE.md).

IP geolocation by [DB-IP](https://db-ip.com) (CC BY 4.0) when `GEOIP_AUTO_UPDATE=dbip`.
