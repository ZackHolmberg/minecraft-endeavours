/**
 * Hybrid backend — Claude plans, Qwen executes.
 *
 * Composes a `ClaudeBackend` (the planner: front door + task-queue author) and
 * a `LocalBackend` (the executor: drains the queue on the curated tool surface),
 * behind the shared `AgentBackend` seam. The two run STRICTLY SEQUENTIALLY —
 * both drive the same mineflayer `bot`, so they must never act concurrently;
 * the coordinator awaits each turn before starting the next.
 *
 * Coordination channel is the per-bot `TaskQueue` in shared state:
 *  - The planner calls `setTaskQueue` (its only way to make work happen — it has
 *    no execution tools). A queue-revision bump after the planner turn is the
 *    handoff signal.
 *  - The executor reads the current task via `observeSurroundings` and advances
 *    it with `advanceTaskQueue`; a revision bump during an executor turn is
 *    progress.
 *
 * Replan is driven by DETERMINISTIC signals measured from shared state (no LLM
 * judging progress): an executor turn that drains the queue = done; a turn with
 * no progress (queue unchanged AND inventory unchanged AND position ~unchanged)
 * = stall → re-invoke the planner with a failure note. Bounded by MAX_REPLANS
 * and a total executor-turn budget.
 *
 * Dashboard getters delegate to the planner (the Claude budget that matters);
 * local token usage can be surfaced separately later.
 */

import type { Bot } from "mineflayer";
import { getBotState } from "../../state/index.js";
import { SKILL_SPECS, type SkillSpec } from "../../skills/registry.js";
import type { BotConfig } from "../../types.js";
import { buildPlanningContext } from "../planning-context.js";
import { buildExecutorSystemPrompt, buildPlannerSystemPrompt } from "../system-prompt.js";
import { ClaudeBackend } from "./claude-backend.js";
import { LocalBackend } from "./local-backend.js";
import type {
  AgentBackend,
  LastTurnError,
  RateLimitInfo,
  SessionUsage,
  TurnUsage,
  WindowStats,
} from "./types.js";

// Planner surface: talk-or-plan only (say/whisper/setTaskQueue/remember + read-only observe/checkInventory).
const PLANNER_SPECS: SkillSpec[] = SKILL_SPECS.filter((s) => s.surfaces.planner);

// How many replans (planner re-invocations on stall) before giving up on a message.
const MAX_REPLANS = 2;
// Steps the executor may take per burst before returning control to the
// coordinator. Kept small so we checkpoint progress often and can catch a
// runaway (e.g. over-harvesting) before it does too much.
const EXECUTOR_BURST_STEPS = 8;
// Total executor bursts per player message, across all plan attempts — a hard
// safety bound so a loop can't run forever.
const MAX_TOTAL_EXECUTOR_TURNS = 24;
// Consecutive executor bursts that stay busy (inventory/position changing) but
// never advance the task queue before we treat it as a soft stall and replan.
// This is the blind-spot fix: "busy" is not the same as "making progress on the
// task" — a bot chopping a whole forest without completing the task must stop.
const MAX_TURNS_WITHOUT_ADVANCE = 3;
// Position delta (blocks) above which we count movement as activity.
const POSITION_PROGRESS_THRESHOLD = 1.0;

const EXEC_KICKOFF = "A plan has been set. Begin executing the current task queue now.";
const EXEC_CONTINUE = "Continue executing the current task queue.";

interface ProgressSnapshot {
  queueRev: number;
  invSig: string;
  pos: { x: number; y: number; z: number };
}

export interface HybridBackendOptions {
  bot: Bot;
  botConfig: BotConfig;
}

export class HybridBackend implements AgentBackend {
  private readonly planner: ClaudeBackend;
  private readonly executor: LocalBackend;
  private readonly pending: string[] = [];
  private draining = false;
  private stopped = false;

