import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, getSettings, putSettings, diffObjects } from '@vs/core';
import { settingsPatchSchema } from '@vs/shared';
import type { AppContext } from '../../context.js';
import { requireRecentAuth, requireRole } from '../../plugins/auth.js';

export async function settingsRoutes(fastify: FastifyInstance, ctx: AppContext) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.database.sql;

  app.get('/settings', async () => getSettings(sql, true));

  app.put(
    '/settings',
    { preValidation: [requireRole('owner'), requireRecentAuth(ctx)], schema: { body: settingsPatchSchema } },
    async (req) => {
      const before = await getSettings(sql, true);
      const next = await putSettings(sql, req.body);
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'settings.update',
        entity: 'settings',
        entityId: 'app',
        diff: diffObjects(
          before as unknown as Record<string, unknown>,
          next as unknown as Record<string, unknown>,
        ),
        ip: req.clientIp,
      });
      return next;
    },
  );
}
