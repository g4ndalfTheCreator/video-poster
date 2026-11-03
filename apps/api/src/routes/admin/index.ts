import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { registerAdminGuards } from '../../plugins/auth.js';
import { authRoutes } from './auth.js';
import { userRoutes } from './users.js';
import { settingsRoutes } from './settings.js';
import { uploadRoutes } from './uploads.js';
import { videoRoutes } from './videos.js';
import { linkRoutes } from './links.js';
import { channelRoutes } from './channels.js';
import { analyticsRoutes } from './analytics.js';
import multipart from '@fastify/multipart';
import { PgNotifications } from '../../lib/notify.js';

/** Everything under /api/admin. Guards are encapsulated to this scope. */
export async function adminApi(app: FastifyInstance, ctx: AppContext) {
  registerAdminGuards(app, ctx);
  await authRoutes(app, ctx);
  await userRoutes(app, ctx);
  await settingsRoutes(app, ctx);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10 } });
  const notifications = new PgNotifications(ctx.database.sql);
  app.addHook('onClose', () => notifications.close());
  await uploadRoutes(app, ctx);
  await videoRoutes(app, ctx, notifications);
  await linkRoutes(app, ctx);
  await channelRoutes(app, ctx);
  await analyticsRoutes(app, ctx);
}