  constructor(private readonly opts: HybridBackendOptions) {
    const { bot, botConfig } = opts;
    const hybrid = botConfig.hybrid;
    if (!hybrid) {
      throw new Error(
        `[${bot.username}] HybridBackend requires botConfig.hybrid — check config parsing`,
      );
    }

    this.planner = new ClaudeBackend({
      bot,
      botConfig,
      systemPrompt: buildPlannerSystemPrompt(bot.username),
      specs: PLANNER_SPECS,
      modelHint: hybrid.plannerModelHint,
    });
    this.executor = new LocalBackend({
      bot,
      botConfig,
      local: hybrid.executor,
      systemPrompt: buildExecutorSystemPrompt(bot.username),
      maxSteps: EXECUTOR_BURST_STEPS,
    });
    console.log(
      `[${bot.username}] hybrid backend — planner=${hybrid.plannerModelHint} (${PLANNER_SPECS.length} tools), executor=${hybrid.executor.model}`,
    );
  }

  // ── AgentBackend entry point ────────────────────────────────────────────

  pushUserMessage(content: string): void {
    if (this.stopped) return;
    this.pending.push(content);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.pending.length > 0) {
        const content = this.pending.shift()!;
        try {
          await this.handlePlayerMessage(content);
        } catch (err) {
          console.error(`[${this.opts.bot.username}] hybrid loop error:`, err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async handlePlayerMessage(content: string): Promise<void> {
    const { bot } = this.opts;
    const tag = `[${bot.username}] [hybrid]`;
    // Fresh intent — clear any stale stop request (see LocalBackend note).
    getBotState(bot.username)?.cancellation.begin();

    // ── Plan (or just reply) ──────────────────────────────────────────────
    const context = await buildPlanningContext(bot);
    const revBefore = this.taskRevision();
    await this.planner.runTurn(`${context}\n\n${content}`);
    if (this.stopped) return;

    const planned = this.taskRevision() !== revBefore && !this.taskQueueEmpty();
    if (!planned) {
      // The planner replied conversationally (no setTaskQueue) — nothing to run.
      return;
    }
    console.log(`${tag} plan set: ${this.taskSummary()} — handing off to executor`);

    // ── Execute, with deterministic stall-driven replanning ───────────────
    //
    // Two distinct stall signals:
    //  - HARD stall: a burst with no activity at all (queue/inventory/position
    //    unchanged) — the executor is truly stuck.
    //  - SOFT stall: bursts that stay busy but never ADVANCE the task queue for
    //    MAX_TURNS_WITHOUT_ADVANCE in a row — e.g. over-harvesting without ever
    //    completing the task. "Busy" is not "progress on the task".
    let replans = 0;
    let totalTurns = 0;
    let turnsSinceAdvance = 0;
    while (!this.stopped) {
      if (this.isCancelled()) {
        console.log(`${tag} cancelled`);
        return;
      }
      if (totalTurns >= MAX_TOTAL_EXECUTOR_TURNS) {
        console.warn(`${tag} executor burst budget (${MAX_TOTAL_EXECUTOR_TURNS}) exhausted; stopping`);
        return;
      }

      const revBefore = this.taskRevision();
      const before = this.snapshot();
      const outcome = await this.executor.runTurn(totalTurns === 0 ? EXEC_KICKOFF : EXEC_CONTINUE);
      totalTurns += 1;
      if (this.stopped) return;

      if (outcome.serverUnreachable) {
        console.warn(`${tag} executor server unreachable — aborting (not a replan)`);
        return;
      }
      if (this.taskQueueEmpty()) {
        console.log(`${tag} plan complete (${totalTurns} burst(s))`);
        return;
      }

      const advanced = this.taskRevision() > revBefore;
      if (advanced) {
        // A task was completed and the queue moved on — real forward progress.
        turnsSinceAdvance = 0;
        continue;
      }
      turnsSinceAdvance += 1;

      const active = this.progressed(before, this.snapshot());
      if (active && turnsSinceAdvance < MAX_TURNS_WITHOUT_ADVANCE) {
        // Busy and hasn't been stuck-on-the-same-task too long — give it slack.
        continue;
      }

      // Stall (hard = no activity; soft = busy but not advancing) → replan.
      const reason = active ? "busy but not completing the task" : "no activity";
      replans += 1;
      if (replans > MAX_REPLANS) {
        console.warn(`${tag} stalled (${reason}) and out of replans (${MAX_REPLANS}); stopping`);
        return;
      }
      console.log(`${tag} stall — ${reason}; re-invoking planner (replan ${replans}/${MAX_REPLANS})`);

      const revBeforeReplan = this.taskRevision();
      await this.planner.runTurn(await this.buildReplanContext(reason));
      if (this.stopped || this.isCancelled()) return;

      if (this.taskQueueEmpty()) {
        console.log(`${tag} planner ended the plan`);
        return;
      }
      if (this.taskRevision() === revBeforeReplan) {
        // Planner replied but didn't revise the queue — avoid a tight loop.
        console.log(`${tag} planner did not revise the plan; stopping`);
        return;
      }
      turnsSinceAdvance = 0; // fresh plan in place — loop back to execute it.
    }
  }

  private async buildReplanContext(reason: string): Promise<string> {
    const context = await buildPlanningContext(this.opts.bot);
    const current = getBotState(this.opts.bot.username)?.tasks.current() ?? "(none)";
    const detail =
      reason === "no activity"
        ? `it appears stuck (missing tool/material, unreachable target, or a bad step)`
        : `it is working but never completing the task — likely over-gathering, looping, or the goal is too open-ended`;
    return (
      `${context}\n\n[execution update] The executor is not making progress on the current task ` +
      `("${current}") — ${detail}. Revise the plan with setTaskQueue (bound the amount with a concrete ` +
      `count, secure a missing prerequisite, pick a different resource, or split the step), or tell the ` +
      `player with say if it can't be done.`
    );
  }

  // ── Progress measurement (deterministic, from shared state) ─────────────

  private snapshot(): ProgressSnapshot {
    return {
      queueRev: this.taskRevision(),
      invSig: this.inventorySignature(),
      pos: this.position(),
    };
  }

  private progressed(before: ProgressSnapshot, after: ProgressSnapshot): boolean {
    if (after.queueRev !== before.queueRev) return true;
    if (after.invSig !== before.invSig) return true;
    return distance(before.pos, after.pos) > POSITION_PROGRESS_THRESHOLD;
  }

  private inventorySignature(): string {
    const counts = new Map<string, number>();
    for (const item of this.opts.bot.inventory.items()) {
      counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
    }
    return [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([n, c]) => `${n}:${c}`)
      .join(",");
  }

  private position(): { x: number; y: number; z: number } {
    const p = this.opts.bot.entity?.position;
    return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };
  }

  private taskRevision(): number {
    return getBotState(this.opts.bot.username)?.tasks.revision() ?? 0;
  }

  private taskQueueEmpty(): boolean {
    return getBotState(this.opts.bot.username)?.tasks.isEmpty() ?? true;
  }

  private taskSummary(): string {
    const tasks = getBotState(this.opts.bot.username)?.tasks;
    if (!tasks) return "(none)";
    const current = tasks.current();
    const remaining = tasks.remaining();
    return `${current ?? "(none)"}${remaining.length ? ` (+${remaining.length} queued)` : ""}`;
  }

  private isCancelled(): boolean {
    return getBotState(this.opts.bot.username)?.cancellation.isRequested() ?? false;
  }

  // ── Dashboard observability — delegate to the planner (the Claude budget) ─

  isRateLimited(): boolean {
    return this.planner.isRateLimited();
  }
  getCooldownRemainingMinutes(): number {
    return this.planner.getCooldownRemainingMinutes();
  }
  getRateLimitInfo(): RateLimitInfo | null {
    return this.planner.getRateLimitInfo();
  }
  getLastTurnUsage(): TurnUsage | null {
    return this.planner.getLastTurnUsage();
  }
  getSessionUsage(): SessionUsage {
    return this.planner.getSessionUsage();
  }
  getLastTurnError(): LastTurnError | null {
    return this.planner.getLastTurnError();
  }
  getWindowStats(): WindowStats {
    return this.planner.getWindowStats();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.length = 0;
    await Promise.all([this.planner.stop(), this.executor.stop()]);
  }
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
