import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { derivedBaseName, registerBotAliases } from "./orchestrator/chat-router.js";
import type {
  AppConfig,
  BackendKind,
  BotConfig,
  HybridConfig,
  LocalModelConfig,
  ModelHint,
  SessionMode,
} from "./types.js";

const VALID_MODEL_HINTS: readonly ModelHint[] = ["sonnet", "haiku", "opus"];
const VALID_BACKENDS: readonly BackendKind[] = ["claude", "local", "hybrid"];
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const ALIAS_RE = /^[A-Za-z0-9_]{2,16}$/;

const DEFAULT_MODEL_HINT: ModelHint = "haiku";
const DEFAULT_BACKEND: BackendKind = "claude";
const VALID_SESSION_MODES: readonly SessionMode[] = ["per_task", "persistent"];
// Fresh Claude session per player request, context injected from disk. See
// ClaudeBackend header and src/memory/conversation-log.ts.
const DEFAULT_SESSION_MODE: SessionMode = "per_task";
// Local defaults: mlx_lm.server on 127.0.0.1:8080. Qwen3-8B-4bit (~4.3GB) is the
// default over 14B (~8GB) — faster prompt-processing and enough GPU headroom on
// the 24GB box to avoid the recurring Metal-OOM aborts we hit under load with
// 14B. Override per-bot in config/bots.yml.
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_LOCAL_MODEL = "mlx-community/Qwen3-8B-4bit";

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

  // Aliases must be unambiguous: no alias may equal another bot's username or alias.
  const owner = new Map<string, string>();
  for (const bot of bots) owner.set(bot.username.toLowerCase(), bot.username);
  for (const bot of bots) {
    for (const alias of bot.aliases ?? []) {
      const prior = owner.get(alias.toLowerCase());
      if (prior !== undefined && prior !== bot.username) {
        throw new Error(`${botsYmlPath}: alias "${alias}" of ${bot.username} collides with ${prior}`);
      }
      owner.set(alias.toLowerCase(), bot.username);
    }
  }
  // Derived suffix-stripped names (Steve_AI -> "steve") must not collide with
  // another bot's username/alias/derived name either: both would answer.
  for (const bot of bots) {
    const base = derivedBaseName(bot.username);
    if (!base) continue;
    const prior = owner.get(base.toLowerCase());
    if (prior !== undefined && prior !== bot.username) {
      throw new Error(`${botsYmlPath}: ${bot.username} also answers to "${base}" (suffix-stripped), which collides with ${prior}`);
    }
    owner.set(base.toLowerCase(), bot.username);
  }
  // The chat router matches names against usernames + these aliases.
  for (const bot of bots) registerBotAliases(bot.username, bot.aliases ?? []);

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

  // session_mode is optional — only meaningful for the claude backend.
  const sessionModeRaw = obj.session_mode;
  let session_mode: SessionMode = DEFAULT_SESSION_MODE;
  if (sessionModeRaw !== undefined) {
    if (
      typeof sessionModeRaw !== "string" ||
      !VALID_SESSION_MODES.includes(sessionModeRaw as SessionMode)
    ) {
      throw new Error(
        `${path}: bots[${index}].session_mode must be one of ${VALID_SESSION_MODES.join(", ")}`,
      );
    }
    session_mode = sessionModeRaw as SessionMode;
  }

  // aliases is optional: extra names players can use ("steve" for Steve_v2).
  let aliases: string[] | undefined;
  if (obj.aliases !== undefined) {
    if (!Array.isArray(obj.aliases)) {
      throw new Error(`${path}: bots[${index}].aliases must be a list of names`);
    }
    const seen = new Set<string>();
    aliases = [];
    for (const a of obj.aliases) {
      if (typeof a !== "string" || !ALIAS_RE.test(a)) {
        throw new Error(`${path}: bots[${index}].aliases entries must be 2-16 chars of [A-Za-z0-9_], got ${JSON.stringify(a)}`);
      }
      if (seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      aliases.push(a);
    }
  }

  const bot: BotConfig = { username, model_hint, backend, session_mode };
  if (aliases && aliases.length > 0) bot.aliases = aliases;
  if (backend === "local") {
    bot.local = parseLocal(obj.local, index, path);
  }
  if (backend === "hybrid") {
    bot.hybrid = parseHybrid(obj, index, path);
  }
  return bot;
}

function parseHybrid(obj: Record<string, unknown>, index: number, path: string): HybridConfig {
  // planner.model_hint — the Claude tier that plans. Defaults to sonnet
  // (cheaper on the Pro 5h window; bump to opus per-bot for heavier planning).
  let plannerModelHint: ModelHint = DEFAULT_MODEL_HINT;
  const planner = obj.planner;
  if (planner !== undefined) {
    if (typeof planner !== "object" || planner === null) {
      throw new Error(`${path}: bots[${index}].planner must be an object`);
    }
    const hint = (planner as Record<string, unknown>).model_hint;
    if (hint !== undefined) {
      if (typeof hint !== "string" || !VALID_MODEL_HINTS.includes(hint as ModelHint)) {
        throw new Error(
          `${path}: bots[${index}].planner.model_hint must be one of ${VALID_MODEL_HINTS.join(", ")}`,
        );
      }
      plannerModelHint = hint as ModelHint;
    }
  }

  return { plannerModelHint, executor: parseLocal(obj.executor, index, path) };
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
