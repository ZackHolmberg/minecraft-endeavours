import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import type { AppConfig, BackendKind, BotConfig, LocalModelConfig, ModelHint } from "./types.js";

const VALID_MODEL_HINTS: readonly ModelHint[] = ["sonnet", "haiku", "opus"];
const VALID_BACKENDS: readonly BackendKind[] = ["claude", "local"];
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

const DEFAULT_MODEL_HINT: ModelHint = "sonnet";
const DEFAULT_BACKEND: BackendKind = "claude";
// Spike-validated local defaults (spikes/MLX_NOTES.md): mlx_lm.server on
// 127.0.0.1:8080 serving Qwen3-14B-4bit. Override per-bot in config/bots.yml.
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_LOCAL_MODEL = "mlx-community/Qwen3-14B-4bit";

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

  // model_hint is optional — defaults to sonnet. It's only meaningful for the
  // claude backend (and, later, the hybrid planner); a local bot can omit it.
  const modelHintRaw = obj.model_hint;
  let model_hint: ModelHint = DEFAULT_MODEL_HINT;
  if (modelHintRaw !== undefined) {
    if (typeof modelHintRaw !== "string" || !VALID_MODEL_HINTS.includes(modelHintRaw as ModelHint)) {
      throw new Error(
        `${path}: bots[${index}].model_hint must be one of ${VALID_MODEL_HINTS.join(", ")}`,
      );
    }
    model_hint = modelHintRaw as ModelHint;
  }

  // backend is optional — defaults to claude so existing configs are unchanged.
  const backendRaw = obj.backend;
  let backend: BackendKind = DEFAULT_BACKEND;
  if (backendRaw !== undefined) {
    if (typeof backendRaw !== "string" || !VALID_BACKENDS.includes(backendRaw as BackendKind)) {
      throw new Error(
        `${path}: bots[${index}].backend must be one of ${VALID_BACKENDS.join(", ")}`,
      );
    }
    backend = backendRaw as BackendKind;
  }

  const bot: BotConfig = { username, model_hint, backend };
  if (backend === "local") {
    bot.local = parseLocal(obj.local, index, path);
  }
  return bot;
}

function parseLocal(raw: unknown, index: number, path: string): LocalModelConfig {
  if (raw === undefined) {
    return { baseUrl: DEFAULT_LOCAL_BASE_URL, model: DEFAULT_LOCAL_MODEL };
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path}: bots[${index}].local must be an object`);
  }
  const obj = raw as Record<string, unknown>;

  const baseUrl = obj.baseUrl ?? obj.base_url;
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    throw new Error(`${path}: bots[${index}].local.baseUrl must be a string`);
  }
  const model = obj.model;
  if (model !== undefined && typeof model !== "string") {
    throw new Error(`${path}: bots[${index}].local.model must be a string`);
  }

  return {
    baseUrl: (baseUrl as string | undefined) ?? DEFAULT_LOCAL_BASE_URL,
    model: (model as string | undefined) ?? DEFAULT_LOCAL_MODEL,
  };
}
