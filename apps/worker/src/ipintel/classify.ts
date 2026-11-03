import type { Confidence, NetworkType } from '@vs/shared';

/** Maintained ASN lists (extend as needed). */
export const HOSTING_ASNS: Record<number, string> = {
  16509: 'AWS',
  14618: 'AWS',
  8987: 'AWS',
  8075: 'Microsoft Azure',
  15169: 'Google Cloud',
  396982: 'Google Cloud',
  19527: 'Google',
  24940: 'Hetzner',
  213230: 'Hetzner',
  16276: 'OVH',
  14061: 'DigitalOcean',
  63949: 'Akamai Linode',
  20473: 'Vultr',
  31898: 'Oracle Cloud',
  12876: 'Scaleway',
  202053: 'UpCloud',
  45102: 'Alibaba Cloud',
  37963: 'Alibaba Cloud',
  132203: 'Tencent Cloud',
  36351: 'IBM Cloud',
  51167: 'Contabo',
  60781: 'Leaseweb',
  28753: 'Leaseweb',
  47583: 'Hostinger',
  36007: 'Kamatera',
  54113: 'Fastly',
  20940: 'Akamai',
  9009: 'M247',
  60068: 'Datacamp/CDN77',
  197540: 'netcup',
  8560: 'IONOS',
  25369: 'Hydra/Banda26',
  210644: 'AEZA',
  62240: 'Clouvider',
};
export const SECURITY_PROXY_ASNS: Record<number, string> = {
  53813: 'Zscaler',
  62044: 'Zscaler',
  22616: 'Zscaler',
  55256: 'Netskope',
  36692: 'Cisco Umbrella',
  54538: 'Palo Alto Prisma Access',
  13335: 'Cloudflare (WARP/Zero Trust)',
  44444: 'Forcepoint',
  393326: 'Menlo Security',
  137922: 'iboss',
};
export const VPN_ASNS: Record<number, string> = {
  62371: 'Proton VPN',
  209103: 'Proton VPN',
  207137: 'NordVPN',
  39351: 'Mullvad',
  212238: 'Datacamp (VPN)',
  136787: 'TEFINCOM (NordVPN)',
};

const ISP_RE =
  /telecom|telekom|telia|elisa|\bdna\b|tele2|telenor|vodafone|orange|comcast|verizon|at&t|charter|spectrum|\bcox\b|\bbt\b|virgin|\bsky\b|kpn|swisscom|proximus|\bo2\b|t-mobile|deutsche telekom|communications|broadband|cable|\bisp\b|kabel|fib(re|er)|mobile|wireless|anvia|lounea|kaisanet|netplaza|valokuitu|cinia|telefonica|movistar|free sas|bouygues|sfr|liberty global|ziggo|tdc|lyse|globe|rogers|bell canada|shaw|optus|telstra|jio|airtel|turk telekom|rostelecom/i;
const EDU_RE =
  /universit|college|school|\bedu\b|funet|academ|korkeakoulu|yliopisto|polytechnic|gymnasium|research and education|nren|geant/i;
const MOBILE_PTR_RE = /mobile|\bmbb\b|lte|\b[345]g\b|gprs|umts|cellular|\bcell\b|\bmob\b|wap/i;
const RESIDENTIAL_PTR_RE =
  /dsl|cable|fib(er|re)|ftth|fttx|dhcp|dyn(amic)?|pool|\bcust|home|\bres\b|broadband|\bppp|bb\.|kotiliittym|client|user|subscriber|ip-?\d+-\d+/i;
const BUSINESS_PTR_RE = /static|business|\bbiz\b|corp|yritys|enterprise|\bsme\b/i;

export function ptrDomain(ptr: string | null): string | null {
  if (!ptr) return null;
  const labels = ptr.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2) return null;
  const sld = labels[labels.length - 2]!;
  const take =
    labels.length >= 3 &&
    /^(co|com|ac|org|net|gov|edu|ne|or)$/.test(sld) &&
    labels[labels.length - 1]!.length === 2
      ? 3
      : 2;
  return labels.slice(-take).join('.');
}

