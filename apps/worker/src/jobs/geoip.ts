import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { Logger } from 'pino';
import type { Config } from '@vs/core';

/**
 * Downloads the current month's DB-IP Lite City and ASN databases (mmdb, CC BY 4.0) into GEOIP_DIR.
 * Files from MaxMind or others placed there manually are left alone. No viewer data is sent.
 */
export async function updateGeoIp(
  config: Config,
  log: Logger,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  if (config.GEOIP_AUTO_UPDATE !== 'dbip') return [];
  await mkdir(config.GEOIP_DIR, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  const updated: string[] = [];
  for (const kind of ['city', 'asn'] as const) {
    const target = path.join(config.GEOIP_DIR, `dbip-${kind}-lite.mmdb`);
    const st = await stat(target).catch(() => null);
    if (st && st.mtime.toISOString().slice(0, 7) === month) continue;
    const url = `https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`;
    const res = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) {
      log.warn({ url, status: res.status }, 'geoip download failed');
      continue;
    }
    const tmp = `${target}.tmp`;
    await pipeline(Readable.fromWeb(res.body as never), createGunzip(), createWriteStream(tmp));
    await rename(tmp, target);
    updated.push(target);
  }
  // remove stale temp files from interrupted downloads
  for (const f of await readdir(config.GEOIP_DIR))
    if (f.endsWith('.tmp')) await rm(path.join(config.GEOIP_DIR, f), { force: true });
  if (updated.length) log.info({ updated }, 'geoip databases updated');
  return updated;
}
