/**
 * The one line of attribution for a Wikimedia image, posted to chat BY CODE from a fixed template (live-polish
 * review M2). Everything from the web (file title, artist, licence text) is untrusted: none of it is ever handed to
 * the model as text, so it can't carry instructions. The title is reduced to a harmless character set and length, the
 * licence is mapped onto a short allowlist ("see Commons" when it isn't recognised), and the artist is not shown at all
 * (the file page, named in the line, carries it).
 */
import type { SourceInfo } from "./source.js";

export const CREDIT_TITLE_MAX = 60;

/** Short, safe title: extension dropped, only `[A-Za-z0-9 .,'()-]`, whitespace collapsed, ~60 chars. */
export function safeTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/_/g, " ")
    .replace(/\.(svg|png|jpe?g|gif|webp|tiff?)$/i, "")
    .replace(/[^A-Za-z0-9 .,'()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CREDIT_TITLE_MAX)
    .trim();
}

/** Map Wikimedia's LicenseShortName onto a fixed set of display names; anything else is "see Commons". */
export function licenseShortName(raw: unknown): string {
  if (typeof raw !== "string") return "see Commons";
  const t = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (/^cc0(?:[ -]1\.0)?(?: universal)?$/i.test(t)) return "CC0";
  if (/^(?:public domain|pd(?:-[a-z0-9-]{1,24})?|no restrictions)$/i.test(t)) return "Public domain";
  if (/^gfdl(?:[ -]1\.[23])?$/i.test(t)) return "GFDL";
  if (/^fal$|^free art license$/i.test(t)) return "Free Art License";
  const m = /^cc[ -]by(-sa)?(?:[ -](\d\.\d))?(?:[ -][a-z]{2,7})?$/i.exec(t);
  if (m) return `CC BY${m[1] ? "-SA" : ""}${m[2] ? ` ${m[2]}` : ""}`;
  return "see Commons";
}

/** `Image: <title> — <licence> (Wikimedia Commons)`, or null when the image didn't come from Wikimedia. */
export function creditChatLine(info: SourceInfo): string | null {
  if (info.from !== "wikimedia") return null;
  let wiki = "Wikimedia Commons";
  try {
    if (new URL(info.descriptionUrl).hostname === "en.wikipedia.org") wiki = "English Wikipedia";
  } catch {
    // no usable link: keep Commons
  }
  const licence = info.free === false ? "see Commons" : licenseShortName(info.license);
  return `Image: ${safeTitle(info.title) || "untitled"} — ${licence} (${wiki})`;
}
