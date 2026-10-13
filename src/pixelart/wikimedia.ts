/**
 * Image lookup by name on Wikimedia Commons (fallback: English Wikipedia files). Pure parsing/ranking here;
 * the network part goes through safeGet with a host allowlist (runs in the fetch child).
 *
 *   search API → File: page → server-rendered thumbnail (`thumburl`, ~500 px, so SVG logos arrive as PNG
 *   and we never parse SVG ourselves) + licence / attribution from `extmetadata`.
 */
import { safeGet, type SafeGetDeps } from "./safe-fetch.js";

export const WIKI_HOSTS: ReadonlySet<string> = new Set(["commons.wikimedia.org", "en.wikipedia.org", "upload.wikimedia.org", "thumb.wikimedia.org"]);
export const THUMB_WIDTH = 500;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
const MAX_JSON_BYTES = 1024 * 1024;
/** One search call is capped at this; the whole lookup (searches + image) shares one deadline from the caller. */
export const SEARCH_TIMEOUT_MS = 5_000;

export interface ImageCandidate {
  title: string;
  mime: string;
  /** Raster URL to download (thumbnail or small original). */
  fetchUrl: string;
  descriptionUrl: string;
  license: string;
  licenseUrl?: string;
  /** Artist / credit, plain text. */
  attribution: string;
  free: boolean;
  restrictions: string;
  /** Position in the search ranking (lower = better). */
  index: number;
}

/** Plain text from the HTML snippets extmetadata carries. */
export function stripHtml(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const meta = (m: Record<string, { value?: unknown }> | undefined, k: string): string => stripHtml(m?.[k]?.value);

/** Free = on Wikimedia's metadata no NonFree flag and a licence that is not fair-use / all-rights-reserved. */
export function isFreeLicense(license: string, nonFree: string): boolean {
  if (/^(true|1|yes)$/i.test(nonFree)) return false;
  if (!license) return false;
  return !/fair use|non-?free|all rights reserved|unknown/i.test(license);
}

export function parseSearch(json: unknown): ImageCandidate[] {
  const pages = (json as { query?: { pages?: unknown } } | null)?.query?.pages;
  if (!Array.isArray(pages)) return [];
  const out: ImageCandidate[] = [];
  for (const p of pages as Array<Record<string, unknown>>) {
    const ii = (p["imageinfo"] as Array<Record<string, unknown>> | undefined)?.[0];
    if (!ii || typeof p["title"] !== "string") continue;
    const mime = typeof ii["mime"] === "string" ? ii["mime"] : "";
    if (!IMAGE_MIMES.has(mime)) continue;
    const fetchUrl = typeof ii["thumburl"] === "string" ? ii["thumburl"] : mime === "image/svg+xml" ? "" : typeof ii["url"] === "string" ? ii["url"] : "";
    if (!fetchUrl) continue;
    const md = ii["extmetadata"] as Record<string, { value?: unknown }> | undefined;
    const license = meta(md, "LicenseShortName") || meta(md, "UsageTerms");
    const artist = meta(md, "Artist");
    const credit = meta(md, "Credit");
    out.push({
      title: p["title"].replace(/^File:/, ""),
      mime,
      fetchUrl,
      descriptionUrl: typeof ii["descriptionurl"] === "string" ? ii["descriptionurl"] : "",
      license: license || "unknown licence",
      ...(meta(md, "LicenseUrl") ? { licenseUrl: meta(md, "LicenseUrl") } : {}),
      attribution: [artist, credit && credit !== artist ? credit : ""].filter(Boolean).join(" / ").slice(0, 200),
      free: isFreeLicense(license, meta(md, "NonFree")),
      restrictions: meta(md, "Restrictions"),
      index: typeof p["index"] === "number" ? p["index"] : 1000,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Best result in search order; free licences first when `freeOnly`, otherwise a non-free file is only the last resort. */
export function pickCandidate(cands: readonly ImageCandidate[], freeOnly: boolean): ImageCandidate | null {
  const free = cands.find((c) => c.free);
  if (free) return free;
  return freeOnly ? null : (cands[0] ?? null);
}

export const cleanQuery = (q: string): string =>
  q
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

export function searchUrl(apiHost: string, query: string): string {
  const p = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrnamespace: "6",
    gsrlimit: "10",
    gsrsearch: query,
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
    iiurlwidth: String(THUMB_WIDTH),
    iiextmetadatafilter: "LicenseShortName|UsageTerms|LicenseUrl|Artist|Credit|NonFree|Restrictions",
  });
  return `https://${apiHost}/w/api.php?${p.toString()}`;
}

const allowed = (h: string): boolean => WIKI_HOSTS.has(h);

async function search(apiHost: string, query: string, deps: SafeGetDeps, deadline?: number): Promise<ImageCandidate[] | string> {
  const res = await safeGet(searchUrl(apiHost, query), { maxBytes: MAX_JSON_BYTES, accept: "application/json", hostAllowed: allowed, timeoutMs: SEARCH_TIMEOUT_MS, ...(deadline !== undefined ? { deadline } : {}) }, deps);
  if (!res.ok) return `${apiHost} search failed: ${res.reason}`;
  try {
    return parseSearch(JSON.parse(res.bytes.toString("utf8")));
  } catch {
    return `${apiHost} returned something that isn't JSON`;
  }
}

/** Find the best image for `name`. Commons first (free files only), then English Wikipedia (non-free logos allowed, labelled). */
export async function findImage(name: string, deps: SafeGetDeps = {}, deadline?: number): Promise<{ ok: true; image: ImageCandidate } | { ok: false; reason: string }> {
  const q = cleanQuery(name);
  if (q.length < 2) return { ok: false, reason: "the image name is empty" };
  const errors: string[] = [];
  for (const [host, freeOnly] of [["commons.wikimedia.org", true], ["en.wikipedia.org", false]] as const) {
    const r = await search(host, q, deps, deadline);
    if (typeof r === "string") {
      errors.push(r);
      continue;
    }
    const pick = pickCandidate(r, freeOnly);
    if (pick) return { ok: true, image: pick };
  }
  return { ok: false, reason: errors.length > 0 ? errors.join("; ") : `no image found for "${q}" on Wikimedia Commons or Wikipedia` };
}
