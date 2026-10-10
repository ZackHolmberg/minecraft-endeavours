/**
 * The `achieve` / `cancelJob` skills (registered in skills/registry.ts), and
 * the pure policy for which Haiku tool calls auto-cancel a running job.
 */
import type { Bot } from "mineflayer";
import { defaultPlanks } from "../build/materials.js";
import { getCurrentConversationPartner } from "../orchestrator/chat-router.js";
import type { Goal } from "../planner/types.js";
import { resolveItem } from "../skills/item-naming.js";
import type { SkillResult } from "../skills/types.js";
import { isOperatorItem } from "../skills/creative.js";
import { isCreative } from "../skills/game-mode.js";
import { holdsDoor, pickShelterWall } from "./night.js";
import { goalsText } from "./describe.js";
import { findPlayer } from "./steps/deliver.js";
import { inventoryTotals } from "./world-view.js";
import { ledgerFor } from "./ledger.js";
import { getJobRunner } from "./registry.js";
import type { AchieveResult, BuildSpec } from "./types.js";

/** Tools that never disturb a running job: reads, talk, notes, job control. Everything else is a new instruction. */
export const JOB_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "say",
  "whisper",
  "observeSurroundings",
  "checkInventory",
  "remember",
  "setTaskQueue",
  "advanceTaskQueue",
  "achieve",
  "build",
  "surviveNight",
  "cancelJob",
]);

/** True when calling `tool` should cancel the running job first (and tell the model so). */
export function shouldCancelJobFor(tool: string, jobRunning: boolean): boolean {
  return jobRunning && !JOB_EXEMPT_TOOLS.has(tool);
}

/** Hand-over size limits per goal item: 2 stacks of a stackable (128 of a 64-stack), 4 of an unstackable. */
export const DELIVER_MAX_STACKS = 2;
export const DELIVER_MAX_UNSTACKABLE = 4;

export function deliverCap(stackSize: number): number {
  return stackSize <= 1 ? DELIVER_MAX_UNSTACKABLE : DELIVER_MAX_STACKS * stackSize;
}

export interface AchieveParams {
  goals: Array<{ item: string; count: number }>;
  /** Hand the goal items to this player once they're in hand ("give me / get me X"). */
  deliverTo?: string;
}

/** Validate names (with did-you-mean), merge duplicates, start the job, return at once. */
export async function achieve(bot: Bot, { goals, deliverTo }: AchieveParams): Promise<SkillResult> {
  const runner = getJobRunner(bot.username);
  if (!runner) return { ok: false, message: "the job runner isn't available right now" };
  if (isCreative(bot) && !deliverTo) {
    return { ok: false, message: "creative mode: don't gather or craft — take what you need with getItems (or pass deliverTo to hand items to a player)", state: { ok: false, jobId: null } };
  }
  let recipient: string | null = null;
  if (deliverTo) {
    recipient = findPlayer(bot, deliverTo);
    if (!recipient) {
      const msg = `can't hand things to "${deliverTo}": no player by that name is in sight. Ask them to come closer, or omit deliverTo.`;
      return { ok: false, message: msg, state: { ok: false, jobId: null, message: msg } satisfies AchieveResult };
    }
  }
  const merged = new Map<string, number>();
  const errors: string[] = [];
  const stackSizes = new Map<string, number>();
  for (const g of goals) {
    const r = resolveItem(bot, g.item);
    if (!r.ok) {
      errors.push(`goals item ${r.message}`);
      continue;
    }
    if (recipient && isOperatorItem(r.normalized)) {
      errors.push(`${r.normalized} is an operator/technical item; I don't hand those out`);
      continue;
    }
    stackSizes.set(r.normalized, bot.registry.items[r.data.id]?.stackSize ?? 64);
    merged.set(r.normalized, (merged.get(r.normalized) ?? 0) + Math.max(1, Math.floor(g.count)));
  }
  // A hand-over is capped per item (abuse / runaway gathers): clamp and tell the model.
  const capNotes: string[] = [];
  if (recipient) {
    for (const [item, n] of merged) {
      const cap = deliverCap(stackSizes.get(item) ?? 64);
      if (n > cap) {
        merged.set(item, cap);
        capNotes.push(`${item} ${n} -> ${cap}`);
      }
    }
  }
  if (errors.length > 0) {
    const res: AchieveResult = { ok: false, jobId: null, message: errors.join("; ") };
    return { ok: false, message: res.message, state: res };
  }
  const list: Goal[] = [...merged.entries()].map(([item, count]) => ({ item, count }));
  const refusal = ledgerFor(bot.username).refusal(list);
  if (refusal) {
    console.log(`[${bot.username}] achieve refused by the failure ledger: ${goalsText(list)}`);
    return { ok: false, message: refusal, state: { ok: false, jobId: null, message: refusal } satisfies AchieveResult };
  }
  const res = await runner.start(list, getCurrentConversationPartner(bot.username) ?? null, { deliverTo: recipient });
  return {
    ok: res.ok,
    message: res.ok
      ? `job started: ${goalsText(list)}${recipient ? ` → give to ${recipient}` : ""}${capNotes.length > 0 ? ` (capped at 2 stacks / 4 unstackable per hand-over: ${capNotes.join(", ")}; tell the player)` : ""}. Plan: ${res.message}. It runs in the background; reply briefly and end your turn — you'll get a [job finished]/[job failed] message.`
      : res.message,
    state: res,
  };
}

