# CLAUDE.md – conventions for video-share

Self-hosted short-video sharing with per-link viewer telemetry. The full specification (Finnish) is in
`docs/SPEC.md`; every deviation from it is recorded in `docs/DECISIONS.md` with a rationale.

## Layout

```
apps/api/         Fastify 5: public pages (SSR), admin API, tus uploads, telemetry ingest
apps/worker/      pg-boss consumers: transcode, ip_enrich, match_visitor, notify, rollups, retention,
                  nginx media-log (syslog) receiver
apps/admin/       React 19 SPA served by nginx at /admin
packages/shared/  zod schemas, event types, constants, pure metric helpers (browser + node)
packages/core/    server-only code shared by api + worker: config, db, migrations, crypto, ip, queues
packages/player/  hls.js player + telemetry SDK + browser profile (esbuild bundle → /static/player.js)
deploy/           docker-compose.yml, nginx config, .env.example, RESTORE.md
e2e/              Playwright tests against the running compose stack
test/             Vitest global setup (Testcontainers Postgres) and helpers
```

## Commands

```bash
pnpm install
pnpm typecheck        # tsc project references + test files
pnpm lint             # eslint
pnpm format           # prettier --write
pnpm test             # vitest (starts postgres:16 with Testcontainers; or set TEST_DATABASE_URL)
pnpm test:e2e         # playwright against E2E_BASE_URL (default http://127.0.0.1:8080)
pnpm build            # player, admin, api, worker
pnpm seed:telemetry   # synthetic telemetry for dashboard development
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

## Conventions

- TypeScript `strict`, ESM, Node 22. No `any` without an explanatory comment.
- Code, identifiers and comments in English; UI strings only via i18n files (`apps/admin/src/i18n/{fi,en}.json`,
  `apps/api/src/i18n/*.ts` for the public page).
- Shared types and zod schemas live only in `packages/shared`. Server-only helpers in `packages/core`.
- Every database change is a new forward-only SQL file `packages/core/src/migrations/NNNN_name.sql`; the api
  applies them on startup under an advisory lock. Drizzle table definitions in `packages/core/src/schema.ts`
  must be kept in sync for tables queried through Drizzle.
- API errors are always `{ error: { code, message, details? } }` (throw `HttpError` from `apps/api/src/lib/errors.ts`).
- Every admin mutation writes an `audit_log` row. Role checks happen in route `preValidation` hooks
  (`requireRole('editor')`); `viewer` is read-only.
- Apps (`apps/api`, `apps/worker`) must list every npm package they import at runtime, including the runtime
  deps of `@vs/core`/`@vs/shared` (pnpm strict layout; esbuild keeps them external).
- No third-party SaaS, CDNs, fonts or analytics. The public page loads only same-origin resources.
- Small Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- When the spec is ambiguous: pick the simplest safe option, record it in `docs/DECISIONS.md`, continue.
