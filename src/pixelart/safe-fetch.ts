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

export { sniffImage, type ImageKind } from "./sniff.js";

export const USER_AGENT = "minecraft-endeavours-bot/2 (+https://github.com/ZackHolmberg/minecraft-endeavours)";
export const FETCH_LIMITS = { maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3, connectMs: 4_000 } as const;

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
  /** Absolute epoch-ms deadline shared by several fetches (e.g. the Wikimedia search + image hops): the timeout never outlives it. */
  deadline?: number;
  /** Per-address connect timeout (until the response headers arrive), so one dead address doesn't eat the whole budget. */
  connectMs?: number;
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

/**
 * Resolve `host`, refuse if ANY address is blocked, return every validated address (IPv4 first: a v6-only route
 * failure then falls through quickly) in the order to try. `address` is the first of them.
 */
export async function pinAddress(host: string, resolve: Resolver): Promise<{ ok: true; address: string; addresses: string[] } | { ok: false; reason: string }> {
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
  const ordered = [...addrs.filter((a) => isIP(a) === 4), ...addrs.filter((a) => isIP(a) === 6)];
  const unique = [...new Set(ordered)];
  return { ok: true, address: unique[0]!, addresses: unique };
}

export async function safeGet(rawUrl: string, opts: SafeGetOptions = {}, deps: SafeGetDeps = {}): Promise<SafeGetResult> {
  const resolve = deps.resolve ?? defaultResolve;
  const transport = deps.transport ?? defaultTransport;
  const maxBytes = opts.maxBytes ?? FETCH_LIMITS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? FETCH_LIMITS.maxRedirects;
  const ctrl = new AbortController();
  const budget = Math.min(opts.timeoutMs ?? FETCH_LIMITS.timeoutMs, opts.deadline !== undefined ? opts.deadline - Date.now() : Infinity);
  if (budget <= 0) return { ok: false, reason: "timed out" };
  const timer = setTimeout(() => ctrl.abort(), budget);
  const connectMs = opts.connectMs ?? FETCH_LIMITS.connectMs;
  let current = rawUrl;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const v = validateUrl(current);
      if (!v.ok) return { ok: false, reason: hop === 0 ? v.reason : `redirect refused: ${v.reason}` };
      const host = v.url.hostname.toLowerCase().replace(/\.$/, "");
      if (opts.hostAllowed && !opts.hostAllowed(host)) return { ok: false, reason: `host ${host} is not allowed here` };
      const pin = await pinAddress(host, resolve);
      if (!pin.ok) return { ok: false, reason: hop === 0 ? pin.reason : `redirect refused: ${pin.reason}` };
      const headers = { "User-Agent": USER_AGENT, Accept: opts.accept ?? "image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity", Connection: "close" };
      // Try each validated address in turn (a dead AAAA or one unreachable A record must not fail the fetch).
      let res: HopResponse | null = null;
      let lastErr = "";
      for (const address of pin.addresses) {
        if (ctrl.signal.aborted) break;
        const attempt = new AbortController();
        const onAbort = (): void => attempt.abort();
        ctrl.signal.addEventListener("abort", onAbort, { once: true });
        const connectTimer = setTimeout(() => attempt.abort(), connectMs);
        try {
          // the overall abort stays linked to a successful attempt (it covers the body download too)
          res = await transport({ url: v.url, address, signal: attempt.signal, headers });
          break;
        } catch (err) {
          lastErr = attempt.signal.aborted && !ctrl.signal.aborted ? "connect timed out" : err instanceof Error ? err.message : String(err);
          ctrl.signal.removeEventListener("abort", onAbort);
        } finally {
          clearTimeout(connectTimer);
        }
      }
      if (!res) return { ok: false, reason: ctrl.signal.aborted ? "timed out" : `connection failed: ${lastErr}` };
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