const tokens = (s: string | null) =>
  new Set(
    (s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (t) =>
          t.length >= 3 &&
          ![
            'oyj',
            'ltd',
            'inc',
            'gmbh',
            'oy',
            'corp',
            'llc',
            'the',
            'and',
            'net',
            'networks',
            'network',
            'ab',
          ].includes(t),
      ),
  );
const sharesToken = (a: string | null, b: string | null) => [...tokens(a)].some((t) => tokens(b).has(t));

export interface ClassifyInput {
  asn: number | null;
  asOrg: string | null;
  ptr: string | null;
  ptrConfirmed: boolean | null;
  rdapOrg: string | null;
  rdapNetname: string | null;
  city: string | null;
  isTor: boolean;
}

export interface Classification {
  networkType: NetworkType;
  orgGuess: string | null;
  confidence: Confidence;
}

/** Heuristic network type and organisation guess. Never presented as fact: always with a confidence. */
export function classifyNetwork(i: ClassifyInput): Classification {
  const asn = i.asn ?? -1;
  const operator = i.asOrg ?? i.rdapOrg;
  const withCity = (o: string | null) => (o ? (i.city ? `${o}, ${i.city}` : o) : null);
  if (i.isTor) return { networkType: 'tor', orgGuess: 'Tor', confidence: 'low' };
  if (HOSTING_ASNS[asn])
    return { networkType: 'hosting_cloud', orgGuess: HOSTING_ASNS[asn]!, confidence: 'medium' };
  if (SECURITY_PROXY_ASNS[asn])
    return {
      networkType: 'security_proxy',
      orgGuess: `${SECURITY_PROXY_ASNS[asn]} (yritysverkko)`,
      confidence: 'medium',
    };
  if (VPN_ASNS[asn]) return { networkType: 'vpn', orgGuess: VPN_ASNS[asn]!, confidence: 'low' };
  const domain = ptrDomain(i.ptr);
  if (EDU_RE.test(`${i.asOrg ?? ''} ${i.rdapOrg ?? ''}`) || /\.(edu|ac\.[a-z]{2})$/.test(domain ?? '')) {
    return { networkType: 'edu', orgGuess: i.rdapOrg ?? i.asOrg ?? domain, confidence: 'high' };
  }
  if (i.ptr && MOBILE_PTR_RE.test(i.ptr))
    return { networkType: 'mobile', orgGuess: withCity(operator), confidence: 'low' };
  const ispLike = (s: string | null) => !!s && ISP_RE.test(s);
  // Reverse DNS (forward-confirmed) in a domain that is neither the operator's nor ISP-like → the organisation.
  if (
    domain &&
    i.ptrConfirmed &&
    !ispLike(domain) &&
    !sharesToken(domain, i.asOrg) &&
    !RESIDENTIAL_PTR_RE.test(i.ptr ?? '')
  ) {
    return {
      networkType: 'corporate',
      orgGuess: i.rdapOrg && sharesToken(domain, i.rdapOrg) ? i.rdapOrg : domain,
      confidence: 'high',
    };
  }
  // Address block registered to someone other than the operator (AS owner).
  if (
    i.rdapOrg &&
    !ispLike(i.rdapOrg) &&
    (!i.asOrg || (!sharesToken(i.rdapOrg, i.asOrg) && !sharesToken(i.rdapNetname, i.asOrg)))
  ) {
    return { networkType: 'corporate', orgGuess: i.rdapOrg, confidence: 'high' };
  }
  // Own AS that is not an ISP.
  if (i.asOrg && !ispLike(i.asOrg) && !RESIDENTIAL_PTR_RE.test(i.ptr ?? '')) {
    return { networkType: 'corporate', orgGuess: i.asOrg, confidence: 'medium' };
  }
  if (i.ptr && BUSINESS_PTR_RE.test(i.ptr))
    return { networkType: 'business_isp', orgGuess: withCity(operator), confidence: 'low' };
  if (ispLike(operator) || (i.ptr && RESIDENTIAL_PTR_RE.test(i.ptr)))
    return { networkType: 'residential_isp', orgGuess: withCity(operator), confidence: 'low' };
  return { networkType: 'unknown', orgGuess: operator, confidence: 'low' };
}
