import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import { resolveClientIp } from '@vs/core';
import type { AppContext } from './context.js';
import { HttpError } from './lib/errors.js';
import { healthRoutes } from './routes/health.js';
import { adminApi } from './routes/admin/index.js';
import { publicRoutes } from './routes/public/watch.js';
import { ingestRoutes } from './routes/public/ingest.js';

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string | null;
  }
  interface FastifyInstance {
    routeList: { method: string; url: string; config: Record<string, unknown> }[];
  }
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('routeList', []);
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat())
      app.routeList.push({ method: m, url: r.url, config: (r.config ?? {}) as Record<string, unknown> });
  });
  app.decorateRequest('clientIp', null);
  app.addHook('onRequest', async (req) => {
    req.clientIp = resolveClientIp(
      req.socket.remoteAddress,
      req.headers['x-forwarded-for'],
      ctx.config.TRUSTED_PROXIES,
    );
  });

  // Baseline security headers for every response (HTML pages set a stricter, page-specific set).
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.getHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.getHeader('referrer-policy'))
      reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (
      !reply.getHeader('x-frame-options') &&
      !String(reply.getHeader('content-security-policy') ?? '').includes('frame-ancestors *')
    ) {
      reply.header('x-frame-options', 'DENY');
    }
    if (!reply.getHeader('content-security-policy'))
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (!reply.getHeader('permissions-policy'))
      reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (ctx.config.PUBLIC_SCHEME === 'https' && !reply.getHeader('strict-transport-security'))
      reply.header('strict-transport-security', 'max-age=31536000');
  });

  await app.register(cookie);
  await app.register(formbody, { bodyLimit: 16 * 1024 });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'request validation failed', details: err.validation },
      });
    }
    if (err instanceof HttpError) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: { code: (err as { code?: string }).code ?? 'bad_request', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'internal server error' } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'not found' } }),
  );

  await healthRoutes(app, ctx);
  await app.register(async (scope) => adminApi(scope, ctx), { prefix: '/api/admin' });
  await app.register(async (scope) => publicRoutes(scope, ctx));
  await app.register(async (scope) => ingestRoutes(scope, ctx));
  return app;
}
