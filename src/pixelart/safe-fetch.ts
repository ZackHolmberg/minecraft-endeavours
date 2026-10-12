/**
 * Hardened HTTPS GET for pixel-art images (runs inside the fetch child process, see worker.ts).
 *
 *  - URL syntax and every RESOLVED address are checked (netguard.ts); a host with ANY blocked address is refused
 *  - the connection goes to the address that was validated (no second DNS lookup, so no DNS rebinding);
 *    TLS still verifies the certificate against the host name (SNI + servername)
 *  - redirects are followed by hand (max 3), each hop re-validated from scratch; no cookies, no credentials
 *  - 10 s wall clock for the whole fetch, byte cap enforced while streaming (Content-Length is not trusted)
 *  - identity encoding only (no decompression bombs); the caller sniffs the magic bytes (sniffImage)
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { ipBlockReason, validateUrl } from "./netguard.js";

export const USER_AGENT = "minecraft-endeavours-bot/2 (+https://github.com/ZackHolmberg/minecraft-endeavours)";
export const FETCH_LIMITS = { maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3 } as const;

export interface HopResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Body chunks; the consumer stops iterating (and the transport destroys the socket) when over the cap. */
  body: AsyncIterable<Uint8Array>;
  /** Free the socket (called on every exit path). */
  destroy(): void;
}

/** One GET to a VALIDATED address. Injectable so the policy is unit-testable without a network. */
export type Transport = (req: { url: URL; address: string; signal: AbortSignal; headers: Record<string, string> }) => Promise<HopResponse>;
export type Resolver = (host: string) => Promise<string[]>;

export interface SafeGetDeps {
  resolve?: Resolver;
  transport?: Transport;
}

export interface SafeGetOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  /** Extra check on the host of EVERY hop (e.g. the Wikimedia allowlist). */
  hostAllowed?: (host: string) => boolean;
}

export type SafeGetResult = { ok: true; bytes: Buffer; finalUrl: string; status: number; contentType: string } | { ok: false; reason: string };

export const defaultResolve: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export const defaultTransport: Transport = ({ url, address, signal, headers }) =>
  new Promise<HopResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: address, // connect to the validated IP ...
        servername: url.hostname, // ... but verify the certificate for the real name
        port: 443,
        method: "GET",
        path: url.pathname + url.search,
        headers: { ...headers, Host: url.host },
        agent: false,
        signal,
      },
      (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, destroy: () => res.destroy() });
      },
    );
    req.on("error", reject);
    req.end();
  });

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const header = (h: HopResponse["headers"], k: string): string => {
  const v = h[k];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
};

/** Resolve `host`, refuse if any address is blocked, return the one to connect to. */
export async function pinAddress(host: string, resolve: Resolver): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    return { ok: false, reason: `could not resolve ${host}` };
  }
  if (addrs.length === 0) return { ok: false, reason: `could not resolve ${host}` };
  for (const a of addrs) {
    if (isIP(a) === 0) return { ok: false, reason: `${host} resolved to something that is not an IP address` };
    const why = ipBlockReason(a);
    if (why) return { ok: false, reason: `${host} points at a non-public address (${why}); refusing` };
  }
  return { ok: true, address: addrs[0]! };
}

export async function safeGet(rawUrl: string, opts: SafeGetOptions = {}, deps: SafeGetDeps = {}): Promise<SafeGetResult> {
  const resolve = deps.resolve ?? defaultResolve;
  const transport = deps.transport ?? defaultTransport;
  const maxBytes = opts.maxBytes ?? FETCH_LIMITS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? FETCH_LIMITS.maxRedirects;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FETCH_LIMITS.timeoutMs);
  let current = rawUrl;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const v = validateUrl(current);
      if (!v.ok) return { ok: false, reason: hop === 0 ? v.reason : `redirect refused: ${v.reason}` };
      const host = v.url.hostname.toLowerCase().replace(/\.$/, "");
      if (opts.hostAllowed && !opts.hostAllowed(host)) return { ok: false, reason: `host ${host} is not allowed here` };
      const pin = await pinAddress(host, resolve);
      if (!pin.ok) return { ok: false, reason: hop === 0 ? pin.reason : `redirect refused: ${pin.reason}` };
      let res: HopResponse;
      try {
        res = await transport({
          url: v.url,
          address: pin.address,
          signal: ctrl.signal,
          headers: { "User-Agent": USER_AGENT, Accept: opts.accept ?? "image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity", Connection: "close" },
        });
      } catch (err) {
        return { ok: false, reason: ctrl.signal.aborted ? "timed out" : `connection failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      try {
        if (REDIRECTS.has(res.status)) {
          const loc = header(res.headers, "location");
          if (!loc) return { ok: false, reason: `HTTP ${res.status} without a Location` };
          if (hop === maxRedirects) return { ok: false, reason: `too many redirects (max ${maxRedirects})` };
          try {
            current = new URL(loc, v.url).toString();
          } catch {
            return { ok: false, reason: "bad redirect target" };
          }
          continue;
        }
        if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
        const declared = Number(header(res.headers, "content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: `file too large (${Math.round(declared / 1024)} KB, max ${Math.round(maxBytes / 1024)} KB)` };
        const chunks: Buffer[] = [];
        let total = 0;
        try {
          for await (const c of res.body) {
            total += c.byteLength;
            if (total > maxBytes) return { ok: false, reason: `file too large (over ${Math.round(maxBytes / 1024)} KB)` };
            chunks.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
          }
        } catch (err) {
          return { ok: false, reason: ctrl.signal.aborted ? "timed out" : `download failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        return { ok: true, bytes: Buffer.concat(chunks), finalUrl: v.url.toString(), status: res.status, contentType: header(res.headers, "content-type") };
      } finally {
        res.destroy();
      }
    }
    return { ok: false, reason: `too many redirects (max ${maxRedirects})` };
  } finally {
    clearTimeout(timer);
  }
}

export type ImageKind = "png" | "jpeg" | "gif" | "webp";

/** Magic-byte sniff. SVG (and everything else) is deliberately not recognised. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}
