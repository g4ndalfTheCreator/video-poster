import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { registerAdminGuards } from '../../plugins/auth.js';
import { authRoutes } from './auth.js';
import { userRoutes } from './users.js';
import { settingsRoutes } from './settings.js';

/** Everything under /api/admin. Guards are encapsulated to this scope. */
export async function adminApi(app: FastifyInstance, ctx: AppContext) {
  registerAdminGuards(app, ctx);
  await authRoutes(app, ctx);
  await userRoutes(app, ctx);
  await settingsRoutes(app, ctx);
}
