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
// Total executor turns per player message, across all plan attempts — a hard
// safety bound so a progressing-but-never-draining loop can't run forever.
const MAX_TOTAL_EXECUTOR_TURNS = 12;
// Position delta (blocks) above which we count movement as progress.
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
    let replans = 0;
    let totalTurns = 0;
    while (!this.stopped) {
      if (this.isCancelled()) {
        console.log(`${tag} cancelled`);
        return;
      }
      if (totalTurns >= MAX_TOTAL_EXECUTOR_TURNS) {
        console.warn(`${tag} executor turn budget (${MAX_TOTAL_EXECUTOR_TURNS}) exhausted; stopping`);
        return;
      }

      const before = this.snapshot();
      const outcome = await this.executor.runTurn(totalTurns === 0 ? EXEC_KICKOFF : EXEC_CONTINUE);
      totalTurns += 1;
      if (this.stopped) return;

      if (outcome.serverUnreachable) {
        console.warn(`${tag} executor server unreachable — aborting (not a replan)`);
        return;
      }
      if (this.taskQueueEmpty()) {
        console.log(`${tag} plan complete (${totalTurns} executor turn(s))`);
        return;
      }

      if (this.progressed(before, this.snapshot())) {
        continue; // making headway — keep executing the same plan
      }

      // Stall: no progress this turn and the queue isn't drained → replan.
      replans += 1;
      if (replans > MAX_REPLANS) {
        console.warn(`${tag} stalled and out of replans (${MAX_REPLANS}); stopping`);
        return;
      }
      console.log(`${tag} stall detected — re-invoking planner (replan ${replans}/${MAX_REPLANS})`);

      const revBeforeReplan = this.taskRevision();
      await this.planner.runTurn(await this.buildReplanContext());
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
      // Revised plan in place — loop back to execute it.
    }
  }

  private async buildReplanContext(): Promise<string> {
    const context = await buildPlanningContext(this.opts.bot);
    const current = getBotState(this.opts.bot.username)?.tasks.current() ?? "(none)";
    return (
      `${context}\n\n[execution update] The executor made no progress on the current task ` +
      `("${current}") — it appears stuck (missing tool/material, unreachable target, or a bad step). ` +
      `Revise the plan with setTaskQueue to address the blocker (secure the prerequisite first, ` +
      `pick a different resource, or split the step), or tell the player with say if it can't be done.`
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
