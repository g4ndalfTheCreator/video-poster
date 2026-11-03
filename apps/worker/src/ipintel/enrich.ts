import { Resolver } from 'node:dns/promises';
import type { Logger } from 'pino';
import { geoIp, getSettings, isLanIp, normalizeIp, parseIp, newId, type Config, type Sql } from '@vs/core';
import { classifyNetwork } from './classify.js';
import { rdapLookup, type RdapResult } from './rdap.js';

export interface DnsLike {
  reverse(ip: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

export interface EnrichDeps {
  sql: Sql;
  config: Config;
  log: Logger;
  fetcher?: typeof fetch;
  resolver?: DnsLike;
}

const TTL_DAYS = 30;

async function ptrLookup(
  r: EnrichDeps['resolver'],
  ip: string,
): Promise<{ ptr: string | null; confirmed: boolean | null }> {
  if (!r) return { ptr: null, confirmed: null };
  try {
    const names = await r.reverse(ip);
    const ptr = names[0]?.slice(0, 253) ?? null;
    if (!ptr) return { ptr: null, confirmed: null };
    const fwd = await (ip.includes(':') ? r.resolve6(ptr) : r.resolve4(ptr)).catch(() => [] as string[]);
    return { ptr, confirmed: fwd.some((a) => normalizeIp(a) === ip) };
  } catch {
    return { ptr: null, confirmed: null };
  }
}

export function defaultResolver(config: Config): Resolver {
  const r = new Resolver({ timeout: 2000, tries: 1 });
  if (config.DNS_RESOLVER) r.setServers(config.DNS_RESOLVER.split(',').map((s) => s.trim()));
  return r;
}

/**
 * Resolves the owner of an IP address: local GeoIP (country, city, ASN), PTR with forward
 * confirmation, RDAP via the IANA bootstrap, network-type classification and admin overrides.
 * LAN addresses never trigger external lookups. Results are cached per IP and RDAP allocation for
 * 30 days. Returns the ip_intel id.
 */
export async function enrichIp(deps: EnrichDeps, rawIp: string): Promise<string | null> {
  const { sql, config, log } = deps;
  const ip = normalizeIp(rawIp);
  if (!ip) return null;
  const cached = await sql<{ id: string }[]>`
    SELECT id FROM ip_intel WHERE ip = ${ip} AND expires_at > now() ORDER BY fetched_at DESC LIMIT 1`;
  let intelId = cached[0]?.id ?? null;

  if (!intelId) {
    const id = newId();
    const expires = new Date(Date.now() + TTL_DAYS * 86400_000);
    const override = await sql<{ org_label: string }[]>`
      SELECT org_label FROM ip_org_overrides WHERE cidr >>= ${ip}::inet ORDER BY masklen(cidr) DESC LIMIT 1`;
    if (isLanIp(ip)) {
      await sql`INSERT INTO ip_intel (id, ip, prefix, network_type, org_guess, confidence, expires_at)
                VALUES (${id}, ${ip}, NULL, 'lan', ${override[0]?.org_label ?? 'LAN'}, 'high', ${expires})`;
    } else {
      const settings = await getSettings(sql);
      const geo = (await geoIp(config.GEOIP_DIR)).lookup(ip);
      const [ptr, rdap, tor] = await Promise.all([
        settings.ipIntel.ptrEnabled
          ? ptrLookup(deps.resolver, ip)
          : Promise.resolve({ ptr: null, confirmed: null }),
        settings.ipIntel.rdapEnabled ? cachedRdap(deps, ip) : Promise.resolve(null),
        sql`SELECT 1 FROM tor_exits WHERE ip = ${ip}::inet`,
      ]);
      const c = classifyNetwork({
        asn: geo.asn,
        asOrg: geo.asOrg,
        ptr: ptr.ptr,
        ptrConfirmed: ptr.confirmed,
        rdapOrg: rdap?.org ?? null,
        rdapNetname: rdap?.netname ?? null,
        city: geo.city,
        isTor: tor.length > 0,
      });
      const prefix = rdap?.cidr ?? (parseIp(ip)!.kind() === 'ipv4' ? ip.replace(/\.\d+$/, '.0/24') : null);
      await sql`
        INSERT INTO ip_intel (id, ip, prefix, asn, as_org, rdap_netname, rdap_cidr, rdap_org, rdap_org_handle, rdap_country, abuse_email,
                              ptr, ptr_confirmed, network_type, org_guess, confidence, country, region, city, expires_at)
        VALUES (${id}, ${ip}, ${prefix}, ${geo.asn}, ${geo.asOrg}, ${rdap?.netname ?? null}, ${rdap?.cidr ?? null}, ${rdap?.org ?? null},
                ${rdap?.orgHandle ?? null}, ${rdap?.country ?? null}, ${rdap?.abuseEmail ?? null}, ${ptr.ptr}, ${ptr.confirmed},
                ${c.networkType}, ${override[0]?.org_label ?? c.orgGuess}, ${override[0] ? 'high' : c.confidence},
                ${geo.country ?? rdap?.country ?? null}, ${geo.region}, ${geo.city}, ${expires})`;
      log.debug({ type: c.networkType }, 'ip enriched');
    }
    intelId = id;
  }
  // Attach to sessions and previews from this IP that have no intel yet.
  await sql`
    UPDATE view_sessions s SET ip_intel_id = ${intelId},
      country = coalesce(s.country, i.country), region = coalesce(s.region, i.region), city = coalesce(s.city, i.city),
      asn = coalesce(s.asn, i.asn), as_org = coalesce(s.as_org, i.as_org)
    FROM ip_intel i WHERE i.id = ${intelId} AND s.ip = ${ip}::inet AND s.ip_intel_id IS NULL`;
  await sql`
    UPDATE link_previews p SET ip_intel_id = ${intelId}, country = coalesce(p.country, i.country)
    FROM ip_intel i WHERE i.id = ${intelId} AND p.ip = ${ip}::inet AND p.ip_intel_id IS NULL`;
  return intelId;
}

/** RDAP data is cached per allocation: an address inside a known, fresh allocation reuses it. */
async function cachedRdap(deps: EnrichDeps, ip: string): Promise<RdapResult | null> {
  const hit = await deps.sql<
    {
      rdap_netname: string | null;
      rdap_cidr: string;
      rdap_org: string | null;
      rdap_org_handle: string | null;
      rdap_country: string | null;
      abuse_email: string | null;
    }[]
  >`
    SELECT rdap_netname, rdap_cidr, rdap_org, rdap_org_handle, rdap_country, abuse_email FROM ip_intel
    WHERE rdap_cidr IS NOT NULL AND rdap_cidr::cidr >>= ${ip}::inet AND fetched_at > now() - interval '30 days'
    ORDER BY masklen(rdap_cidr::cidr) DESC LIMIT 1`;
  if (hit[0]) {
    const h = hit[0];
    return {
      netname: h.rdap_netname,
      cidr: h.rdap_cidr,
      org: h.rdap_org,
      orgHandle: h.rdap_org_handle,
      country: h.rdap_country,
      abuseEmail: h.abuse_email,
    };
  }
  try {
    return await rdapLookup(ip, deps.fetcher ?? fetch);
  } catch (err) {
    deps.log.warn({ err: (err as Error).message }, 'rdap lookup failed');
    return null;
  }
}

/** Refreshes the Tor exit list (hourly). */
export async function refreshTorExits(deps: EnrichDeps): Promise<number> {
  const settings = await getSettings(deps.sql);
  if (!settings.ipIntel.rdapEnabled) return 0;
  const res = await (deps.fetcher ?? fetch)('https://check.torproject.org/torbulkexitlist', {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`tor list HTTP ${res.status}`);
  const ips = (await res.text())
    .split('\n')
    .map((l) => normalizeIp(l.trim()))
    .filter((x): x is string => !!x)
    .slice(0, 50_000);
  await deps.sql.begin(async (tx) => {
    await tx`DELETE FROM tor_exits`;
    for (let i = 0; i < ips.length; i += 1000) {
      const chunk = ips.slice(i, i + 1000).map((ip) => ({ ip }));
      await tx`INSERT INTO tor_exits ${tx(chunk as never, 'ip')} ON CONFLICT DO NOTHING`;
    }
  });
  return ips.length;
}
