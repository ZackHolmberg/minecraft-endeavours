/**
 * Image source for pixel art. Two halves, split so the guarded parent does ALL the network and the child only
 * decodes (live-polish review M5):
 *
 *   PARENT (this file, in the bot process): Wikimedia lookup by name, or the pasted https URL, fetched through the
 *   SSRF-guarded `safeGet` (validated addresses, pinned connection, manual redirects, byte cap, one shared deadline),
 *   magic-byte sniff. Only the raw bytes leave this half.
 *
 *   CHILD (decode-worker.ts): gets the BYTES on stdin and the resize job as argv, decodes with sharp, answers one JSON
 *   line on stdout. It runs under macOS `sandbox-exec` (no network, no file reads outside node + system libraries +
 *   node_modules + src/pixelart; see sandbox.ts) with a 256 MB JS heap, a stripped environment and a hard kill timer.
 *   Without `sandbox-exec` it falls back to the stripped-env child and logs one warning.
 *
 * The bot process never decodes untrusted bytes.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Raster } from "./convert.js";
import type { DecodeReply } from "./decode-worker.js";
import { decodeSandboxPaths, REPO_ROOT, SANDBOX_EXEC, sandboxAvailable, sandboxProfile } from "./sandbox.js";
import { safeGet, sniffImage, type SafeGetDeps } from "./safe-fetch.js";
import { findImage, WIKI_HOSTS } from "./wikimedia.js";

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

export type LoadResult = { ok: true; raster: Raster; probe: Raster; srcW: number; srcH: number; bytes: number; info: SourceInfo } | { ok: false; reason: string };

/** Hard kill for the decode child (spawn to reply). */
export const KILL_AFTER_MS = 15_000;
/** One deadline for ALL network work of a lookup (Commons search + Wikipedia search + the image itself). */
export const NET_BUDGET_MS = 12_000;
export const WORKER_HEAP_MB = 256;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

const WORKER = new URL("./decode-worker.ts", import.meta.url);

export interface LoadOptions {
  /** Test hook: a different child script (it is NOT readable inside the sandbox, so use with `sandbox: false`). */
  workerPath?: URL;
  killAfterMs?: number;
  /** Network budget override (tests). */
  netBudgetMs?: number;
  /** Test hook: injected DNS / transport for the parent's fetches. */
  deps?: SafeGetDeps;
  /** "auto" (default): sandbox-exec when available. false: never. true: required (fail instead of falling back). */
  sandbox?: boolean | "auto";
}

/** Child environment: nothing from the bot's (secret-bearing) environment, no HOME. */
export function workerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    NODE_ENV: process.env["NODE_ENV"] ?? "production",
    // the child writes nothing: tsx's on-disk transform cache is off, and node needs no openssl.cnf (not read inside the sandbox)
    TSX_DISABLE_CACHE: "1",
    OPENSSL_CONF: "/dev/null",
  };
}

let warnedNoSandbox = false;
function warnNoSandbox(): void {
  if (warnedNoSandbox) return;
  warnedNoSandbox = true;
  console.warn("[pixelart] sandbox-exec is unavailable: the image decoder runs WITHOUT a sandbox (stripped environment, 256 MB heap and kill timer only)");
}

/** Command line for the decode child: sandboxed when possible. Exported for tests. */
export function decodeCommand(script: string, job: { width?: unknown; scale?: unknown }, sandbox: boolean | "auto" = "auto"): { cmd: string; args: string[]; sandboxed: boolean } | { error: string } {
  const node = process.execPath;
  const base = ["--import", import.meta.resolve("tsx"), `--max-old-space-size=${WORKER_HEAP_MB}`, script, JSON.stringify({ width: job.width, scale: job.scale })];
  const wantSandbox = sandbox !== false;
  if (wantSandbox && sandboxAvailable()) {
    const paths = decodeSandboxPaths(REPO_ROOT, node);
    return { cmd: SANDBOX_EXEC, args: ["-p", sandboxProfile(paths), paths.nodeBin, ...base], sandboxed: true };
  }
  if (sandbox === true) return { error: "sandbox-exec is required but unavailable" };
  if (wantSandbox) warnNoSandbox();
  return { cmd: node, args: base, sandboxed: false };
}

