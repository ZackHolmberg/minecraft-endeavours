/**
 * Image source for pixel art (parent side): runs the fetch + decode child process and returns the resized
 * raster. Sources: a Wikimedia name, or a pasted https URL (arbitrary host, fully SSRF-guarded in the child).
 *
 * The child gets: a 256 MB JS heap cap, a minimal environment (no tokens), no stdin, and is killed after
 * `KILL_AFTER_MS` whatever it is doing. The bot process never touches the untrusted bytes.
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Raster } from "./convert.js";

export type ImageSourceSpec = { name: string } | { url: string };

export interface WorkerJob {
  source: ImageSourceSpec;
  width?: unknown;
  scale?: unknown;
}

export interface SourceInfo {
  from: "wikimedia" | "url";
  title: string;
  license: string;
  attribution: string;
  descriptionUrl: string;
  sourceHost: string;
  restrictions?: string;
  free?: boolean;
}

export type WorkerReply =
  | { ok: true; width: number; height: number; rgba: string; probe: { width: number; height: number; rgba: string }; srcW: number; srcH: number; bytes: number; info: SourceInfo }
  | { ok: false; reason: string };

export type LoadResult = { ok: true; raster: Raster; probe: Raster; srcW: number; srcH: number; bytes: number; info: SourceInfo } | { ok: false; reason: string };

export const KILL_AFTER_MS = 25_000;
export const WORKER_HEAP_MB = 256;

const WORKER = new URL("./worker.ts", import.meta.url);

export interface LoadOptions {
  /** Test hook: a different child script. */
  workerPath?: URL;
  killAfterMs?: number;
}

/** Child environment: nothing from the bot's (secret-bearing) environment. */
export function workerEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", NODE_ENV: process.env["NODE_ENV"] ?? "production" };
}

export function loadImage(job: WorkerJob, opts: LoadOptions = {}): Promise<LoadResult> {
  return new Promise<LoadResult>((resolve) => {
    let done = false;
    let child: ReturnType<typeof fork>;
    const finish = (r: LoadResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "fetching the image took too long" }), opts.killAfterMs ?? KILL_AFTER_MS);
    try {
      child = fork(fileURLToPath(opts.workerPath ?? WORKER), [], {
        execArgv: ["--import", import.meta.resolve("tsx"), `--max-old-space-size=${WORKER_HEAP_MB}`],
        env: workerEnv(),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "json",
      });
    } catch (err) {
      finish({ ok: false, reason: `couldn't start the image worker (${err instanceof Error ? err.message.slice(0, 80) : "error"})` });
      return;
    }
    child.once("message", (m) => {
      const r = m as WorkerReply;
      if (!r || typeof r !== "object" || typeof (r as { ok?: unknown }).ok !== "boolean") return finish({ ok: false, reason: "bad reply from the image worker" });
      if (!r.ok) return finish({ ok: false, reason: String(r.reason).slice(0, 300) });
      const data = Buffer.from(r.rgba, "base64");
      const pdata = Buffer.from(r.probe?.rgba ?? "", "base64");
      const okSize = (w: number, h: number, d: Buffer, max: number): boolean => Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w * h <= max && d.length === w * h * 4;
      if (!okSize(r.width, r.height, data, 128 * 96) || !okSize(r.probe.width, r.probe.height, pdata, 192 * 192 * 2)) return finish({ ok: false, reason: "bad image data from the worker" });
      finish({ ok: true, raster: { width: r.width, height: r.height, data }, probe: { width: r.probe.width, height: r.probe.height, data: pdata }, srcW: r.srcW, srcH: r.srcH, bytes: r.bytes, info: r.info });
    });
    child.once("error", (err) => finish({ ok: false, reason: `image worker failed (${err.message.slice(0, 80)})` }));
    // a reply is sent before the child exits, but give a late "message" a moment to arrive before calling it a crash
    child.once("exit", (code, sig) => void setTimeout(() => finish({ ok: false, reason: `image worker died (${sig ?? `exit ${code}`})` }), 300));
    child.send(job satisfies WorkerJob, (err) => {
      if (err) finish({ ok: false, reason: "couldn't talk to the image worker" });
    });
  });
}
