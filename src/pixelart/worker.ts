/**
 * Fetch + decode child process (forked by source.ts with a memory limit, a minimal environment and a hard
 * kill timer). Receives ONE job over IPC, answers with the resized RGBA or a refusal, and exits. A native
 * decoder crash, a decompression bomb or a hung socket therefore only ever costs this process.
 */
import { decodeToRaster } from "./decode.js";
import { safeGet, sniffImage } from "./safe-fetch.js";
import { findImage, WIKI_HOSTS } from "./wikimedia.js";
import type { WorkerJob, WorkerReply } from "./source.js";

async function run(job: WorkerJob): Promise<WorkerReply> {
  let url: string;
  const info: Extract<WorkerReply, { ok: true }>["info"] = { from: "url", title: "", license: "", attribution: "", descriptionUrl: "", sourceHost: "" };
  if ("name" in job.source) {
    const f = await findImage(job.source.name);
    if (!f.ok) return { ok: false, reason: f.reason };
    url = f.image.fetchUrl;
    Object.assign(info, { from: "wikimedia", title: f.image.title, license: f.image.license, attribution: f.image.attribution, descriptionUrl: f.image.descriptionUrl, restrictions: f.image.restrictions, free: f.image.free });
  } else {
    url = job.source.url;
  }
  const res = await safeGet(url, { ...("name" in job.source ? { hostAllowed: (h: string) => WIKI_HOSTS.has(h) } : {}) });
  if (!res.ok) return { ok: false, reason: res.reason };
  info.sourceHost = new URL(res.finalUrl).hostname;
  if (!sniffImage(res.bytes)) return { ok: false, reason: "that link isn't a PNG, JPEG, GIF or WebP image (a web page or SVG? paste the direct image link)" };
  const dec = await decodeToRaster(res.bytes, job.width, job.scale);
  if (!dec.ok) return { ok: false, reason: dec.reason };
  return { ok: true, width: dec.raster.width, height: dec.raster.height, rgba: Buffer.from(dec.raster.data).toString("base64"), probe: { width: dec.probe.width, height: dec.probe.height, rgba: Buffer.from(dec.probe.data).toString("base64") }, srcW: dec.srcW, srcH: dec.srcH, bytes: res.bytes.length, info };
}

process.once("message", (msg) => {
  void (async () => {
    let reply: WorkerReply;
    try {
      reply = await run(msg as WorkerJob);
    } catch (err) {
      reply = { ok: false, reason: `image worker error: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}` };
    }
    process.send?.(reply, () => process.exit(0));
  })();
});
