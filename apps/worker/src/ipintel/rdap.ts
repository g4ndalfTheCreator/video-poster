import ipaddr from 'ipaddr.js';

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5000;
// Strips control characters and angle brackets from untrusted registry data.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f<>]/g;
const clean = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.replace(CONTROL, '').trim().slice(0, max) : null;

export interface RdapResult {
  netname: string | null;
  cidr: string | null;
  org: string | null;
  orgHandle: string | null;
  country: string | null;
  abuseEmail: string | null;
}

type Fetcher = typeof fetch;
let bootstrap: { at: number; v4: [string[], string[]][]; v6: [string[], string[]][] } | null = null;
let lastRequest = 0;

async function getJson(fetcher: Fetcher, url: string, accept: string): Promise<unknown> {
  // At most one RDAP request per second from this process (registries rate-limit aggressively).
  const wait = lastRequest + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetcher(url, {
    headers: { accept },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error('response too large');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('response too large');
  return JSON.parse(new TextDecoder().decode(buf));
}

async function rdapBase(fetcher: Fetcher, ip: ipaddr.IPv4 | ipaddr.IPv6): Promise<string | null> {
  if (!bootstrap || Date.now() - bootstrap.at > 24 * 3600_000) {
    const [v4, v6] = (await Promise.all([
      getJson(fetcher, 'https://data.iana.org/rdap/ipv4.json', 'application/json'),
      getJson(fetcher, 'https://data.iana.org/rdap/ipv6.json', 'application/json'),
    ])) as { services: [string[], string[]][] }[];
    bootstrap = { at: Date.now(), v4: v4!.services, v6: v6!.services };
  }
  let best: { len: number; url: string } | null = null;
  for (const [cidrs, urls] of ip.kind() === 'ipv4' ? bootstrap.v4 : bootstrap.v6) {
    for (const c of cidrs) {
      try {
        const [net, len] = ipaddr.parseCIDR(c);
        if (net.kind() === ip.kind() && ip.match([net, len] as never) && (!best || len > best.len)) {
          best = { len, url: urls.find((u) => u.startsWith('https://')) ?? urls[0]! };
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return best ? (best.url.endsWith('/') ? best.url : `${best.url}/`) : null;
}

interface Entity {
  roles?: string[];
  handle?: string;
  vcardArray?: [string, [string, unknown, string, unknown][]];
  entities?: Entity[];
}

function vcard(e: Entity, field: string): string | null {
  const row = e.vcardArray?.[1]?.find((r) => r[0] === field);
  return row ? clean(row[3]) : null;
}

function walk(entities: Entity[] | undefined, fn: (e: Entity) => void) {
  for (const e of entities ?? []) {
    fn(e);
    walk(e.entities, fn);
  }
}

/** Smallest CIDR covering start–end (IPv4), used when the registry gives no cidr0 extension. */
export function rangeToCidr(start: string, end: string): string | null {
  try {
    const n = (s: string) =>
      BigInt(
        ipaddr.IPv4.parse(s)
          .toByteArray()
          .reduce((x, b) => x * 256 + b, 0),
      );
    const x = n(start) ^ n(end);
    const len = 32 - x.toString(2).replace(/^0$/, '').length;
    const net = (n(start) >> BigInt(32 - len)) << BigInt(32 - len);
    const ip = [24, 16, 8, 0].map((sh) => Number((net >> BigInt(sh)) & 255n)).join('.');
    return `${ip}/${len}`;
  } catch {
    return null;
  }
}

/** RDAP lookup via the IANA bootstrap registry. Responses are untrusted: size-limited and sanitised. */
export async function rdapLookup(ipStr: string, fetcher: Fetcher = fetch): Promise<RdapResult | null> {
  const ip = ipaddr.parse(ipStr);
  const base = await rdapBase(fetcher, ip);
  if (!base) return null;
  const j = (await getJson(
    fetcher,
    `${base}ip/${ipStr}`,
    'application/rdap+json, application/json',
  )) as Record<string, unknown> & {
    entities?: Entity[];
    cidr0_cidrs?: { v4prefix?: string; v6prefix?: string; length?: number }[];
    startAddress?: string;
    endAddress?: string;
  };
  let org: string | null = null;
  let orgHandle: string | null = null;
  let abuse: string | null = null;
  walk(j.entities, (e) => {
    const roles = e.roles ?? [];
    if (!org && (roles.includes('registrant') || roles.includes('administrative'))) {
      org = vcard(e, 'org') ?? vcard(e, 'fn');
      orgHandle = clean(e.handle, 100);
    }
    if (!abuse && roles.includes('abuse')) abuse = vcard(e, 'email');
  });
  const c0 = j.cidr0_cidrs?.[0];
  const cidr =
    c0 && c0.length !== undefined
      ? `${c0.v4prefix ?? c0.v6prefix}/${c0.length}`
      : j.startAddress && j.endAddress && !j.startAddress.includes(':')
        ? rangeToCidr(j.startAddress, j.endAddress)
        : null;
  return {
    netname: clean(j.name, 100),
    cidr: cidr && /^[0-9a-f:.]+\/\d{1,3}$/i.test(cidr) ? cidr : null,
    org,
    orgHandle,
    country: clean(j.country, 2),
    abuseEmail: abuse ? clean(abuse, 254) : null,
  };
}
