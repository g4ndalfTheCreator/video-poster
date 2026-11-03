import { readdir } from 'node:fs/promises';
import path from 'node:path';
import maxmind, { type Reader, type CityResponse, type AsnResponse } from 'maxmind';
import { isLanIp, normalizeIp } from './ip.js';

export interface GeoResult {
  country: string | null;
  region: string | null;
  city: string | null;
  asn: number | null;
  asOrg: string | null;
}

const EMPTY: GeoResult = { country: null, region: null, city: null, asn: null, asOrg: null };

/**
 * Local GeoIP lookups (MaxMind GeoLite2 or DB-IP Lite, both in mmdb format). Any `*city*.mmdb` and
 * `*asn*.mmdb` in GEOIP_DIR are used; files are re-read when they change. Missing files → empty results.
 */
export class GeoIp {
  private constructor(
    private city: Reader<CityResponse> | null,
    private asn: Reader<AsnResponse> | null,
  ) {}

  static empty(): GeoIp {
    return new GeoIp(null, null);
  }

  static async open(dir: string): Promise<GeoIp> {
    const files = await readdir(dir).catch(() => [] as string[]);
    const pick = (re: RegExp) =>
      files
        .filter((f) => f.endsWith('.mmdb') && re.test(f))
        .sort()
        .pop();
    const open = async <T extends object>(f: string | undefined) =>
      f
        ? await maxmind
            .open<T>(path.join(dir, f), { watchForUpdates: true, watchForUpdatesNonPersistent: true })
            .catch(() => null)
        : null;
    return new GeoIp(await open<CityResponse>(pick(/city/i)), await open<AsnResponse>(pick(/asn/i)));
  }

  get available(): { city: boolean; asn: boolean } {
    return { city: !!this.city, asn: !!this.asn };
  }

  lookup(ipRaw: string | null | undefined): GeoResult {
    const ip = normalizeIp(ipRaw);
    if (!ip || isLanIp(ip)) return EMPTY;
    let r: GeoResult = { ...EMPTY };
    try {
      const c = this.city?.get(ip);
      if (c) {
        r = {
          ...r,
          country: c.country?.iso_code ?? c.registered_country?.iso_code ?? null,
          region: c.subdivisions?.[0]?.names?.en ?? null,
          city: c.city?.names?.en ?? null,
        };
      }
      const a = this.asn?.get(ip);
      if (a)
        r = {
          ...r,
          asn: a.autonomous_system_number ?? null,
          asOrg: a.autonomous_system_organization ?? null,
        };
    } catch {
      /* corrupt or unsupported database: ignore */
    }
    return r;
  }
}

let shared: { at: number; db: Promise<GeoIp> } | undefined;
/** Shared instance; if databases were missing it retries every 10 minutes (they may be downloaded later). */
export function geoIp(dir: string): Promise<GeoIp> {
  if (!shared) shared = { at: Date.now(), db: GeoIp.open(dir) };
  else if (Date.now() - shared.at > 10 * 60_000) {
    const prev = shared;
    shared = {
      at: Date.now(),
      db: prev.db.then((g) => (g.available.city && g.available.asn ? g : GeoIp.open(dir))),
    };
  }
  return shared.db;
}
