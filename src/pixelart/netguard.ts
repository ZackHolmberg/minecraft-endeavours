/**
 * SSRF guard for pixel-art image fetches (pure; no I/O). Two layers:
 *   validateUrl  syntax: https only, port 443, no credentials, hostname not an IP literal in ANY spelling
 *                (the WHATWG parser already canonicalises decimal/octal/hex forms to dotted quads, and we
 *                refuse every IP literal after that), no single-label / local names
 *   ipBlockReason  the RESOLVED address: loopback, private, link-local (incl. cloud metadata), CGNAT,
 *                multicast, reserved, documentation, IPv4-mapped/compatible/NAT64/6to4 wrappers, and
 *                anything outside global-unicast 2000::/3 for IPv6
 * The connection is then pinned to the validated address (see safe-fetch.ts), so DNS rebinding between
 * the check and the connect cannot happen.
 */
import { isIP } from "node:net";

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const MAX_URL_LENGTH = 2048;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home", ".corp", ".intranet", ".home.arpa"];

export function validateUrl(raw: string): UrlCheck {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "empty URL" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "URL too long" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "only https:// links are allowed" };
  if (url.username || url.password) return { ok: false, reason: "links with a username or password are not allowed" };
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "only the default https port is allowed" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "no host in the URL" };
  if (isIP(host) !== 0 || host.includes(":")) return { ok: false, reason: "links to raw IP addresses are not allowed; use a host name" };
  if (!host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: "local / internal host names are not allowed" };
  if (!/^[a-z0-9._-]+$/.test(host)) return { ok: false, reason: "unusual characters in the host name" };
  return { ok: true, url };
}

// ── IPv4 ──────────────────────────────────────────────────────────────────

/** Strict dotted-decimal parse (4 parts, 0-255). Anything else is not an IPv4 literal. */
export function parseIPv4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  return p.every((n) => n >= 0 && n <= 255) ? p : null;
}

/** Why a (parsed) IPv4 address must not be contacted; null when it is public unicast. */
export function ipv4BlockReason([a, b, c]: readonly [number, number, number, number]): string | null {
  if (a === 0) return "0.0.0.0/8 (this network)";
  if (a === 10) return "private 10.0.0.0/8";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT 100.64.0.0/10";
  if (a === 127) return "loopback 127.0.0.0/8";
  if (a === 169 && b === 254) return "link-local 169.254.0.0/16 (cloud metadata)";
  if (a === 172 && b >= 16 && b <= 31) return "private 172.16.0.0/12";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignments 192.0.0.0/24";
  if (a === 192 && b === 0 && c === 2) return "documentation 192.0.2.0/24";
  if (a === 192 && b === 88 && c === 99) return "6to4 relay 192.88.99.0/24";
  if (a === 192 && b === 168) return "private 192.168.0.0/16";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking 198.18.0.0/15";
  if (a === 198 && b === 51 && c === 100) return "documentation 198.51.100.0/24";
  if (a === 203 && b === 0 && c === 113) return "documentation 203.0.113.0/24";
  if (a >= 224 && a <= 239) return "multicast 224.0.0.0/4";
  if (a >= 240) return "reserved 240.0.0.0/4";
  return null;
}

// ── IPv6 ──────────────────────────────────────────────────────────────────

/** Eight 16-bit groups of an IPv6 literal (handles `::`, an embedded dotted IPv4 tail and a %zone); null if malformed. */
export function parseIPv6(input: string): number[] | null {
  let s = input.replace(/^\[|\]$/g, "");
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (isIP(s) !== 6) return null;
  let tail: number[] = [];
  const dot = s.lastIndexOf(".");
  if (dot >= 0) {
    const colon = s.lastIndexOf(":", dot);
    const v4 = parseIPv4(s.slice(colon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, colon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...new Array<string>(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  if (tail.length === 2) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

/** Why an IPv6 address must not be contacted. Only global unicast 2000::/3 passes, minus the special sub-ranges. */
export function ipv6BlockReason(g: readonly number[]): string | null {
  const embedded = (hi: number, lo: number): [number, number, number, number] => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `IPv4-mapped (${ipv4BlockReason(embedded(g[6]!, g[7]!)) ?? "public IPv4 behind ::ffff:"})`;
  if (g.slice(0, 6).every((x) => x === 0)) return g[6] === 0 && g[7] === 0 ? "unspecified ::" : g[6] === 0 && g[7] === 1 ? "loopback ::1" : "IPv4-compatible ::/96";
  if (g[0] === 0x64 && g[1] === 0xff9b) return "NAT64 64:ff9b::/96";
  if ((g[0]! & 0xe000) !== 0x2000) return "not global unicast (2000::/3)"; // loopback ::1, fc00::/7, fe80::/10, ff00::/8, ...
  if (g[0] === 0x2001 && g[1]! < 0x200) return "special-purpose 2001::/23 (Teredo, benchmarking, ORCHID, ...)";
  if (g[0] === 0x2001 && g[1] === 0xdb8) return "documentation 2001:db8::/32";
  if (g[0] === 0x2002) return "6to4 2002::/16";
  if (g[0] === 0x3fff && g[1]! < 0x1000) return "documentation 3fff::/20";
  return null;
}

/** Null when `ip` (a textual address from DNS) is safe to connect to; otherwise the reason it is not. */
export function ipBlockReason(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) return ipv4BlockReason(v4);
  const v6 = parseIPv6(ip);
  if (v6) return ipv6BlockReason(v6);
  return "not a valid IP address";
}
