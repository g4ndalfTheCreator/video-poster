import { execFileSync } from 'node:child_process';
import { totpAt, currentStep } from '../apps/api/src/lib/totp.js';

/**
 * Runs the operator CLI inside the api container. Override with E2E_EXEC, e.g.
 * E2E_EXEC="node apps/api/dist/cli.js" when the api runs locally.
 */
export function cli(args: string[], env: Record<string, string> = {}): string {
  const exec = (
    process.env.E2E_EXEC ?? 'docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T'
  ).split(' ');
  const envArgs = Object.entries(env).flatMap(([k, v]) => (exec.includes('exec') ? ['-e', `${k}=${v}`] : []));
  const cmd = exec.includes('exec')
    ? [...exec.slice(1), ...envArgs, 'api', 'node', 'apps/api/dist/cli.js', ...args]
    : [...exec.slice(1), ...args];
  return execFileSync(exec[0]!, cmd, { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
}

/** Runs SQL in the compose stack's postgres (null when E2E_EXEC points to a local api instead). */
export function psql(query: string): string | null {
  if (process.env.E2E_EXEC) return null;
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'deploy/docker-compose.yml',
      '--env-file',
      'deploy/.env',
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      'psql -v ON_ERROR_STOP=1 -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$0"',
      query,
    ],
    { encoding: 'utf8' },
  ).trim();
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/** Code for the next TOTP step (the current one may already have been used for enrollment). */
export function nextCode(secret: string, offset = 1): string {
  return totpAt(secret, currentStep() + offset);
}

export { totpAt, currentStep };
