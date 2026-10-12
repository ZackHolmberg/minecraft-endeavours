/**
 * Pure follow-job logic (no bot, no I/O): the lost-sight / re-acquisition / stuck
 * state machine behind the `follow` job (src/jobs/steps/follow.ts drives it with
 * live observations). Design: v2/PLANNER.md "Follow job".
 *
 * While the player's entity is in view the job just keeps a dynamic follow goal.
 * When it disappears but the player is still online (walked out of render range,
 * teleported, chunk flicker) the tracker hands out search waypoints — the last
 * known position, then ahead along their last movement direction — and gives
 * up only after {@link FOLLOW_LOST_MS} with no re-acquisition, or when the
 * player left the server.
 */

export interface P3 {
  x: number;
  y: number;
  z: number;
}

/** Default distance kept to the followed player. */
export const FOLLOW_DEFAULT_DIST = 3;
export const FOLLOW_MAX_DIST = 16;
/** No cap beyond this: a follow that long ends as "done" so the player is told. */
export const FOLLOW_MAX_MS = 30 * 60_000;
/** Out of view this long (player still online) => the job fails. */
export const FOLLOW_LOST_MS = 45_000;
/** Ignore a lost entity for this long before leaving the follow goal (chunk-load flicker). */
export const FOLLOW_LOST_DEBOUNCE_MS = 1_000;
/** A player missing from the player list this long has left the server. */
export const FOLLOW_LEFT_GRACE_MS = 3_000;
/** Visible but not getting closer (no path / boxed in) for this long => the job fails as unreachable. */
export const FOLLOW_STUCK_MS = 40_000;
export const FOLLOW_STUCK_MIN_MOVE = 1.5;
/** "Close enough" slack beyond the follow distance before the bot counts as lagging behind. */
export const FOLLOW_NEAR_SLACK = 4;
/** Window of position samples the movement direction is read from. */
export const FOLLOW_DIR_WINDOW_MS = 3_000;
export const FOLLOW_MIN_DIR_LEN = 1.5;
/** How far ahead of the last position the extrapolated search waypoints sit. */
export const FOLLOW_AHEAD_BLOCKS = [8, 20] as const;

export interface Waypoint {
  pos: P3;
  /** True: the exact last-seen cell (height known). False: extrapolated along the walk direction (height unknown). */
  exact: boolean;
  label: string;
}

export interface Sample {
  t: number;
  pos: P3;
}

export interface FollowObs {
  now: number;
  /** The player is in the bot's player list (still on the server). */
  online: boolean;
  /** Their entity position when in view, else null. */
  target: P3 | null;
  /** The bot's own position. */
  self: P3;
}

export type FollowAction =
  | { kind: "follow"; reacquired: boolean }
  | { kind: "search"; waypoint: Waypoint; index: number }
  /** Nothing to do this tick: debounce, or every waypoint done and still waiting for them to show up. */
  | { kind: "wait"; why: "debounce" | "waiting" | "offline" }
  | { kind: "fail"; why: "left" | "lost" | "stuck"; reason: string };

const horiz = (a: P3, b: P3): number => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a: P3, b: P3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Unit horizontal direction the player was walking, from the samples in the last
 * {@link FOLLOW_DIR_WINDOW_MS} before the newest one; null when they were (nearly) standing still.
 */
export function movementDir(samples: readonly Sample[]): { x: number; z: number } | null {
  if (samples.length < 2) return null;
  const newest = samples[samples.length - 1]!;
  const oldest = samples.find((s) => newest.t - s.t <= FOLLOW_DIR_WINDOW_MS) ?? newest;
  const dx = newest.pos.x - oldest.pos.x;
  const dz = newest.pos.z - oldest.pos.z;
  const len = Math.hypot(dx, dz);
  if (len < FOLLOW_MIN_DIR_LEN) return null;
  return { x: dx / len, z: dz / len };
}

/** Where to look, in order: the last known position, then ahead along their last movement direction. */
export function searchWaypoints(last: P3, dir: { x: number; z: number } | null): Waypoint[] {
  const pts: Waypoint[] = [{ pos: { ...last }, exact: true, label: "where I last saw them" }];
  if (dir) {
    for (const n of FOLLOW_AHEAD_BLOCKS) {
      pts.push({ pos: { x: last.x + dir.x * n, y: last.y, z: last.z + dir.z * n }, exact: false, label: `${n} blocks further the way they were heading` });
    }
  }
  return pts;
}

export interface FollowTrackerOpts {
  dist?: number;
  lostMs?: number;
  leftGraceMs?: number;
  stuckMs?: number;
  debounceMs?: number;
}

export class FollowTracker {
  private readonly dist: number;
  private readonly lostMs: number;
  private readonly leftGraceMs: number;
  private readonly stuckMs: number;
  private readonly debounceMs: number;

