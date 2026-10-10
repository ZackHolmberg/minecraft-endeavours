/**
 * Goal planner contract (v2 slice 2). Design: v2/PLANNER.md.
 *
 * The planner is PURE: (goals, WorldView) → Plan. No mineflayer, no I/O, so it
 * is unit-testable against minecraft-data alone. The job executor
 * (src/jobs/) turns Steps into skill calls and re-plans from a fresh WorldView
 * after failures. Item/block names are minecraft-data names without
 * "minecraft:" (e.g. "oak_log", "iron_pickaxe").
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** "End up holding at least `count` of `item`." */
export interface Goal {
  item: string;
  count: number;
}

/** Everything the planner may know. Built by the executor from the bot + world memory. */
export interface WorldView {
  /** Main inventory + hotbar + armor + offhand, item → total count. */
  inventory: Record<string, number>;
  gameMode: "survival" | "creative";
  /** Block types the bot can currently see / recently scanned, with distance to the nearest. */
  nearbyBlocks: Record<string, { count: number; nearest: number }>;
  /** Placed stations reachable without a long trip (≤32 blocks). */
  stations: { crafting_table: boolean; furnace: boolean };
  /** Known container contents from world memory (chests the bot has opened). */
  containers: Array<{ pos: Vec3; items: Record<string, number> }>;
  /** Remembered resource sightings beyond scan range (world model; may be empty). */
  sightings?: Record<string, { pos: Vec3; distance: number }>;
  position: Vec3;
  dimension: "overworld" | "the_nether" | "the_end";
  /**
   * Block types a gather has already failed to reach this job (the recovery
   * ladder feeds them back on re-plan). The planner treats them as not in view,
   * so recipe-variant choice and gather source choice prefer another species;
   * they are still used as a last resort when nothing else could supply the item.
   */
  avoidBlocks?: string[];
}

export type Step =
  /** Take items from a known container. */
  | { op: "withdraw"; item: string; count: number; from: Vec3 }
  /**
   * Mine blocks until the inventory gained `count` of `item`.
   * `blocks` = acceptable source blocks, nearest-first preference.
   * `tool` = minimum tool the blocks need (any same-kind tool of ≥ tier satisfies), null = hand ok.
   * `searchHint` set when no source is in view: where to look.
   */
  | {
      op: "gather";
      item: string;
      count: number;
      blocks: string[];
      tool: string | null;
      searchHint?: { kind: "surface" | "underground"; yRange?: [number, number] };
    }
  /** Craft until holding `count` more of `item` (`crafts` = number of recipe executions). */
  | { op: "craft"; item: string; count: number; crafts: number; table: boolean }
  /** Smelt `count` of `input` into `output` using `fuel` (fuelCount units of it). */
  | { op: "smelt"; input: string; output: string; count: number; fuel: string; fuelCount: number }
  /** Place a station from inventory near the work area (planner emits it when one is needed and none is nearby). */
  | { op: "place_station"; block: "crafting_table" | "furnace" };

export type StepOp = Step["op"];

export interface Plan {
  goals: Goal[];
  /** Ordered; executing them in order from `view` reaches the goals if nothing surprising happens. */
  steps: Step[];
  /** Raw materials the plan must gather/withdraw (for Haiku's summary and sanity checks). */
  rawNeeds: Record<string, number>;
  /** Goals or sub-goals with no known source. Non-empty ⇒ the plan is partial. */
  unresolved: Array<{ item: string; count: number; reason: string }>;
  /** One-line human summary, e.g. "gather 3 oak_log → craft 12 oak_planks → … (9 steps)". */
  summary: string;
}

/** Why a step failed. Drives the executor's recovery ladder and what Haiku is told. */
export type FailureKind =
  | "no_source" // nothing to gather/withdraw within search range
  | "unreachable" // source/station seen but no path
  | "missing_tool" // tool needed and not obtainable right now
  | "missing_input" // craft/smelt inputs absent (plan drifted)
  | "station_unavailable" // couldn't find or place a crafting table / furnace
  | "inventory_full"
  | "cancelled" // player stop / job replaced
  | "timeout"
  | "died"
  | "hostile" // aborted due to combat / danger
  | "unknown_item" // name not in minecraft-data
  | "not_obtainable" // planner has no source (e.g. needs trading / Nether, not supported yet)
  | "internal"; // bug / exception

export interface StepFailure {
  kind: FailureKind;
  step: Step;
  /** Short, specific, player-agnostic, e.g. "no iron_ore within 64 blocks; explored 3 areas". */
  detail: string;
  attempts: number;
  /** Block types the failed step could not reach (gather only); fed back to the planner as `WorldView.avoidBlocks`. */
  avoid?: string[];
}

export interface PlanOptions {
  /** Upper bound on emitted steps before giving up as too deep (default 200). */
  maxSteps?: number;
}

export type PlanFn = (goals: Goal[], view: WorldView, opts?: PlanOptions) => Plan;
