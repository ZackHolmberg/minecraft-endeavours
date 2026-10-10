/**
 * Loop guards for the job -> Haiku -> `achieve` cycle (review finding H2).
 *
 *  - GoalFailureLedger: per bot, remembers which goal sets failed and why. The
 *    same goal set failing MAX_FAILURES times within WINDOW_MS makes `achieve`
 *    refuse (ok:false) until a player speaks again, so a goal that can't be met
 *    (no diamonds nearby) doesn't burn quota overnight.
 *  - JobEventLimiter: caps synthetic `[job ...]` events queued to the agent.
 *
 * Pure (injectable clock); in-memory per bot, module-level so it survives
 * reconnects (not orchestrator restarts).
 */
import type { FailureKind, Goal } from "../planner/types.js";

export const LEDGER_WINDOW_MS = 30 * 60_000;
export const LEDGER_MAX_FAILURES = 2;
export const JOB_EVENT_WINDOW_MS = 10 * 60_000;
export const JOB_EVENT_MAX = 3;

/** Normalized identity of a goal set: duplicates merged, sorted `item:count`. */
export function goalSignature(goals: readonly Goal[]): string {
  const merged = new Map<string, number>();
  for (const g of goals) merged.set(g.item, (merged.get(g.item) ?? 0) + g.count);
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([item, count]) => `${item}:${count}`)
    .join(",");
}

interface Failure {
  at: number;
  kind: FailureKind;
}

export class GoalFailureLedger {
  private readonly bySig = new Map<string, Failure[]>();

  constructor(
    private readonly windowMs: number = LEDGER_WINDOW_MS,
    private readonly maxFailures: number = LEDGER_MAX_FAILURES,
  ) {}

  private recent(sig: string, now: number): Failure[] {
    const kept = (this.bySig.get(sig) ?? []).filter((f) => now - f.at <= this.windowMs);
    if (kept.length > 0) this.bySig.set(sig, kept);
    else this.bySig.delete(sig);
    return kept;
  }

  recordFailure(goals: readonly Goal[], kind: FailureKind, now: number = Date.now()): void {
    const sig = goalSignature(goals);
    this.bySig.set(sig, [...this.recent(sig, now), { at: now, kind }]);
  }

  /** A success wipes that goal set's history. */
  recordSuccess(goals: readonly Goal[]): void {
    this.bySig.delete(goalSignature(goals));
  }

  /** Non-null message when these goals have failed too often recently. */
  refusal(goals: readonly Goal[], now: number = Date.now()): string | null {
    const fails = this.recent(goalSignature(goals), now);
    if (fails.length < this.maxFailures) return null;
    const kinds = fails.map((f) => f.kind).join(", ");
    const mins = Math.round(this.windowMs / 60_000);
    return (
      `not started: this same goal already failed ${fails.length} times in the last ${mins} min (${kinds}). ` +
      `Running it again won't change the outcome — tell the player what's blocking, ask them for help ` +
      `(e.g. where to find it, or to hand you the item), or try a different approach / different goals.`
    );
  }

  /** A new player message: the situation may have changed, forget everything. */
  clear(): void {
    this.bySig.clear();
  }
}

export class JobEventLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly windowMs: number = JOB_EVENT_WINDOW_MS,
    private readonly max: number = JOB_EVENT_MAX,
  ) {}

  /** True (and counts it) when another synthetic event may be queued now. */
  allow(now: number = Date.now()): boolean {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }

  reset(): void {
    this.stamps = [];
  }
}

// ── per-bot registry ────────────────────────────────────────────────────────

const ledgers = new Map<string, GoalFailureLedger>();
const limiters = new Map<string, JobEventLimiter>();

export function ledgerFor(username: string): GoalFailureLedger {
  let l = ledgers.get(username);
  if (!l) ledgers.set(username, (l = new GoalFailureLedger()));
  return l;
}

export function eventLimiterFor(username: string): JobEventLimiter {
  let l = limiters.get(username);
  if (!l) limiters.set(username, (l = new JobEventLimiter()));
  return l;
}

/** A routed, non-synthetic player chat arrived for this bot. */
export function noteExternalChat(username: string): void {
  ledgers.get(username)?.clear();
  limiters.get(username)?.reset();
}
