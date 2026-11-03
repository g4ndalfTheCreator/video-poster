# Restoring video-share

A complete restore needs the newest database dump **and** the media volume from the same point in time
(media files referenced by the database must exist).

## 1. Database dump

Dumps are written nightly by the worker to `BACKUP_DIR` (`/srv/backups` in the container, a named volume
`backups` by default) as `videoshare-<timestamp>.dump` (`pg_dump -Fc`). Take one manually with:

```bash
docker compose exec worker node -e "require('child_process').execFileSync('pg_dump',['-Fc','-f','/srv/backups/manual.dump',process.env.DATABASE_URL],{stdio:'inherit'})"
```

## 2. Restore into an empty database

```bash
cd deploy
docker compose stop api worker nginx
# copy the dump next to the postgres container
docker compose cp ./videoshare-2026-11-03T01-47-00.dump postgres:/tmp/restore.dump
docker compose exec postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error /tmp/restore.dump'
docker compose start api worker nginx
```

The api applies any newer migrations on start. The procedure is exercised by the automated test
`apps/worker/test/ops.test.ts` (dump → restore into an empty database → row counts compared).

## 3. Media

Restore `MEDIA_DIR` (originals, HLS versions, assets) from your ZFS snapshot or restic repository so that
it matches the database dump. Example with restic:

```bash
restic -r /backup/restic restore latest --target / --include /srv/video-share/media
```

Ownership must be uid/gid 10001 (`chown -R 10001:10001 /srv/video-share/media`).

## 4. Check

- `curl http://<host>/healthz` → `{"status":"ok"}`
- Admin _System_ page: queues empty, disk free, backup status
- Open one link and play the video.
