# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/player/package.json packages/player/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG BUILD_VERSION=dev
RUN pnpm --filter @vs/player build && pnpm --filter @vs/admin build \
 && pnpm --filter @vs/api build && pnpm --filter @vs/worker build

FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/player/package.json packages/player/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod \
    --filter @vs/api --filter @vs/worker --filter @vs/core --filter @vs/shared

# ---- api + worker image (same image, different command)
FROM ${NODE_IMAGE} AS app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 app && useradd -u 10001 -g app -M -s /usr/sbin/nologin app \
 && mkdir -p /srv/media /srv/geoip /tmp/vs && chown -R app:app /srv/media /tmp/vs
WORKDIR /app
COPY --from=prod-deps /app ./
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/packages/player/dist packages/player/dist
ARG BUILD_VERSION=dev
ENV NODE_ENV=production BUILD_VERSION=${BUILD_VERSION} MEDIA_ROOT=/srv/media GEOIP_DIR=/srv/geoip \
    PLAYER_DIST=/app/packages/player/dist MIGRATIONS_DIR=/app/apps/api/dist/migrations
USER app
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]

# ---- nginx with the admin SPA and player bundle baked in
FROM nginxinc/nginx-unprivileged:1.27-alpine AS nginx
USER root
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/templates/ /etc/nginx/templates/
COPY deploy/nginx/40-video-share.sh /docker-entrypoint.d/40-video-share.sh
COPY --from=build /app/apps/admin/dist /usr/share/nginx/admin
COPY --from=build /app/packages/player/dist /usr/share/nginx/static
RUN chmod +x /docker-entrypoint.d/40-video-share.sh && mkdir -p /etc/nginx/generated /usr/share/nginx/empty \
 && chown -R 101:101 /etc/nginx/generated /etc/nginx/conf.d
USER 101
