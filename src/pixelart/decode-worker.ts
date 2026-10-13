/**
 * Decode child process (spawned by source.ts, normally under `sandbox-exec` with no network and no file reads
 * outside node, the system libraries, node_modules and src/pixelart). It receives the image BYTES on stdin and the
 * resize job as one JSON argv ({ width, scale }); it never fetches anything and has no secrets to read. It writes
 * ONE JSON reply to stdout and exits. A native decoder crash, a decompression bomb or an exploit therefore only ever
 * reaches this process.
 *
 * Imports are deliberately limited to decode.ts (sharp + pure conversion code).
 */
import { decodeToRaster } from "./decode.js";

export type DecodeReply =
  | { ok: true; width: number; height: number; rgba: string; probe: { width: number; height: number; rgba: string }; srcW: number; srcH: number }
  | { ok: false; reason: string };

export const MAX_STDIN_BYTES = 6 * 1024 * 1024;

async function readStdin(): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of process.stdin as AsyncIterable<Buffer>) {
    total += c.length;
    if (total > MAX_STDIN_BYTES) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function run(): Promise<DecodeReply> {
  let job: { width?: unknown; scale?: unknown } = {};
  try {
    job = JSON.parse(process.argv[2] ?? "{}") as typeof job;
  } catch {
    return { ok: false, reason: "bad decode job" };
  }
  const bytes = await readStdin();
  if (!bytes) return { ok: false, reason: "image too large" };
  const dec = await decodeToRaster(bytes, job.width, job.scale);
  if (!dec.ok) return { ok: false, reason: dec.reason };
  return {
    ok: true,
    width: dec.raster.width,
    height: dec.raster.height,
    rgba: Buffer.from(dec.raster.data).toString("base64"),
    probe: { width: dec.probe.width, height: dec.probe.height, rgba: Buffer.from(dec.probe.data).toString("base64") },
    srcW: dec.srcW,
    srcH: dec.srcH,
  };
}

let reply: DecodeReply;
try {
  reply = await run();
} catch (err) {
  reply = { ok: false, reason: `image worker error: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}` };
}
process.stdout.write(JSON.stringify(reply), () => process.exit(0));
