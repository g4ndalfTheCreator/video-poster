import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true' || v === 'yes');
const csv = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
const key = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(32, `${name} must be at least 32 characters (use: openssl rand -hex 32)`);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PUBLIC_HOST: z.string().min(1, 'PUBLIC_HOST is required'),
  PUBLIC_SCHEME: z.enum(['http', 'https']).default('https'),
  ADMIN_HOST: z.string().optional(),
  ADMIN_ALLOW_CIDRS: csv(
    '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7,100.64.0.0/10',
  ),
  TRUSTED_PROXIES: csv('127.0.0.1/32,::1/128,172.16.0.0/12'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MEDIA_ROOT: z.string().default('/srv/media'),
  /** When true, file downloads are handed to nginx with X-Accel-Redirect (/_protected/). */
  MEDIA_ACCEL: bool,
  GEOIP_DIR: z.string().default('/srv/geoip'),
  MEDIA_SIGNING_KEY: key('MEDIA_SIGNING_KEY'),
  INGEST_SIGNING_KEY: key('INGEST_SIGNING_KEY'),
  APP_ENCRYPTION_KEY: z
    .string({ error: 'APP_ENCRYPTION_KEY is required' })
    .regex(/^[0-9a-fA-F]{64}$/, 'APP_ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 ** 3),
  MAX_DURATION_S: z.coerce.number().int().positive().default(900),
  TRANSCODE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  TRANSCODE_PRESET: z.string().default('medium'),
  MEDIA_TOKEN_TTL_S: z.coerce
    .number()
    .int()
    .positive()
    .default(6 * 3600),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  SYSLOG_PORT: z.coerce.number().int().default(5514),
  LOG_LEVEL: z.string().default('info'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('video-share@localhost'),
  SMTP_SECURE: bool,
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  DNS_RESOLVER: z.string().optional(),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === '1' || v === 'true')),
  BUILD_VERSION: z.string().default('dev'),
});

export type Config = z.infer<typeof envSchema> & {
  publicOrigin: string;
  cookieSecure: boolean;
};

let cached: Config | undefined;

export class ConfigError extends Error {}

/** Parses the environment. Throws a readable error listing every missing/invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (common in .env files) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}\nSee deploy/.env.example.`);
  }
  const c = parsed.data;
  return {
    ...c,
    publicOrigin: `${c.PUBLIC_SCHEME}://${c.PUBLIC_HOST}`,
    cookieSecure: c.COOKIE_SECURE ?? c.PUBLIC_SCHEME === 'https',
  };
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

export function setConfig(c: Config): void {
  cached = c;
}
