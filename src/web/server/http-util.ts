/** Response helpers, security headers, bounded body parsing. */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiError } from "../shared/api.js";
import type { PanelConfig } from "./config.js";

export const BODY_LIMIT = 16 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function securityHeaders(cfg: PanelConfig, res: ServerResponse): void {
  const wss = [...cfg.allowedOrigins].map((o) => o.replace(/^https:/, "wss:")).join(" ");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ${wss}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  if (!cfg.dev) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", buf.length);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(buf);
}

export function sendError(res: ServerResponse, status: number, error: string, message: string, headers: Record<string, string> = {}): void {
  const body: ApiError = { error, message };
  sendJson(res, status, body, headers);
}

export function sendNoContent(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.statusCode = 204;
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end();
}

/** Reads a JSON object body (≤ BODY_LIMIT). Empty body → {}. */
export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > BODY_LIMIT) {
      reject(new HttpError(413, "too_large", "Request body too large"));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        failed = true;
        reject(new HttpError(413, "too_large", "Request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => {
      if (!failed) {
        failed = true;
        reject(new HttpError(400, "bad_request", "Body read failed"));
      }
    });
    req.on("end", () => {
      if (failed) return;
      if (size === 0) return resolve({});
      const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (ct !== "application/json") return reject(new HttpError(415, "unsupported_media_type", "Content-Type must be application/json"));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) return reject(new HttpError(400, "bad_request", "Body must be a JSON object"));
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "bad_request", "Malformed JSON"));
      }
    });
  });
}

/** Socket peer address only — no X-Forwarded-For trust (no proxy in front). */
export function clientIp(req: IncomingMessage): string {
  const a = req.socket.remoteAddress ?? "unknown";
  return a.startsWith("::ffff:") ? a.slice(7) : a;
}

/**
 * Rate-limit / lockout key for an address. IPv4 is per address; IPv6 is per
 * /64, because one host or ISP customer routinely controls a whole /64 and
 * could otherwise rotate source addresses to get fresh lockout buckets.
 */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("%")[0]!.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function hostAllowed(cfg: PanelConfig, host: string | undefined): boolean {
  return typeof host === "string" && cfg.allowedHosts.has(host.toLowerCase());
}

export function originAllowed(cfg: PanelConfig, origin: string | undefined): boolean {
  return typeof origin === "string" && cfg.allowedOrigins.has(origin);
}
