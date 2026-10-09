/**
 * Static UI from one fixed directory (src/web/ui/dist). Path resolution is
 * traversal-safe (decoded, normalized, realpath-checked against the root),
 * dotfiles and unknown extensions are refused, there is no directory
 * listing, and extension-less routes fall back to index.html for the SPA.
 * If the UI hasn't been built yet, a built-in placeholder page is served.
 */
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Server Panel</title></head>
<body><main><h1>Server panel</h1><p>The panel API is running, but the web UI has not been built yet
(expected at <code>src/web/ui/dist/</code>).</p></main></body></html>
`;

export type StaticResult = "served" | "not_found" | "bad_request";

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, pathname: string, headOnly: boolean): StaticResult {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return "bad_request";
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return "bad_request";
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((s) => s === ".." || s.startsWith("."))) return "not_found";

  if (!existsSync(resolve(root, "index.html"))) {
    if (segments.length === 0 || extname(decoded) === "") {
      send(res, 200, MIME[".html"]!, Buffer.from(PLACEHOLDER), headOnly, false);
      return "served";
    }
    return "not_found";
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return "not_found";
  }
  const isSpaRoute = segments.length === 0 || extname(decoded) === "";
  const candidate = isSpaRoute ? resolve(realRoot, "index.html") : resolve(realRoot, ...segments);
  if (!candidate.startsWith(realRoot + sep)) return "not_found";
  const ext = extname(candidate).toLowerCase();
  const type = MIME[ext];
  if (!type) return "not_found";

  let real: string;
  try {
    real = realpathSync(candidate);
    if (!real.startsWith(realRoot + sep)) return "not_found"; // symlink escape
    const st = statSync(real);
    if (!st.isFile()) return "not_found";
    // Vite emits content-hashed names under assets/; everything else revalidates.
    const immutable = segments[0] === "assets";
    res.statusCode = 200;
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Length", st.size);
    res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    if (headOnly) {
      res.end();
      return "served";
    }
    const stream = createReadStream(real);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    void req;
    return "served";
  } catch {
    return "not_found";
  }
}

function send(res: ServerResponse, status: number, type: string, body: Buffer, headOnly: boolean, cache: boolean): void {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Length", body.length);
  res.setHeader("Cache-Control", cache ? "public, max-age=3600" : "no-cache");
  res.end(headOnly ? undefined : body);
}
