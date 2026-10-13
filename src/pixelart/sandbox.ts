/**
 * macOS `sandbox-exec` profile for the image-decode child (live-polish review M5).
 *
 * The decode child (decode-worker.ts) handles untrusted bytes with a native decoder (sharp / libvips). Whatever it
 * does, it must not be able to reach the network or the owner's secrets, so under `sandbox-exec` it gets:
 *   - no network at all (`deny default`, `deny network*`);
 *   - no writes anywhere;
 *   - `file-read*` ONLY for: the node install (the binary and the libraries it links), the system libraries
 *     (Apple's `system.sb` baseline), the repo's `node_modules` (real path: it may be a symlink), `src/pixelart`
 *     (the child's own sources + palette.json) and `package.json` (module type). No `.env`, no `data/`, no
 *     `~/.claude`, no home directory.
 * `file-read-metadata` (stat) is allowed on the ancestors of those paths only, because node `realpath`s its modules.
 *
 * Feature-detected: when `sandbox-exec` is missing (Linux, a locked-down macOS) the caller falls back to the stripped
 * environment child and logs ONE warning.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

let usable: boolean | null = null;

/** True when `sandbox-exec` exists AND can actually apply a profile here (it can fail inside another sandbox). */
export function sandboxAvailable(): boolean {
  if (usable !== null) return usable;
  usable = false;
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC)) {
    try {
      const r = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 5000, stdio: "ignore" });
      usable = r.status === 0;
    } catch {
      usable = false;
    }
  }
  return usable;
}

/** Test hook: force the detection result (null = detect again). */
export function setSandboxAvailableForTest(v: boolean | null): void {
  usable = v;
}

const q = (p: string): string => {
  if (/[\n\r\0]/.test(p)) throw new Error("unsafe path in sandbox profile");
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** `/a/b/c` -> `/`, `/a`, `/a/b`, `/a/b/c`. */
export function ancestorsOf(p: string): string[] {
  const out: string[] = [];
  let cur = p;
  for (;;) {
    out.unshift(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

export interface SandboxPaths {
  nodeBin: string;
  /** Directories readable in full (real paths). */
  readSubpaths: string[];
  /** Single files readable (real paths). */
  readLiterals: string[];
  /** Un-resolved spellings (e.g. a `node_modules` symlink) that only need to be stat-able on the way to a real path. */
  statPaths?: string[];
  /** Directories whose binaries may be executed (esbuild, used by the tsx loader). */
  execSubpaths?: string[];
}

/** Where the node install keeps the libraries the binary links (Homebrew: Cellar/opt/lib next to bin; nvm/official: the install root). */
function nodeInstallReads(nodeBinReal: string): string[] {
  const out = [dirname(nodeBinReal), dirname(dirname(nodeBinReal))];
  const i = nodeBinReal.indexOf(`${sep}Cellar${sep}`);
  if (i > 0) {
    const prefix = nodeBinReal.slice(0, i); // e.g. /opt/homebrew
    out.push(join(prefix, "Cellar"), join(prefix, "opt"), join(prefix, "lib"));
  }
  return out;
}

/** Paths for the real repo layout (`repoRoot` = the checkout that holds `src/` and `node_modules/`). */
export function decodeSandboxPaths(repoRoot: string, nodeBin: string = process.execPath): SandboxPaths {
  const nodeReal = real(nodeBin);
  return {
    nodeBin: nodeReal,
    readSubpaths: [...nodeInstallReads(nodeReal), real(join(repoRoot, "node_modules")), real(join(repoRoot, "src", "pixelart"))],
    readLiterals: [real(join(repoRoot, "package.json"))],
    execSubpaths: [real(join(repoRoot, "node_modules", "@esbuild")), real(join(repoRoot, "node_modules", "esbuild"))],
    statPaths: [join(repoRoot, "node_modules"), join(repoRoot, "package.json"), join(repoRoot, "src", "pixelart")],
  };
}

/** The SBPL text. Exported for tests. */
export function sandboxProfile(paths: SandboxPaths, extraReadLiterals: readonly string[] = []): string {
  const subpaths = [...new Set(paths.readSubpaths)];
  const literals = [...new Set([...paths.readLiterals, ...extraReadLiterals])];
  const ancestors = new Set<string>();
  for (const p of [paths.nodeBin, ...subpaths, ...literals, ...(paths.statPaths ?? [])]) for (const a of ancestorsOf(p)) ancestors.add(a);
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")', // dyld, mach services node needs, system libraries (read-only)
    "(deny network*)",
    "(deny file-write*)",
    // exec: node itself and tsx's esbuild service binary (transpiles the .ts sources); nothing else
    `(allow process-exec (literal ${q(paths.nodeBin)})${(paths.execSubpaths ?? []).map((p) => ` (subpath ${q(p)})`).join("")})`,
    "(allow process-fork)",
    "(allow sysctl-read)",
    // everything below is the ONLY file content the child can read
    `(allow file-read* ${[...subpaths.map((p) => `(subpath ${q(p)})`), ...literals.map((p) => `(literal ${q(p)})`), '(literal "/dev/null")'].join(" ")})`,
    `(allow file-read-metadata ${[...ancestors].map((p) => `(literal ${q(p)})`).join(" ")})`,
    "",
  ].join("\n");
}

/** Repo root from this file (src/pixelart/sandbox.ts -> ../..). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
