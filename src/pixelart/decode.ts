/**
 * Image decode + resize with sharp. Only ever imported by the fetch child process (worker.ts) and tests:
 * the bot process itself never decodes untrusted bytes.
 *
 * Guards: magic-byte sniff (PNG/JPEG/GIF/WebP only — no SVG, no TIFF/PDF/...), `limitInputPixels`,
 * `failOn: "error"`, first frame only, no cache, one libvips thread.
 */
import sharp, { type Sharp } from "sharp";
import { opaqueBounds, planSize, type Raster } from "./convert.js";
import { sniffImage } from "./safe-fetch.js";

export const MAX_INPUT_PIXELS = 25_000_000;

sharp.cache(false);
sharp.concurrency(1);

export interface Decoded {
  raster: Raster;
  /** The same (cropped) picture at up to 4x the grid size (max 192 px): the colour analysis reads this one. */
  probe: Raster;
  /** Size of the (cropped) source the grid was derived from. */
  srcW: number;
  srcH: number;
  /** Transparent margins were removed before resizing. */
  cropped: boolean;
}

export type DecodeResult = ({ ok: true } & Decoded) | { ok: false; reason: string };

const open = (buf: Buffer): Sharp => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false, sequentialRead: true });

/** Decode `buf`, crop transparent margins, resize to the planned grid (width x scale, caps) → RGBA. */
export async function decodeToRaster(buf: Buffer, width?: unknown, scale?: unknown): Promise<DecodeResult> {
  if (!sniffImage(buf)) return { ok: false, reason: "that file isn't a PNG, JPEG, GIF or WebP image (SVG and web pages are not accepted)" };
  try {
    const meta = await open(buf).metadata();
    const sw = meta.width ?? 0;
    const sh = meta.height ?? 0;
    if (!(sw > 0 && sh > 0)) return { ok: false, reason: "couldn't read the image size" };
    if (sw * sh > MAX_INPUT_PIXELS) return { ok: false, reason: `image too large (${sw}x${sh}, max ${MAX_INPUT_PIXELS / 1e6} megapixels)` };

    // crop transparent margins: find the opaque bounding box on a small copy
    let region = { left: 0, top: 0, width: sw, height: sh };
    let cropped = false;
    if (meta.hasAlpha) {
      const probe = await open(buf).resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const b = opaqueBounds({ width: probe.info.width, height: probe.info.height, data: probe.data });
      if (!b) return { ok: false, reason: "the image is fully transparent" };
      const fx = sw / probe.info.width;
      const fy = sh / probe.info.height;
      const left = Math.max(0, Math.floor((b.x0 - 0.5) * fx));
      const top = Math.max(0, Math.floor((b.y0 - 0.5) * fy));
      const right = Math.min(sw, Math.ceil((b.x1 + 1.5) * fx));
      const bottom = Math.min(sh, Math.ceil((b.y1 + 1.5) * fy));
      if (right - left < sw || bottom - top < sh) {
        region = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
        cropped = true;
      }
    }

    const plan = planSize(region.width, region.height, width, scale);
    if (!plan.ok) return { ok: false, reason: plan.reason };
    const kernel = plan.w >= region.width ? "nearest" : "lanczos3";
    let img = open(buf);
    if (cropped) img = img.extract(region);
    const out = await img.resize({ width: plan.w, height: plan.h, fit: "fill", kernel }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (out.info.width !== plan.w || out.info.height !== plan.h) return { ok: false, reason: "unexpected decoded size" };
    const pw = Math.min(region.width, 4 * plan.w, 192);
    const ph = Math.max(1, Math.round((pw * region.height) / region.width));
    let pimg = open(buf);
    if (cropped) pimg = pimg.extract(region);
    const pr = await pimg.resize({ width: pw, height: ph, fit: "fill", kernel: "lanczos3" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      raster: { width: out.info.width, height: out.info.height, data: out.data },
      probe: { width: pr.info.width, height: pr.info.height, data: pr.data },
      srcW: region.width,
      srcH: region.height,
      cropped,
    };
  } catch (err) {
    return { ok: false, reason: `couldn't decode the image (${err instanceof Error ? err.message.slice(0, 120) : "error"})` };
  }
}
