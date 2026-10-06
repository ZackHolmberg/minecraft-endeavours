/**
 * Telemetry contract — the shape of every structured event the orchestrator
 * records, and of the aggregates derived from them. Shared by the writer
 * (orchestrator instrumentation) and the readers (dashboard, report CLI), so
 * both sides build against one definition.
 *
 * Storage: one JSONL file per bot at
 * `data/orchestrator/telemetry/<bot>/events.jsonl` (survives bot restarts,
 * unlike `.bot-runtime/`, which is scrubbed on stop). Size-rotated to
 * `events.1.jsonl`. One `TelemetryEvent` per line.
 *
 * Rules for writers: events are append-only and never block gameplay; strings
 * are truncated (≤200 chars) and args summarized, never full payloads.
 */

export interface TelemetryBase {
  /** Unix ms. */
  at: number;
  bot: string;
  /** Orchestrator process run id (one per `npm run start`), to split runs. */
  runId: string;
  /** Per-task id when the event happened inside a task, else null. */
  taskId: string | null;
}

export type TaskOutcome = "finished" | "stopped" | "max_turns" | "failed" | "rate_limited";

export type TelemetryEvent =
  // ── Agent / task lifecycle ────────────────────────────────────────────
  | (TelemetryBase & {
      kind: "task_start";
      /** Truncated player request (or "[orchestrator note]"). */
      request: string;
      player: string | null;
      route: string; // name-mention / whisper / continuation / follow-up / ...
      sessionMode: "per_task" | "persistent";
      /** Messages coalesced into this task (per_task). */
      coalesced: number;
      /** Ms from the player's chat arriving to the task starting (queue wait). */
      queueWaitMs: number;
      /** Ms spent building the context block; null if it timed out / failed. */
      contextBuildMs: number | null;
      contextChars: number | null;
      /**
       * Optional (added by the writer): false when this backend doesn't
       * inject a context block at all (hybrid planner), so a null
       * `contextBuildMs` isn't a timeout. Absent = injected.
       */
      contextInjected?: boolean;
    })
  | (TelemetryBase & {
      kind: "task_end";
      outcome: TaskOutcome;
      /** SDK result subtype, verbatim. */
      subtype: string;
      turns: number;
      durationMs: number;
      /** Ms from task start to the first successful say/whisper; null if none. */
      firstReplyMs: number | null;
      toolCalls: number;
      toolFailures: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreateTokens: number;
      costUsd: number | null;
    })
  | (TelemetryBase & {
      kind: "guard_refusal"; // repeat-failure guard refused an identical call
      tool: string;
      args: string;
    })
  // ── Skills ────────────────────────────────────────────────────────────
  | (TelemetryBase & {
      kind: "skill";
      skill: string;
      /** Short JSON summary of params, ≤200 chars. */
      args: string;
      ok: boolean;
      durationMs: number;
      /** Truncated result message. */
      message: string;
      cancelled: boolean;
      timedOut: boolean; // harness watchdog fired
    })
  // ── Movement ──────────────────────────────────────────────────────────
  | (TelemetryBase & {
      kind: "nav";
      label: string;
      result: "arrived" | "no_path" | "stuck" | "timeout" | "cancelled" | "error";
      distance: number; // straight-line distance at start
      durationMs: number;
      from: Vec;
      to: Vec | null;
    })
  | (TelemetryBase & {
      kind: "door";
      action: "open" | "close";
      block: string;
      pos: Vec;
    })
  | (TelemetryBase & {
      kind: "pillar";
      requested: number;
      placed: number;
      attempts: number;
      ok: boolean;
      reason: string | null;
    })
  | (TelemetryBase & {
      kind: "structure_skip"; // structure guard left player-built blocks alone
      block: string;
      skipped: number;
    })
  // ── Reflexes / survival ───────────────────────────────────────────────
  | (TelemetryBase & {
      kind: "reflex";
      reflex: "look" | "eat" | "armor" | "defend";
      detail: string;
    })
  | (TelemetryBase & { kind: "hurt"; health: number; by: string | null })
  | (TelemetryBase & { kind: "death"; pos: Vec; cause: string })
  // ── Chat / routing ────────────────────────────────────────────────────
  | (TelemetryBase & {
      kind: "chat_in";
      player: string;
      routed: boolean;
      route: string | null; // null when not routed to this bot
      isStop: boolean;
    })
  | (TelemetryBase & { kind: "chat_out"; channel: "say" | "whisper"; chars: number })
  // ── Process / connection health ───────────────────────────────────────
  | (TelemetryBase & {
      kind: "connection";
      state: "connected" | "disconnected" | "reconnecting";
      reason: string | null;
      inWorldMs: number | null;
    })
  | (TelemetryBase & { kind: "loop_lag"; lagMs: number })
  | (TelemetryBase & {
      kind: "rate_limit";
      status: string;
      resetsAt: number | null;
    });

export type TelemetryKind = TelemetryEvent["kind"];

export interface Vec {
  x: number;
  y: number;
  z: number;
}

// ── Aggregates (computed by `aggregate.ts` over any event window) ───────

export interface Percentiles {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface SkillStats {
  skill: string;
  calls: number;
  ok: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  successRate: number | null; // ok / (calls - cancelled)
  durationMs: Percentiles;
  /** Most frequent failure messages (normalized), top 3. */
  topFailures: Array<{ message: string; count: number }>;
}

export interface TelemetryAggregate {
  windowStart: number;
  windowEnd: number;
  tasks: {
    count: number;
    byOutcome: Record<TaskOutcome, number>;
    turns: Percentiles;
    durationMs: Percentiles;
    firstReplyMs: Percentiles;
    queueWaitMs: Percentiles;
    contextBuildMs: Percentiles;
    contextTimeouts: number;
    /** cacheRead / (cacheRead + cacheCreate + input), over all tasks. */
    cacheHitRate: number | null;
    tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
    costUsd: number | null;
    guardRefusals: number;
  };
  skills: SkillStats[]; // sorted by calls desc
  nav: {
    count: number;
    byResult: Record<string, number>;
    durationMs: Percentiles;
    /** Last few stuck/timeout/no_path spots, newest first. */
    problemSpots: Array<{ at: number; label: string; result: string; from: Vec }>;
  };
  doors: { opened: number; closed: number };
  pillar: { runs: number; ok: number; placed: number };
  structureSkips: number;
  reflexes: Record<"look" | "eat" | "armor" | "defend", number>;
  deaths: number;
  chat: { inbound: number; routed: number; outbound: number; stops: number };
  health: { disconnects: number; maxLoopLagMs: number | null; rateLimitEvents: number };
}
