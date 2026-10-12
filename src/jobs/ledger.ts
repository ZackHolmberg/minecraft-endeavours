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
/** A failed build counts as "the same place" when its anchor or origin is within this many blocks of the new request. */
export const BUILD_NEAR_BLOCKS = 16;
/** Unfinished structures are remembered this long, so a later `build` resumes onto them instead of starting a second one. */
export const BUILD_PARTIAL_TTL_MS = 2 * 60 * 60_000;

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

type P3 = { x: number; y: number; z: number };

/** What a build job left behind (recorded when it ends failed / cancelled / interrupted with blocks placed, or when it fails at all). */
export interface BuildRecord {
  /** Job id: a later record for the same job (final block count after a stop) replaces the earlier one. */
  jobId?: string;
  at: number;
  blueprint: string;
  anchor: P3;
  origin: P3 | null;
  facing: string | null;
  params: Record<string, unknown>;
  placed: number;
  total: number;
  kind: FailureKind | "cancelled";
  /** Counts toward the refusal limit (a cancel by the player does not). */
  failure: boolean;
}

const dist2d = (a: P3, b: P3): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Failed builds, keyed by blueprint + place (review M3). Two jobs:
 *  - `partial()`: the newest unfinished structure near a new request, so `build` resumes onto
 *    it (stored origin/facing/params) rather than starting a second house next to it. Survives
 *    `clear()` (a player's chat doesn't remove the half-built wall).
 *  - `refusal()`: the same build failing {@link LEDGER_MAX_FAILURES} times in the window at one place
 *    makes `build` refuse (until a player speaks again, like goals).
 */
export class BuildFailureLedger {
  private records: BuildRecord[] = [];

  constructor(
    private readonly windowMs: number = LEDGER_WINDOW_MS,
    private readonly maxFailures: number = LEDGER_MAX_FAILURES,
    private readonly ttlMs: number = BUILD_PARTIAL_TTL_MS,
  ) {}

  private near(r: BuildRecord, blueprint: string, anchor: P3): boolean {
    return r.blueprint === blueprint && (dist2d(r.anchor, anchor) <= BUILD_NEAR_BLOCKS || (r.origin !== null && dist2d(r.origin, anchor) <= BUILD_NEAR_BLOCKS));
  }

  record(r: BuildRecord): void {
    this.records = this.records.filter((x) => r.at - x.at <= this.ttlMs && (r.jobId === undefined || x.jobId !== r.jobId));
    this.records.push(r);
  }

  /** The newest unfinished structure of this blueprint near `anchor` (something is actually placed). */
  partial(blueprint: string, anchor: P3, now: number = Date.now()): BuildRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (now - r.at > this.ttlMs) continue;
      if (this.near(r, blueprint, anchor) && r.origin && r.facing && r.placed > 0 && r.placed < r.total) return r;
    }
    return null;
  }

  /** Non-null message when this blueprint already failed too often at this place recently. */
  refusal(blueprint: string, anchor: P3, now: number = Date.now()): string | null {
    const fails = this.records.filter((r) => r.failure && now - r.at <= this.windowMs && this.near(r, blueprint, anchor));
    if (fails.length < this.maxFailures) return null;
    const last = fails[fails.length - 1]!;
    const mins = Math.round(this.windowMs / 60_000);
    return (
      `not started: the ${blueprint} already failed ${fails.length} times near here in the last ${mins} min (${fails.map((f) => f.kind).join(", ")}; ${last.placed}/${last.total} blocks placed at ${last.origin ? `${last.origin.x}, ${last.origin.y}, ${last.origin.z}` : "an unknown spot"}). ` +
      `Another try won't change the outcome — tell the player what's blocking, ask for help (materials, a flatter spot), or pick a different place.`
    );
  }

  /** A finished build wipes every record of that blueprint at that place. */
  success(blueprint: string, anchor: P3): void {
    this.records = this.records.filter((r) => !this.near(r, blueprint, anchor));
  }

  /** A new player message: the situation may have changed — forget failure counts, keep the unfinished structures. */
  clearFailures(): void {
    this.records = this.records.map((r) => (r.failure ? { ...r, failure: false } : r));
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
const buildLedgers = new Map<string, BuildFailureLedger>();

export function buildLedgerFor(username: string): BuildFailureLedger {
  let l = buildLedgers.get(username);
  if (!l) buildLedgers.set(username, (l = new BuildFailureLedger()));
  return l;
}

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
  buildLedgers.get(username)?.clearFailures();
  limiters.get(username)?.reset();
}
