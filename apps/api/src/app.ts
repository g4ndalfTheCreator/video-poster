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

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string | null;
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

  app.decorateRequest('clientIp', null);
  app.addHook('onRequest', async (req) => {
    req.clientIp = resolveClientIp(
      req.socket.remoteAddress,
      req.headers['x-forwarded-for'],
      ctx.config.TRUSTED_PROXIES,
    );
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
  return app;
}
