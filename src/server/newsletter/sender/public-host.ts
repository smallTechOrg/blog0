// Stage A `trackingPublic` (spec/architecture.md §13.3): Listmonk counts an open when a reader's mail
// client loads `<root_url>/campaign/…/px.png` and a click when it follows a `<root_url>/link/…`
// redirect — impossible when the root URL names a host only this machine or network can reach. Pure.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function privateIpv4(host: string): boolean | null {
  const m = IPV4.exec(host);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((p) => Number(p) > 255)) return true; // not a real address
  return (
    a === 0 || // 0.0.0.0/8 ("this network")
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function privateIpv6(host: string): boolean | null {
  if (!host.includes(':')) return null;
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;
  const first = h.split(':')[0] ?? '';
  const word = first === '' ? 0 : Number.parseInt(first, 16);
  if (Number.isNaN(word)) return true;
  if ((word & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((word & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return privateIpv4(mapped[1] as string) ?? true;
  return false;
}

/**
 * False for hosts a reader's mail client cannot reach: `localhost` / `*.localhost`, a single-label
 * name (`listmonk`), `*.local` / `*.internal`, IPv4 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
 * 0.0.0.0, IPv6 ::1, fc00::/7, fe80::/10. Everything else → true.
 */
export function isPublicHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  if (host === '') return false;
  const v6 = privateIpv6(host);
  if (v6 !== null) return !v6;
  const v4 = privateIpv4(host);
  if (v4 !== null) return !v4;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (!host.includes('.')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  return true;
}

/** The host rule applied to an absolute http(s) URL; anything unparseable → false. */
export function isPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return isPublicHost(parsed.hostname);
  } catch {
    return false;
  }
}
