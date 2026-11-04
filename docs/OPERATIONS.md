# Operations

## Services and volumes

| Volume                   | Contents                                                                    | Backup                             |
| ------------------------ | --------------------------------------------------------------------------- | ---------------------------------- |
| `pgdata` (`PG_DIR`)      | PostgreSQL data                                                             | nightly `pg_dump` (worker)         |
| `media` (`MEDIA_DIR`)    | originals, HLS versions, posters, sprites, attachments, uploads in progress | ZFS snapshot / restic              |
| `geoip` (`GEOIP_DIR`)    | `*city*.mmdb`, `*asn*.mmdb`                                                 | not needed (re-downloaded monthly) |
| `backups` (`BACKUP_DIR`) | database dumps                                                              | copy off-host                      |

Recommended for the media dataset on ZFS: `recordsize=1M`, `compression=off` (video does not compress).

## Scheduled jobs (worker)

| Job                          | Schedule (UTC)        | Purpose                                                      |
| ---------------------------- | --------------------- | ------------------------------------------------------------ |
| `close_sessions` + `rollups` | every 5 min           | close idle sessions, refresh today's rollups and retention   |
| `rollups_nightly`            | 01:31                 | recompute yesterday                                          |
| `backup`                     | `BACKUP_CRON` (01:47) | `pg_dump -Fc`, keep `BACKUP_KEEP`                            |
| `partitions`                 | 02:17                 | create monthly partitions 3 months ahead                     |
| `retention`                  | 03:13                 | apply retention settings, archive old segment-log partitions |
| `purge_trash`                | 03:43                 | delete videos in the trash for 30 days                       |
| `geoip_update`               | 04:23 on the 3rd      | DB-IP Lite download (`GEOIP_AUTO_UPDATE`)                    |
| `tor_list`                   | hourly                | Tor exit list (only when external lookups are enabled)       |

Scale transcoding with `TRANSCODE_CONCURRENCY` or `docker compose up -d --scale worker=N` (the syslog
receiver then runs in every worker; nginx sends to the address `worker` resolves to).

## Monitoring

Scrape `http://<host>/metrics` from an address in `ADMIN_ALLOW_CIDRS`:

```yaml
scrape_configs:
  - job_name: video-share
    metrics_path: /metrics
    static_configs: [{ targets: ['video.lan:80'] }]
```

Useful alerts: `vs_queue_jobs{state="failed"} > 0`, `vs_media_disk_free_bytes < 20e9`,
`time() - <backup status>` via the System page, high `vs_http_request_duration_seconds` p95.

Read-only API tokens (_Settings → API tokens_) give Grafana or scripts access to
`/api/admin/analytics/*` with `Authorization: Bearer vst_…`.

## Logs

All services log JSON to stdout (`docker compose logs -f api worker`). The api and nginx truncate IP
addresses to /24 (/48) and mask tokens in URLs; viewer telemetry is only in the database.

## Security checklist

- Keep `/admin` and `/metrics` off the internet (`ADMIN_ALLOW_CIDRS`, or a separate `ADMIN_HOST`). On a
  VPS use `ADMIN_LISTENER=private` and an SSH tunnel or VPN — see [VPS.md](VPS.md).
- Add a notification channel: owners are alerted about sign-ins from new addresses and lockouts.
- Use TLS for anything beyond a trusted LAN.
- Rotate `MEDIA_SIGNING_KEY` / `INGEST_SIGNING_KEY` if leaked (active playback URLs expire within 6 h /
  24 h). `APP_ENCRYPTION_KEY` encrypts notification credentials — re-enter channels after rotating it.
- CI runs `pnpm audit` and produces a CycloneDX SBOM artifact for each build.