  private samples: Sample[] = [];
  private lastSeen: P3 | null = null;
  private lostSince: number | null = null;
  private offlineSince: number | null = null;
  private waypoints: Waypoint[] = [];
  private index = 0;
  private anchor: P3 | null = null;
  private anchorAt = 0;
  private wasLost = false;

  constructor(opts: FollowTrackerOpts = {}) {
    this.dist = opts.dist ?? FOLLOW_DEFAULT_DIST;
    this.lostMs = opts.lostMs ?? FOLLOW_LOST_MS;
    this.leftGraceMs = opts.leftGraceMs ?? FOLLOW_LEFT_GRACE_MS;
    this.stuckMs = opts.stuckMs ?? FOLLOW_STUCK_MS;
    this.debounceMs = opts.debounceMs ?? FOLLOW_LOST_DEBOUNCE_MS;
  }

  /** True while the player is out of view (after the debounce). */
  get searching(): boolean {
    return this.wasLost;
  }

  lastKnown(): P3 | null {
    return this.lastSeen ? { ...this.lastSeen } : null;
  }

  /** Ms since the entity disappeared, 0 when in view. */
  lostForMs(now: number): number {
    return this.lostSince === null ? 0 : now - this.lostSince;
  }

  /** The current search leg ended (arrived, or no path): move on to the next waypoint. */
  waypointDone(): void {
    this.index += 1;
  }

  /**
   * Should a search walk in progress be abandoned right now? True once the player is back in view,
   * has left, or the search budget ran out; the next {@link step} then reports which.
   */
  interrupts(o: FollowObs): boolean {
    if (o.target) return true;
    if (!o.online) return true;
    return this.lostSince !== null && o.now - this.lostSince >= this.lostMs;
  }

  step(o: FollowObs): FollowAction {
    // Left the server (the entity of a player who logged out is gone with the list entry).
    if (!o.online) {
      this.offlineSince ??= o.now;
      if (o.now - this.offlineSince >= this.leftGraceMs) {
        return { kind: "fail", why: "left", reason: "the player left the server" };
      }
      return { kind: "wait", why: "offline" };
    }
    this.offlineSince = null;

    if (o.target) {
      const reacquired = this.lostSince !== null && this.wasLost;
      this.lostSince = null;
      this.wasLost = false;
      this.waypoints = [];
      this.index = 0;
      this.lastSeen = { ...o.target };
      this.samples.push({ t: o.now, pos: { ...o.target } });
      // keep a short window only
      while (this.samples.length > 2 && o.now - this.samples[0]!.t > 2 * FOLLOW_DIR_WINDOW_MS) this.samples.shift();

      // Not-getting-closer watchdog (no path to them / boxed in): reset on every re-acquisition.
      if (reacquired || this.anchor === null) {
        this.anchor = { ...o.self };
        this.anchorAt = o.now;
      }
      const near = dist3(o.self, o.target) <= this.dist + FOLLOW_NEAR_SLACK;
      if (near || dist3(o.self, this.anchor) >= FOLLOW_STUCK_MIN_MOVE) {
        this.anchor = { ...o.self };
        this.anchorAt = o.now;
      } else if (o.now - this.anchorAt >= this.stuckMs) {
        return {
          kind: "fail",
          why: "stuck",
          reason: `can't get to the player: ${Math.round(dist3(o.self, o.target))} blocks away and not getting closer for ${Math.round((o.now - this.anchorAt) / 1000)}s (no path?)`,
        };
      }
      return { kind: "follow", reacquired };
    }

    // Out of view, but still online.
    if (this.lostSince === null) {
      this.lostSince = o.now;
      this.anchor = null;
    }
    const lostFor = o.now - this.lostSince;
    if (lostFor >= this.lostMs) {
      const at = this.lastSeen ? ` Last seen near ${Math.round(this.lastSeen.x)}, ${Math.round(this.lastSeen.y)}, ${Math.round(this.lastSeen.z)}.` : "";
      return { kind: "fail", why: "lost", reason: `lost sight of the player and couldn't find them again in ${Math.round(this.lostMs / 1000)}s (still online, out of view range).${at}` };
    }
    if (lostFor < this.debounceMs) return { kind: "wait", why: "debounce" };
    if (!this.wasLost) {
      this.wasLost = true;
      this.waypoints = this.lastSeen ? searchWaypoints(this.lastSeen, movementDir(this.samples)) : [];
      this.index = 0;
    }
    const wp = this.waypoints[this.index];
    if (wp) return { kind: "search", waypoint: wp, index: this.index };
    return { kind: "wait", why: "waiting" };
  }
}

/** Text for the job's live `progress` line, from what the tracker says now. */
export function followProgress(player: string, a: FollowAction, lostForS: number): string {
  switch (a.kind) {
    case "search":
      return `lost sight of ${player} (${lostForS}s): heading to ${a.waypoint.label}`;
    case "wait":
      return a.why === "waiting" ? `lost sight of ${player} (${lostForS}s): waiting where I looked for them` : `following ${player}`;
    default:
      return `following ${player}`;
  }
}
