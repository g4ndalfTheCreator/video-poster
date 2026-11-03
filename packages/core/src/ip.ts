import ipaddr from 'ipaddr.js';

export type ParsedIp = ipaddr.IPv4 | ipaddr.IPv6;

export function parseIp(ip: string | undefined | null): ParsedIp | null {
  if (!ip) return null;
  try {
    const parsed = ipaddr.parse(ip.trim());
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeIp(ip: string | undefined | null): string | null {
  return parseIp(ip)?.toString() ?? null;
}

export function parseCidr(cidr: string): [ParsedIp, number] | null {
  try {
    if (!cidr.includes('/')) {
      const ip = parseIp(cidr);
      return ip ? [ip, ip.kind() === 'ipv4' ? 32 : 128] : null;
    }
    return ipaddr.parseCIDR(cidr);
  } catch {
    return null;
  }
}

export function ipInCidrs(ip: string | null | undefined, cidrs: readonly string[]): boolean {
  const addr = parseIp(ip);
  if (!addr) return false;
  for (const c of cidrs) {
    const range = parseCidr(c);
    if (!range) continue;
    if (range[0].kind() !== addr.kind()) continue;
    if (addr.match(range as [ipaddr.IPv4, number] & [ipaddr.IPv6, number])) return true;
  }
  return false;
}

/** IPv4 → /24, IPv6 → /48 (network address with prefix). */
export function truncateIp(ip: string | null | undefined): string | null {
  const addr = parseIp(ip);
  if (!addr) return null;
  if (addr.kind() === 'ipv4') {
    const b = addr.toByteArray();
    return `${b[0]}.${b[1]}.${b[2]}.0/24`;
  }
  const parts = (addr as ipaddr.IPv6).parts.slice(0, 3);
  return `${parts.map((p) => p.toString(16)).join(':')}::/48`;
}

const LAN_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '0.0.0.0/8',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  '::/128',
];

/** RFC1918, CGNAT, loopback, link-local and IPv6 ULA. */
export function isLanIp(ip: string | null | undefined): boolean {
  return ipInCidrs(ip, LAN_CIDRS);
}

/**
 * Resolves the client IP from the socket address and X-Forwarded-For, trusting XFF hops only
 * when they come from TRUSTED_PROXIES (walks the chain from the right).
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  xff: string | string[] | undefined,
  trusted: readonly string[],
): string | null {
  let current = normalizeIp(remoteAddress);
  if (!current) return null;
  const header = Array.isArray(xff) ? xff.join(',') : (xff ?? '');
  const hops = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  while (ipInCidrs(current, trusted) && hops.length) {
    const next = normalizeIp(hops.pop());
    if (!next) break;
    current = next;
  }
  return current;
}
