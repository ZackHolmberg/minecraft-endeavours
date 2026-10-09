import type { Bot } from "mineflayer";
import {
  getCurrentConversationPartner,
  noteBotQuestionedPlayer,
} from "../orchestrator/chat-router.js";
import { clip, recordEvent, summarizeArgs } from "../observability/telemetry.js";
import { getBotState } from "../state/index.js";
import { awaitReflexIdle } from "./auto-behaviors.js";
import { isFlying, land } from "./flight.js";
import { resetMovementsToBase, type BotWithPathfinder } from "./pathfinder-config.js";
import type { SkillResult } from "./types.js";

/**
 * Skills whose result message is too noisy or chatty to be useful in the
 * 5-minute action log surfaced via `observeSurroundings`.
 */
const ACTION_LOG_DENYLIST = new Set([
  "observeSurroundings",
  "say",
  "whisper",
  "stop",
]);

/**
 * Skills whose result line we *don't* echo to bot.log. `observeSurroundings`
 * returns a giant blob of world data — useful inside the agent loop, useless
 * (and noisy) in the tail. Everything else is fair game so the operator can
 * see what each tool actually returned, not just what was called.
 */
const RESULT_LOG_DENYLIST = new Set(["observeSurroundings", "checkInventory"]);

const MAX_RESULT_LOG_CHARS = 220;

/**
 * Last-resort ceiling on a single skill call. Individual skills carry their
 * own tighter timeouts; this only exists so a hung mineflayer promise (a
 * window that never opens, a pathfinder goal that never resolves) can't pin
 * the agent's turn forever. `followPlayer` is indefinite by design.
 */
const SKILL_WATCHDOG_MS = 10 * 60 * 1000;

/**
 * Skills that may run while hovering in creative flight (a build in progress
 * stays airborne between placeBlocks calls, like a creative builder). Every
 * other skill lands first — pathfinder, combat and the rest assume gravity.
 */
const AIRBORNE_OK = new Set([
  "placeBlock",
  "placeBlocks",
  "getItems",
  "say",
  "whisper",
  "observeSurroundings",
  "checkInventory",
  "remember",
  "setTaskQueue",
  "advanceTaskQueue",
  "stop",
]);
const WATCHDOG_EXEMPT = new Set(["followPlayer"]);

export interface RunSkillOptions {
  /**
   * Read-only / conversational skill (`say`, `checkInventory`, ...): must not
   * clear the stop flag or overwrite the current-tool slot, so it can run while
   * a v2 job step is in flight without losing that step's stop or blanking
   * its DOING entry. Also skips the reflex wait (it touches no inventory).
   */
  readOnly?: boolean;
  /**
   * Per-call watchdog override in ms; `null` disables it. Job steps use `null`:
   * the job runner owns their timeouts (and reports them), so a silent 10-min
   * watchdog stop must not end a long gather/smelt step as a "player stop".
   */
  watchdogMs?: number | null;
}

/**
 * Wrap a skill in a try/catch so unexpected exceptions become
 * `{ ok: false, message }` results instead of taking down the bot, and
 * record successful results to the bot's recent-actions log.
 *
 * Callers (the manual chat trigger now, the Claude tool dispatcher later)
 * should always go through this rather than invoking skill functions raw —
 * skill modules deliberately stay free of cross-cutting concerns so they
 * remain unit-testable as plain async functions.
 */
