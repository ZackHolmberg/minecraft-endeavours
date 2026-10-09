/**
 * World reset for the fixed-seed test world. `snapshotPristine()` copies the
 * (already pregenerated) world dirs to v2/world-pristine/; `restorePristine()`
 * puts them back. Both stop/start ONLY the test server (`mc-v2-test`) via
 * `docker compose` inside the worktree, whose .env pins the compose project.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { PRISTINE_DIR, REPO_ROOT, WORLD_DIRS, makeRcon, sleep, testServerEnv } from "./env.js";

const exec = promisify(execFile);

/** `docker compose` pinned to the test project regardless of the caller's shell env. */
async function compose(...args: string[]): Promise<string> {
  testServerEnv(); // asserts .env isolation
  const { stdout } = await exec("docker", ["compose", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, COMPOSE_FILE: "docker-compose.test.yml", COMPOSE_PROJECT_NAME: "mcv2test" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export async function stopServer(): Promise<void> {
  await compose("stop", "minecraft");
}

export async function startServer(): Promise<void> {
  await compose("start", "minecraft");
  await waitForServer();
}

/** Resolves when RCON answers `list` (RCON comes up right before "Done"). */
export async function waitForServer(timeoutMs = 240_000): Promise<void> {
  const env = testServerEnv();
  const t0 = Date.now();
  let lastErr = "";
  while (Date.now() - t0 < timeoutMs) {
    const rcon = makeRcon(env);
    try {
      await rcon.connect(3000);
      const out = await rcon.command("list", 5000);
      rcon.close();
      if (/players online/.test(out)) {
        await sleep(2000);
        return;
      }
    } catch (e) {
      lastErr = String(e);
      rcon.close();
    }
    await sleep(2000);
  }
  throw new Error(`test server not ready after ${timeoutMs}ms (${lastErr})`);
}

export async function snapshotPristine(): Promise<void> {
  await stopServer();
  try {
    rmSync(PRISTINE_DIR, { recursive: true, force: true });
    mkdirSync(PRISTINE_DIR, { recursive: true });
    for (const d of WORLD_DIRS) {
      const src = join(REPO_ROOT, "data", d);
      if (existsSync(src)) cpSync(src, join(PRISTINE_DIR, d), { recursive: true });
    }
    // Player-specific state must not leak into every run.
    for (const d of WORLD_DIRS)
      for (const sub of ["playerdata", "stats", "advancements"])
        rmSync(join(PRISTINE_DIR, d, sub), { recursive: true, force: true });
    rmSync(join(PRISTINE_DIR, "world/session.lock"), { force: true });
  } finally {
    await startServer();
  }
}

export function hasPristine(): boolean {
  return existsSync(join(PRISTINE_DIR, "world")) && readdirSync(PRISTINE_DIR).length > 0;
}

export async function restorePristine(): Promise<void> {
  if (!hasPristine()) throw new Error("no pristine snapshot; run `tsx src/eval/world.ts snapshot` (after scouting)");
  await stopServer();
  try {
    for (const d of WORLD_DIRS) {
      const dst = join(REPO_ROOT, "data", d);
      rmSync(dst, { recursive: true, force: true });
      const src = join(PRISTINE_DIR, d);
      if (existsSync(src)) cpSync(src, dst, { recursive: true });
    }
  } finally {
    await startServer();
  }
}

// CLI: tsx src/eval/world.ts snapshot|restore
if (process.argv[1]?.endsWith("world.ts")) {
  const cmd = process.argv[2];
  const run = cmd === "snapshot" ? snapshotPristine : cmd === "restore" ? restorePristine : null;
  if (!run) {
    console.error("usage: tsx src/eval/world.ts snapshot|restore");
    process.exit(2);
  }
  run().then(
    () => console.log(`${cmd} done`),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