export interface BuildParams {
  blueprint: "house" | "portal" | "farm";
  params?: Record<string, unknown>;
  at?: "here" | { x: number; y: number; z: number };
}

/**
 * Start a build job. "here" = beside the requesting player (else the bot). The
 * site, materials gap and oriented blueprint are worked out by the runner's
 * builder; this resolves the anchor, fills the one inventory-dependent default
 * (which planks), and returns at once like `achieve`.
 */
export async function build(bot: Bot, { blueprint, params, at }: BuildParams): Promise<SkillResult> {
  const runner = getJobRunner(bot.username);
  if (!runner) return { ok: false, message: "the job runner isn't available right now" };
  const requester = getCurrentConversationPartner(bot.username) ?? null;
  const floor = (p: { x: number; y: number; z: number }) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  const me = floor(bot.entity.position);
  const reqEntity = requester ? bot.players[requester]?.entity : undefined;
  let anchor = me;
  if (at && at !== "here") anchor = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
  else if (reqEntity) anchor = floor(reqEntity.position);
  // never cover a nearby player
  const avoid: Array<{ x: number; y: number; z: number }> = [];
  for (const [name, p] of Object.entries(bot.players)) {
    if (name === bot.username || !p.entity) continue;
    if (p.entity.position.distanceTo(bot.entity.position) <= 48) avoid.push(floor(p.entity.position));
  }
  const resolved: Record<string, unknown> = { ...(params ?? {}) };
  if (blueprint === "house" && typeof resolved.wall !== "string") resolved.wall = defaultPlanks(inventoryTotals(bot.inventory.slots));
  if (blueprint === "farm") delete resolved.water; // decided by the site
  const spec: BuildSpec = { blueprint, params: resolved, anchor, avoid };
  const res = await runner.startBuild(spec, requester);
  return {
    ok: res.ok,
    message: res.ok
      ? `build started: ${res.message}. It runs in the background; reply briefly and end your turn — you'll get a [job finished]/[job failed] message.`
      : res.message,
    state: res,
  };
}

export interface SurviveNightParams {
  /** false = never sleep in a bed, build a shelter even when a bed is at hand (default true: a bed at hand wins). */
  useBed?: boolean;
}

/**
 * Start the night job: sleep if a bed is at hand, else build a minimal shelter next to the
 * requesting player (from dirt / cobblestone / planks, a door only if one is carried), get in,
 * close up and wait for dawn. Returns at once like `build`.
 */
export async function surviveNight(bot: Bot, { useBed }: SurviveNightParams = {}): Promise<SkillResult> {
  const runner = getJobRunner(bot.username);
  if (!runner) return { ok: false, message: "the job runner isn't available right now" };
  if (isCreative(bot)) return { ok: false, message: "creative mode: mobs can't hurt you, so there is nothing to survive. Just carry on." };
  const requester = getCurrentConversationPartner(bot.username) ?? null;
  const floor = (p: { x: number; y: number; z: number }) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  const reqEntity = requester ? bot.players[requester]?.entity : undefined;
  const anchor = floor((reqEntity ?? bot.entity).position);
  const avoid: Array<{ x: number; y: number; z: number }> = [];
  for (const [name, p] of Object.entries(bot.players)) {
    if (name === bot.username || !p.entity) continue;
    if (p.entity.position.distanceTo(bot.entity.position) <= 48) avoid.push(floor(p.entity.position));
  }
  const inv = inventoryTotals(bot.inventory.slots);
  const params: Record<string, unknown> = { wall: pickShelterWall(inv), door: holdsDoor(inv), ...(useBed === false ? { useBed: false } : {}) };
  const res = await runner.startBuild({ blueprint: "shelter", params, anchor, avoid, hold: "night" }, requester);
  return {
    ok: res.ok,
    message: res.ok
      ? `night job started: ${res.message}. It runs in the background (building, then waiting inside until dawn); reply briefly and end your turn — you'll get a [job finished]/[job failed] message. Don't call movement/building tools while it runs (that cancels it).`
      : res.message,
    state: res,
  };
}

export async function cancelJob(bot: Bot): Promise<SkillResult> {
  const runner = getJobRunner(bot.username);
  const job = runner?.current();
  if (!runner || !job || job.status !== "running") return { ok: true, message: "no job is running" };
  await runner.cancel("cancelJob");
  return { ok: true, message: `cancelled the job (${goalsText(job.goals)})` };
}
