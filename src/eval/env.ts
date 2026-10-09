/** Locations + test-server connection settings for the eval (always the v2 worktree's test server). */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./bot-process.js";
import { Rcon, rconFromEnv } from "./rcon.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PRISTINE_DIR = join(REPO_ROOT, "v2/world-pristine");
export const SITES_PATH = join(REPO_ROOT, "src/eval/sites.json");
export const WORLD_DIRS = ["world", "world_nether", "world_the_end"] as const;

export interface TestServerEnv {
  host: string;
  port: number;
  version: string;
  rconEnv: Record<string, string>;
}

/** Reads the worktree .env and refuses anything that is not the isolated test server. */
export function testServerEnv(): TestServerEnv {
  const env = parseEnvFile(join(REPO_ROOT, ".env"));
  if (env.COMPOSE_PROJECT_NAME !== "mcv2test" || env.COMPOSE_FILE !== "docker-compose.test.yml")
    throw new Error("worktree .env is not configured for the isolated test server (see v2/TEST_SERVER.md)");
  if (!env.MC_PORT || env.MC_PORT === "25565") throw new Error("MC_PORT must be the test port");
  return {
    host: "127.0.0.1",
    port: Number(env.MC_PORT),
    version: env.MC_VERSION ?? "1.21.9",
    rconEnv: env,
  };
}

export function makeRcon(env: TestServerEnv): Rcon {
  return rconFromEnv(env.rconEnv);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