/** Parent half: look the image up / download it with every SSRF guard. */
async function fetchBytes(job: WorkerJob, deps: SafeGetDeps, deadline: number): Promise<{ ok: true; bytes: Buffer; info: SourceInfo } | { ok: false; reason: string }> {
  let url: string;
  const info: SourceInfo = { from: "url", title: "", license: "", attribution: "", descriptionUrl: "", sourceHost: "" };
  const byName = "name" in job.source;
  if ("name" in job.source) {
    const f = await findImage(job.source.name, deps, deadline);
    if (!f.ok) return { ok: false, reason: f.reason };
    url = f.image.fetchUrl;
    Object.assign(info, { from: "wikimedia", title: f.image.title, license: f.image.license, attribution: f.image.attribution, descriptionUrl: f.image.descriptionUrl, restrictions: f.image.restrictions, free: f.image.free });
  } else {
    url = job.source.url;
  }
  const res = await safeGet(url, { deadline, ...(byName ? { hostAllowed: (h: string) => WIKI_HOSTS.has(h) } : {}) }, deps);
  if (!res.ok) return { ok: false, reason: res.reason };
  info.sourceHost = new URL(res.finalUrl).hostname;
  if (!sniffImage(res.bytes)) return { ok: false, reason: "that link isn't a PNG, JPEG, GIF or WebP image (a web page or SVG? paste the direct image link)" };
  return { ok: true, bytes: res.bytes, info };
}

/** Child half: decode `bytes` in the (sandboxed) child. */
function decodeInChild(bytes: Buffer, job: WorkerJob, opts: LoadOptions): Promise<{ ok: true; reply: Extract<DecodeReply, { ok: true }> } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let done = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (r: Awaited<ReturnType<typeof decodeInChild>>): void => {
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
    const timer = setTimeout(() => finish({ ok: false, reason: "decoding the image took too long" }), opts.killAfterMs ?? KILL_AFTER_MS);
    const cmd = decodeCommand(fileURLToPath(opts.workerPath ?? WORKER), job, opts.sandbox ?? "auto");
    if ("error" in cmd) return finish({ ok: false, reason: cmd.error });
    try {
      child = spawn(cmd.cmd, cmd.args, { cwd: fileURLToPath(new URL(".", import.meta.url)), env: workerEnv(), stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      return finish({ ok: false, reason: `couldn't start the image worker (${err instanceof Error ? err.message.slice(0, 80) : "error"})` });
    }
    const out: Buffer[] = [];
    let total = 0;
    child.stdout?.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_REPLY_BYTES) return finish({ ok: false, reason: "bad image data from the worker" });
      out.push(c);
    });
    child.once("error", (err) => finish({ ok: false, reason: `image worker failed (${err.message.slice(0, 80)})` }));
    child.once("close", (code, sig) => {
      let r: DecodeReply | null = null;
      try {
        r = JSON.parse(Buffer.concat(out).toString("utf8")) as DecodeReply;
      } catch {
        r = null;
      }
      if (!r || typeof r !== "object" || typeof (r as { ok?: unknown }).ok !== "boolean") return finish({ ok: false, reason: code === 0 ? "bad reply from the image worker" : `image worker died (${sig ?? `exit ${code}`})` });
      if (!r.ok) return finish({ ok: false, reason: String(r.reason).slice(0, 300) });
      finish({ ok: true, reply: r });
    });
    // stdin errors (EPIPE when the child died early) are reported through the exit path
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(bytes);
  });
}

export async function loadImage(job: WorkerJob, opts: LoadOptions = {}): Promise<LoadResult> {
  const deadline = Date.now() + (opts.netBudgetMs ?? NET_BUDGET_MS);
  let fetched: Awaited<ReturnType<typeof fetchBytes>>;
  try {
    fetched = await fetchBytes(job, opts.deps ?? {}, deadline);
  } catch (err) {
    return { ok: false, reason: `couldn't fetch the image (${err instanceof Error ? err.message.slice(0, 80) : "error"})` };
  }
  if (!fetched.ok) return fetched;
  const dec = await decodeInChild(fetched.bytes, job, opts);
  if (!dec.ok) return dec;
  const r = dec.reply;
  const data = Buffer.from(r.rgba ?? "", "base64");
  const pdata = Buffer.from(r.probe?.rgba ?? "", "base64");
  const okSize = (w: number, h: number, d: Buffer, max: number): boolean => Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w * h <= max && d.length === w * h * 4;
  if (!okSize(r.width, r.height, data, 128 * 96) || !r.probe || !okSize(r.probe.width, r.probe.height, pdata, 192 * 192 * 2)) return { ok: false, reason: "bad image data from the worker" };
  return { ok: true, raster: { width: r.width, height: r.height, data }, probe: { width: r.probe.width, height: r.probe.height, data: pdata }, srcW: r.srcW, srcH: r.srcH, bytes: fetched.bytes.length, info: fetched.info };
}
