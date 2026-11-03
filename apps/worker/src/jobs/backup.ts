import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '@vs/core';

export interface BackupStatus {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  file: string | null;
  sizeBytes: number;
  error?: string;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`)),
    );
  });
}

/**
 * Nightly `pg_dump -Fc` into BACKUP_DIR (keeps the newest BACKUP_KEEP dumps) and writes a status file
 * shown on the admin System page. Media files are backed up with ZFS snapshots or restic (see
 * deploy/RESTORE.md).
 */
export async function backupDatabase(
  config: Config,
  log: Logger,
  databaseUrl = config.DATABASE_URL,
): Promise<BackupStatus> {
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(config.BACKUP_DIR, `videoshare-${stamp}.dump`);
  const status: BackupStatus = {
    startedAt: startedAt.toISOString(),
    finishedAt: '',
    ok: false,
    file: null,
    sizeBytes: 0,
  };
  try {
    await mkdir(config.BACKUP_DIR, { recursive: true });
    await run('pg_dump', [
      '--format=custom',
      '--compress=6',
      '--no-owner',
      `--file=${file}.part`,
      databaseUrl,
    ]);
    await rename(`${file}.part`, file);
    status.ok = true;
    status.file = path.basename(file);
    status.sizeBytes = (await stat(file)).size;
    const dumps = (await readdir(config.BACKUP_DIR)).filter((f) => /^videoshare-.*\.dump$/.test(f)).sort();
    for (const old of dumps.slice(0, Math.max(0, dumps.length - config.BACKUP_KEEP)))
      await rm(path.join(config.BACKUP_DIR, old), { force: true });
    log.info({ file: status.file, size: status.sizeBytes }, 'database backup written');
  } catch (e) {
    status.error = (e as Error).message.slice(0, 1000);
    await rm(`${file}.part`, { force: true });
    log.error({ err: status.error }, 'database backup failed');
  }
  status.finishedAt = new Date().toISOString();
  await writeFile(path.join(config.MEDIA_ROOT, '.backup-status.json'), JSON.stringify(status)).catch(
    () => undefined,
  );
  return status;
}
