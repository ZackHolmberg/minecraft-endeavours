import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import type { AppConfig, BotConfig, ModelHint } from "./types.js";

const VALID_MODEL_HINTS: readonly ModelHint[] = ["sonnet", "haiku", "opus"];
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function loadConfig(botsYmlPath = "config/bots.yml"): AppConfig {
  const absPath = resolve(process.cwd(), botsYmlPath);
  const raw = yaml.load(readFileSync(absPath, "utf8"));

  if (!raw || typeof raw !== "object" || !("bots" in raw)) {
    throw new Error(`${botsYmlPath}: expected top-level "bots:" key`);
  }

  const botsRaw = (raw as { bots: unknown }).bots;
  if (!Array.isArray(botsRaw) || botsRaw.length === 0) {
    throw new Error(`${botsYmlPath}: "bots" must be a non-empty list`);
  }

  const bots: BotConfig[] = botsRaw.map((entry, i) => parseBot(entry, i, botsYmlPath));

  const usernames = new Set<string>();
  for (const bot of bots) {
    if (usernames.has(bot.username)) {
      throw new Error(`${botsYmlPath}: duplicate bot username "${bot.username}"`);
    }
    usernames.add(bot.username);
  }

  return {
    bots,
    mcHost: process.env.MC_HOST ?? "localhost",
    mcPort: Number(process.env.MC_PORT ?? 25565),
    mcVersion: resolveMcVersion(),
  };
}

function resolveMcVersion(): string {
  const raw = process.env.MC_VERSION;
  if (!raw || raw === "LATEST") {
    throw new Error(
      "MC_VERSION must be pinned to a specific Minecraft version supported by mineflayer's minecraft-data (e.g. 1.21.9). See CLAUDE.md.",
    );
  }
  return raw;
}

function parseBot(entry: unknown, index: number, path: string): BotConfig {
  if (!entry || typeof entry !== "object") {
    throw new Error(`${path}: bots[${index}] must be an object`);
  }
  const obj = entry as Record<string, unknown>;

  const username = obj.username;
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    throw new Error(
      `${path}: bots[${index}].username must be 3-16 chars of [A-Za-z0-9_]`,
    );
  }

  const modelHint = obj.model_hint;
  if (typeof modelHint !== "string" || !VALID_MODEL_HINTS.includes(modelHint as ModelHint)) {
    throw new Error(
      `${path}: bots[${index}].model_hint must be one of ${VALID_MODEL_HINTS.join(", ")}`,
    );
  }

  return { username, model_hint: modelHint as ModelHint };
}