export async function runSkill<P, R extends SkillResult>(
  bot: Bot,
  name: string,
  params: P,
  fn: (params: P) => Promise<R>,
  opts: RunSkillOptions = {},
): Promise<SkillResult> {
  const state = getBotState(bot.username);
  const readOnly = opts.readOnly === true;
  const watchdogMs = opts.watchdogMs === undefined ? SKILL_WATCHDOG_MS : opts.watchdogMs;
  // Don't let a skill's equip / window clicks interleave with an in-flight
  // reflex (auto-eat, armor, defensive swing). `stop` touches no inventory
  // and must not be delayed by a reflex.
  if (name !== "stop" && !readOnly) await awaitReflexIdle(bot.username);
  // Every skill starts with a clean stop flag. Without this a "stop" that
  // ended one skill (or a death) stays latched and the next skill's
  // `navigate` aborts instantly as "cancelled". `stop` itself is exempt.
  if (name !== "stop" && !readOnly) state?.cancellation.begin();
  if (isFlying(bot) && !AIRBORNE_OK.has(name)) await land(bot);
  // A side-channel `stop` (NpcAgent.maybeInterrupt) runs while another skill
  // is still in flight. It must not overwrite / clear that skill's entry:
  // the per-task backend's waitForToolIdle and the reflexes key off it.
  const trackTool = !readOnly && !(name === "stop" && state?.currentTool.current());
  const toolToken = trackTool ? state?.currentTool.begin(name) : undefined;

  let result: SkillResult;
  let watchdog: NodeJS.Timeout | null = null;
  let watchdogFired = false;
  const startedAt = Date.now();
  try {
    const run = fn(params);
    if (WATCHDOG_EXEMPT.has(name) || watchdogMs === null) {
      result = await run;
    } else {
      const timedOut = new Promise<SkillResult>((resolve) => {
        watchdog = setTimeout(() => {
          watchdogFired = true;
          // Ask the skill to wind down and halt movement; the original
          // promise is abandoned (it can't be force-cancelled).
          state?.cancellation.request("watchdog");
          (bot as Bot & { pathfinder?: { stop(): void } }).pathfinder?.stop();
          // The abandoned skill may be inside a digging-Movements scope; its
          // `finally` would otherwise restore (or fail to restore) it later,
          // under whatever skill runs next. Put the no-dig policy back now.
          try {
            if ((bot as Partial<BotWithPathfinder>).pathfinder) resetMovementsToBase(bot as BotWithPathfinder);
          } catch {
            // best-effort
          }
          resolve({ ok: false, message: `${name} timed out after ${watchdogMs >= 60_000 ? `${Math.round(watchdogMs / 600) / 100} min` : `${Math.round(watchdogMs / 100) / 10}s`} and was abandoned` });
        }, watchdogMs);
      });
      result = await Promise.race([run, timedOut]);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[skill ${name}] threw:`, err);
    result = { ok: false, message: `${name} crashed: ${message}` };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (trackTool) state?.currentTool.end(toolToken);
  }

  // The stop flag stays latched until the next skill's begin(), so a stop that
  // landed during this call is still visible here.
  const stopRequested = name !== "stop" && !watchdogFired && state?.cancellation.isRequested() === true;
  recordSkillEvent(bot.username, name, params, result, startedAt, watchdogFired, stopRequested);

  if (result.ok && !ACTION_LOG_DENYLIST.has(name)) {
    state?.actions.record(result.message);
  }

  if (result.ok && (name === "say" || name === "whisper")) {
    maybeNoteQuestion(bot, name, params, result);
  }

  if (!RESULT_LOG_DENYLIST.has(name)) {
    const arrow = result.ok ? "←" : "✗";
    const trimmed = truncate(result.message, MAX_RESULT_LOG_CHARS);
    console.log(`[${bot.username}] ${arrow} ${name}: ${trimmed}`);
  }

  return result;
}

/** Telemetry `skill` event. Observe-only. */
function recordSkillEvent(
  username: string,
  name: string,
  params: unknown,
  result: SkillResult,
  startedAt: number,
  timedOut: boolean,
  stopRequested: boolean,
): void {
  try {
    const st = result.state as { cancelled?: unknown } | undefined;
    recordEvent(username, {
      kind: "skill",
      skill: name,
      args: summarizeArgs(params),
      ok: result.ok,
      durationMs: Date.now() - startedAt,
      message: clip(result.message ?? ""),
      cancelled: stopRequested || st?.cancelled === true || /\bcancell?ed\b/i.test(result.message ?? ""),
      timedOut,
    });
  } catch {
    // never let telemetry reach the skill path
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Conversation-continuity heuristic: when the bot says or whispers a message
 * containing `?`, flag the target player for 30 seconds so their next chat
 * routes back to this bot without requiring another name-mention. Pure
 * middleware — see ARCHITECTURE.md "Conversation continuity".
 *
 * Why `includes("?")` rather than `endsWith("?")`: the model often appends a
 * short acknowledgment after the question ("What size? Let me know"), and
 * the original strict-ends-with check missed those. A false positive (a
 * non-question message that happens to contain `?`) just over-routes the
 * player's next unaddressed chat to this bot for 30s, which is harmless.
 */
function maybeNoteQuestion(bot: Bot, name: string, params: unknown, result: SkillResult): void {
  const sent = (result.state as { sent?: string } | undefined)?.sent?.trim();
  if (!sent || !sent.includes("?")) return;

  const target =
    name === "whisper"
      ? (params as { player?: string }).player
      : getCurrentConversationPartner(bot.username);
  if (!target) {
    console.log(
      `[${bot.username}] continuity skipped — ?-message detected but no conversation partner to flag`,
    );
    return;
  }

  noteBotQuestionedPlayer(bot.username, target);
  console.log(`[${bot.username}] continuity armed for ${target} (30s)`);
}
