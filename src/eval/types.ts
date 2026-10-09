/**
 * v2 benchmark contract. See v2/EVAL.md.
 *
 * The eval is BLACK-BOX: it drives a bot checkout (v1 or v2) only through
 *   - Minecraft chat, via a mineflayer "Tester" player,
 *   - RCON on the test server (setup + state checks),
 *   - the bot's telemetry JSONL (task_start / task_end / skill / pillar / ...,
 *     schema in src/observability/telemetry-types.ts — v2 must keep it).
 * So the same harness scores any version. Never imported by the bot runtime.
 */
import type { TaskOutcome } from "../observability/telemetry-types.js";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Inclusive axis-aligned box. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

export type Tier = 1 | 2 | 3 | 4;

export type Category =
  | "gather"
  | "craft"
  | "movement"
  | "doors"
  | "storage"
  | "combat"
  | "survival"
  | "build"
  | "farm"
  | "progression"
  | "conversation"
  | "interrupt"
  | "creative";

/** Named, pre-scouted locations in the fixed-seed test world (src/eval/sites.json). */
export type SiteName = "forest" | "plains" | "plains2" | "hills" | "cave" | "village" | "spawn";

export interface CheckResult {
  ok: boolean;
  /** Human-readable reason, e.g. "has 7/10 oak_log". */
  detail: string;
  /** Partial credit 0..1 (defaults to ok ? 1 : 0). */
  score?: number;
}

export interface Scenario {
  /** Stable id, "<tier-prefix>.<name>", e.g. "t1.chop_logs", "conv.followup_chest". */
  id: string;
  tier: Tier;
  category: Category;
  title: string;
  /** Hard cap for run(); the check runs once more after it. */
  timeoutMs: number;
  site: SiteName;
  /** Offset from the site origin where the bot starts (default 0,0,0 → surface at site). */
  botStart?: Vec3;
  /** Bot game mode for this scenario (default survival). */
  gameMode?: "survival" | "creative";
  /** Pillar-jumping is a violation unless the task needs it (default false). */
  pillarAllowed?: boolean;
  /** Bot chat lines above this count = chat-spam violation (default 8). */
  maxBotChats?: number;
  /** World/inventory setup after the standard reset. Register player builds with ctx.protect(). */
  setup(ctx: ScenarioCtx): Promise<void>;
  /** The player's script: usually one ctx.say() then ctx.waitForDone(). */
  run(ctx: ScenarioCtx): Promise<void>;
  /** Success check. Polled every ~5s during run() for early success, and once at the end. */
  check(ctx: ScenarioCtx): Promise<CheckResult>;
}

export interface ScenarioCtx {
  readonly bot: string; // e.g. "Steve_v2"
  readonly tester: string; // e.g. "Tester"
  /** Surface origin of this scenario's site. */
  readonly site: Vec3;
  /** Abort signal fired at timeoutMs. Long waits must honor it. */
  readonly signal: AbortSignal;

  // ── raw ───────────────────────────────────────────────────────────
  rcon(cmd: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  /** Absolute position = site + offset. */
  at(dx: number, dy: number, dz: number): Vec3;

  // ── setup ─────────────────────────────────────────────────────────
  give(player: string, item: string, count: number): Promise<void>;
  tp(player: string, pos: Vec3): Promise<void>;
  setBlock(pos: Vec3, block: string): Promise<void>;
  fill(box: Box, block: string): Promise<void>;
  /** `/place feature <id> x y z`, e.g. "minecraft:oak". */
  placeFeature(feature: string, pos: Vec3): Promise<void>;
  /** Summons with a scenario tag so checks can find it; returns the tag. */
  summon(entity: string, pos: Vec3, nbt?: string): Promise<string>;
  /** Mark a player-built region; any block in it changing to a different block type (doors/gates opening don't count) is a violation. */
  protect(box: Box, label: string): void;
  setTime(ticks: number): Promise<void>;
  /** (eval-harness addition) Standing y (ground + 1) at x,z from the Tester's loaded world; site.y if unloaded. */
  surface(x: number, z: number): Promise<number>;

  // ── player actions ────────────────────────────────────────────────
  /** Tester sends public chat. */
  say(message: string): Promise<void>;
  /** Resolves with the first bot chat line (public or whisper to Tester) after now matching `re` (default any), or null on timeout. */
  waitForBotChat(re?: RegExp, timeoutMs?: number): Promise<string | null>;
  /**
   * Resolves when the bot is idle: at least one task_end since `since`
   * (default: last say()), no task running, and no new task_start for quietMs
   * (default 8000). Also resolves early if the scenario check passes. Honors signal.
   */
  waitForDone(opts?: { quietMs?: number; since?: number }): Promise<void>;

  // ── state queries ─────────────────────────────────────────────────
  /** Item id without "minecraft:" → total count, incl. armor/offhand slots. */
  inventory(player: string): Promise<Map<string, number>>;
  /** Container contents at pos (chest, barrel, furnace...). */
  containerItems(pos: Vec3): Promise<Map<string, number>>;
  position(player: string): Promise<Vec3>;
  /** Block name without "minecraft:" (from the Tester's loaded world; Tester is kept near the site). */
  blockAt(pos: Vec3): Promise<string>;
  /** Count blocks in box whose name matches (exact string or RegExp). */
  countBlocks(box: Box, name: string | RegExp): Promise<number>;
  /** True if any entity matches the selector, e.g. "@e[tag=eval_zombie]". */
  entityExists(selector: string): Promise<boolean>;
  /** All bot chat lines seen this scenario, in order. */
  readonly botChats: readonly string[];
}

export interface ScenarioViolations {
  /** Protected (player-built) blocks changed by anything other than the Tester/RCON. */
  brokenProtected: number;
  /** pillar telemetry events when !pillarAllowed. */
  pillarRuns: number;
  /** Bot chat lines beyond maxBotChats. */
  chatSpam: number;
  deaths: number;
}

export interface ScenarioResult {
  id: string;
  tier: Tier;
  category: Category;
  /** e.g. "v1", "v2-slice1". */
  label: string;
  repeat: number;
  startedAt: string; // ISO
  ok: boolean;
  score: number;
  detail: string;
  timedOut: boolean;
  /** Harness/infra failure (scenario result not attributable to the bot). */
  harnessError?: string;
  /** First say() → success detected (or end of run if never). */
  wallMs: number;
  /** First say() → first bot chat line, harness-observed. */
  firstReplyMs: number | null;
  // From telemetry within the scenario window:
  tasks: number;
  turns: number;
  toolCalls: number;
  toolFailures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  /** cacheRead / (input + cacheRead + cacheCreate); null if no tokens. */
  cacheHitRate: number | null;
  outcomes: Partial<Record<TaskOutcome, number>>;
  violations: ScenarioViolations;
}
