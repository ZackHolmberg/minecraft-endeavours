/**
 * Door / fence-gate traversal for mineflayer-pathfinder.
 *
 * Why we don't use pathfinder's own `canOpenDoors`: in 2.4.5 it is broken in
 * three independent ways (see node_modules/mineflayer-pathfinder):
 *  - `movements.openable` only ever contains *fence gates* — doors are never
 *    added, so the flag does nothing for the case that matters.
 *  - Only the feet-level block of a cardinal move is checked; the upper half
 *    of a door still goes through `safeOrBreak`, i.e. "dig it or no path".
 *  - The executor's `useOne` branch never resets its `placing` flag, so after
 *    opening a gate the next tick dereferences an undefined placement and
 *    throws inside the physics tick.
 * And because doors / gates have `boundingBox: "block"` for every state, the
 * planner treats them (even *open* ones) as solid walls. With `canDig=false`
 * that makes every enclosed building unreachable → the LLM falls back to
 * `mineBlock` on the wall, which is the "breaks through walls" bug.
 *
 * Our approach splits planning from execution:
 *  - **Planning** (`patchMovementsForDoors`): wooden/copper doors and fence
 *    gates are reported to the A* search as walk-through air for *cardinal*
 *    moves only. Diagonal and parkour moves see them as walls, so the bot
 *    always walks squarely through a doorway.
 *  - **Execution** (`installDoorAssist`): on every `path_update` the path's
 *    door nodes are repaired (see below), then a physicsTick watcher looks at
 *    the next few *path nodes* (not the bot's yaw); if one is a door/gate whose
 *    live collision shape blocks the move into it (open/closed/hinge/facing
 *    all fall out of the shape) and the bot is within {@link DOOR_REACH}, it
 *    right-clicks it and waits for the block state to flip. Doors the bot
 *    opened from closed are closed again once the bot is >=2 blocks past them
 *    and no other player is standing nearby.
 *
 * Why the path repair exists (v2 regression, t2.door_house / t2.door_exit):
 * pathfinder's `postProcessPath` rewrites every node to "the top of whatever
 * block it is in" via `getPositionOnTopOf`. A door cell is a block with a 1-high
 * collision shape, so its node becomes (x + leafOffset, y + 1, z + 0.5): one
 * block too high. The executor only counts a node as reached when |dy| < 1, so
 * the bot pushed at the door forever ("stuck N blocks from target"), and the
 * old assist, which matched on the exact integer door coordinates, never saw
 * the door on the path. {@link normalizeDoorNodes} snaps those nodes back to the
 * cell centre at feet level.
 *
 * Iron doors are deliberately excluded (need redstone); trapdoors too — a
 * closed trapdoor is a floor/ceiling, not a doorway, and treating it as air
 * would break "can I stand here" for the whole search.
 */

import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { recordEvent } from "../observability/telemetry.js";

/** Door-like block names the bot may open by hand. Iron door needs redstone. */
export function isHandOpenable(name: string): boolean {
  return (name.endsWith("_door") && name !== "iron_door") || name.endsWith("_fence_gate");
}

/** Block ids for {@link isHandOpenable}, cached per registry. */
const idCache = new WeakMap<object, Set<number>>();
export function handOpenableIds(bot: Bot): Set<number> {
  const reg = bot.registry as unknown as object;
  let ids = idCache.get(reg);
  if (!ids) {
    ids = new Set(bot.registry.blocksArray.filter((b) => isHandOpenable(b.name)).map((b) => b.id));
    idCache.set(reg, ids);
  }
  return ids;
}

// Minimal shape of the pathfinder internals we patch. `getBlock` /
// `getMoveDiagonal` / `getMoveParkourForward` aren't in the .d.ts.
interface PatchableMovements {
  getBlock(pos: unknown, dx: number, dy: number, dz: number): {
    type?: number;
    safe: boolean;
    physical: boolean;
    replaceable: boolean;
  };
  getMoveDiagonal(node: unknown, dir: unknown, neighbors: unknown[]): void;
  getMoveParkourForward(node: unknown, dir: unknown, neighbors: unknown[]): void;
}

/**
 * Make door / gate cells passable for cardinal A* moves. Mutates `m`.
 */
export function patchMovementsForDoors(bot: Bot, m: object): void {
  const pm = m as unknown as PatchableMovements;
  const ids = handOpenableIds(bot);
  // While true, doors keep pathfinder's default (wall) semantics. Flipped on
  // around diagonal + parkour evaluation so those moves never cut through a
  // doorway at an angle or mid-jump.
  let strict = false;

  const baseGetBlock = pm.getBlock.bind(pm);
  pm.getBlock = (pos, dx, dy, dz) => {
    const b = baseGetBlock(pos, dx, dy, dz);
    if (!strict && b.type !== undefined && ids.has(b.type)) {
      b.safe = true; // walkable through (the executor opens it on approach)
      b.physical = false; // never stand *on* a door / gate
      b.replaceable = false; // never "place scaffolding" into it
    }
    return b;
  };

  const wrapStrict = (fn: (node: unknown, dir: unknown, neighbors: unknown[]) => void) =>
    (node: unknown, dir: unknown, neighbors: unknown[]) => {
      strict = true;
      try {
        fn(node, dir, neighbors);
      } finally {
        strict = false;
      }
    };
  pm.getMoveDiagonal = wrapStrict(pm.getMoveDiagonal.bind(pm));
  pm.getMoveParkourForward = wrapStrict(pm.getMoveParkourForward.bind(pm));
}

// ---------------------------------------------------------------------------
// Path analysis (pure: takes a blockAt function, unit-testable without a bot)
// ---------------------------------------------------------------------------

/** Structural subset of prismarine-block's Block that the door logic needs. */
export interface DoorBlockLike {
  name: string;
  position: Vec3;
  shapes: number[][];
  getProperties(): Record<string, unknown>;
}
export type BlockAtFn = (p: Vec3) => DoorBlockLike | null;
export interface PathNodeLike {
  x: number;
  y: number;
  z: number;
}

/** Open doors from this far (horizontal, to the door cell centre). activateBlock reach is 4.5; this keeps us "at" the door. */
export const DOOR_REACH = 2.0;
/** How many upcoming path nodes are inspected for a door. */
export const LOOKAHEAD_NODES = 3;
// Bot hitbox spans center +/- 0.3; a shape blocks travel along an axis if it
// overlaps that band on the perpendicular horizontal axis.
const HITBOX_LO = 0.2;
const HITBOX_HI = 0.8;

/**
 * Door/gate at `cell`, normalised to the lower half for doors (both halves
 * toggle together, and path nodes are feet-level). Null if not hand-openable.
 */
export function doorAt(blockAt: BlockAtFn, cell: Vec3): DoorBlockLike | null {
  const b = blockAt(cell);
  if (!b || !isHandOpenable(b.name)) return null;
  if (b.name.endsWith("_door") && b.getProperties().half === "upper") {
    const below = blockAt(cell.offset(0, -1, 0));
    return below && below.name === b.name ? below : null;
  }
  return b;
}

/**
 * The door/gate (lower half) a path node belongs to, or null. Looks at the
 * node's own column at `floor(y)` and one below, which covers both the
 * original feet-level node and the pathfinder-mutated "top of the door" one
 * (y+1 for doors, y+1.5 for closed gates).
 */
export function doorCellForNode(node: PathNodeLike, blockAt: BlockAtFn): DoorBlockLike | null {
  const cx = Math.floor(node.x);
  const cz = Math.floor(node.z);
  const fy = Math.floor(node.y + 1e-6);
  for (const dy of [0, -1]) {
    const d = doorAt(blockAt, new Vec3(cx, fy + dy, cz));
    if (d) return d;
  }
  return null;
}

/**
 * Snap every door node of `path` back to the door cell centre at feet level
 * (mutates in place; the executor holds the same array). Returns how many
 * nodes were repaired.
 */
export function normalizeDoorNodes(path: PathNodeLike[], blockAt: BlockAtFn): number {
  let n = 0;
  for (const node of path) {
    const d = doorCellForNode(node, blockAt);
    if (!d) continue;
    const x = d.position.x + 0.5;
    const z = d.position.z + 0.5;
    if (node.x !== x || node.y !== d.position.y || node.z !== z) {
      node.x = x;
      node.y = d.position.y;
      node.z = z;
      n++;
    }
  }
  return n;
}

/** Does the block's current collision shape block walking along `axis`? */
export function blocksTravel(block: DoorBlockLike, axis: "x" | "z"): boolean {
  for (const s of block.shapes) {
    // shape = [minX, minY, minZ, maxX, maxY, maxZ] in block-local coords
    const lo = axis === "x" ? s[2]! : s[0]!;
    const hi = axis === "x" ? s[5]! : s[3]!;
    if (lo < HITBOX_HI && hi > HITBOX_LO) return true;
  }
  return false;
}

export interface DoorAhead {
  door: DoorBlockLike;
  axis: "x" | "z";
  /** Horizontal distance from the bot to the door cell centre. */
  dist: number;
  /** Index into the inspected path slice. */
  nodeIndex: number;
}

/**
 * First door/gate among the next {@link LOOKAHEAD_NODES} remaining path nodes
 * that (a) is within `reach` of the bot and (b) physically blocks the move
 * into it. Direction comes from the path (previous node -> door node), never
 * from the bot's yaw.
 */
export function findDoorAhead(pos: PathNodeLike, path: ReadonlyArray<PathNodeLike>, blockAt: BlockAtFn, reach = DOOR_REACH): DoorAhead | null {
  const n = Math.min(path.length, LOOKAHEAD_NODES);
  for (let i = 0; i < n; i++) {
    const node = path[i]!;
    const door = doorCellForNode(node, blockAt);
    if (!door) continue;
    const dist = Math.hypot(pos.x - (door.position.x + 0.5), pos.z - (door.position.z + 0.5));
    if (dist > reach || Math.abs(pos.y - door.position.y) > 2) continue;
    const from = i > 0 ? path[i - 1]! : pos;
    let dx = node.x - from.x;
    let dz = node.z - from.z;
    if (Math.hypot(dx, dz) < 0.25) {
      // Bot is standing in the door cell: use the way out instead.
      const next = path[i + 1];
      if (!next) continue;
      dx = next.x - node.x;
      dz = next.z - node.z;
    }
    const axis: "x" | "z" = Math.abs(dx) >= Math.abs(dz) ? "x" : "z";
    if (!blocksTravel(door, axis)) continue;
    return { door, axis, dist, nodeIndex: i };
  }
  return null;
}

/** Is `door` (lower half) the cell of one of the next few remaining nodes? */
export function pathUsesDoor(path: ReadonlyArray<PathNodeLike>, door: { x: number; y: number; z: number }): boolean {
  const n = Math.min(path.length, LOOKAHEAD_NODES + 1);
  for (let i = 0; i < n; i++) {
    const p = path[i]!;
    if (Math.floor(p.x) === door.x && Math.floor(p.z) === door.z && Math.abs(p.y - door.y) < 1.6) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Execution-side assist
// ---------------------------------------------------------------------------

const PER_DOOR_COOLDOWN_MS = 1_000;
const STATE_WAIT_MS = 1_200; // how long to wait for the server to flip the door
const MAX_ATTEMPTS = 3; // consecutive no-change toggles before we stop poking a door
const CLOSE_BEHIND_DIST = 2.0; // horizontal blocks past the door before we close it
const CLOSE_GIVE_UP_DIST = 4.0; // beyond activation reach comfortably - just leave it
const CLOSE_GIVE_UP_MS = 20_000;
const PLAYER_NEARBY_DIST = 2.5; // someone right at the door -> leave it open for them

interface OpenedDoor {
  pos: Vec3;
  openedAt: number;
}

const installed = new WeakSet<Bot>();

/**
 * Attach the door watcher to `bot` (idempotent). Cheap: when the bot isn't
 * pathing and has no doors to close, the tick handler is a couple of
 * property reads. Log tags: `[door] open|close at x,y,z`, `[door] path`,
 * `[door] FAILED`.
 */
export function installDoorAssist(bot: Bot): void {
  if (installed.has(bot)) return;
  installed.add(bot);

  const blockAt: BlockAtFn = (p) => bot.blockAt(p);
  // The executor's own array (shifted as nodes are reached), captured from path_update.
  let livePath: PathNodeLike[] = [];
  const opened = new Map<string, OpenedDoor>();
  const lastToggle = new Map<string, number>();
  const attempts = new Map<string, number>();
  let busy = false;

  bot.on("path_update", (results) => {
    livePath = results.path as unknown as PathNodeLike[];
    const fixed = normalizeDoorNodes(livePath, blockAt);
    if (fixed > 0) console.log(`[${bot.username}] [door] path: repaired ${fixed} door node(s) (pathfinder lifts them onto the door top)`);
  });
  const clearPath = (): void => {
    livePath = [];
  };
  bot.on("goal_updated", clearPath);
  bot.on("path_reset", clearPath);
  bot.on("path_stop", clearPath);

  const toggle = async (block: DoorBlockLike, rememberToClose: boolean): Promise<void> => {
    const p = block.position.clone();
    const k = key(p.x, p.y, p.z);
    busy = true;
    lastToggle.set(k, Date.now());
    const wasOpen = block.getProperties().open === true;
    const action = wasOpen ? "close" : "open";
    try {
      await bot.activateBlock(block as Block);
      const deadline = Date.now() + STATE_WAIT_MS;
      let changed = false;
      while (Date.now() < deadline) {
        const now = bot.blockAt(p);
        if (now && (now.getProperties().open === true) !== wasOpen) {
          changed = true;
          break;
        }
        await sleep(50);
      }
      if (changed) {
        attempts.delete(k);
        console.log(`[${bot.username}] [door] ${action} at ${p.x},${p.y},${p.z} (${block.name})`);
        if (rememberToClose && !wasOpen) opened.set(k, { pos: p, openedAt: Date.now() });
        recordEvent(bot.username, { kind: "door", action, block: block.name, pos: { x: p.x, y: p.y, z: p.z } });
      } else {
        const n = (attempts.get(k) ?? 0) + 1;
        attempts.set(k, n);
        console.warn(`[${bot.username}] [door] ${action} FAILED at ${p.x},${p.y},${p.z} (${block.name}): no state change after ${STATE_WAIT_MS}ms (attempt ${n}/${MAX_ATTEMPTS})`);
      }
    } catch (err) {
      attempts.set(key(p.x, p.y, p.z), (attempts.get(k) ?? 0) + 1);
      console.warn(`[${bot.username}] [door] ${action} FAILED at ${p.x},${p.y},${p.z}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  };

  bot.on("physicsTick", () => {
    if (busy || !bot.entity) return;
    const pos = bot.entity.position;
    const pf = (bot as Bot & { pathfinder?: { isMoving(): boolean } }).pathfinder;
    const moving = !!pf?.isMoving();

    // 1) Open whatever door/gate on the upcoming path is in the way.
    if (moving && livePath.length > 0) {
      const ahead = findDoorAhead(pos, livePath, blockAt);
      if (ahead) {
        const dp = ahead.door.position;
        const dk = key(dp.x, dp.y, dp.z);
        if (Date.now() - (lastToggle.get(dk) ?? 0) >= PER_DOOR_COOLDOWN_MS && (attempts.get(dk) ?? 0) < MAX_ATTEMPTS) {
          void toggle(ahead.door, true);
          return;
        }
      }
    }

    // 2) Close doors we opened once we're clear of them.
    for (const [dk, entry] of opened) {
      const dx = pos.x - (entry.pos.x + 0.5);
      const dz = pos.z - (entry.pos.z + 0.5);
      const horiz = Math.sqrt(dx * dx + dz * dz);
      if (horiz > CLOSE_GIVE_UP_DIST || Date.now() - entry.openedAt > CLOSE_GIVE_UP_MS) {
        opened.delete(dk);
        continue;
      }
      if (horiz < CLOSE_BEHIND_DIST) continue;
      const door = doorAt(blockAt, entry.pos);
      if (!door || door.getProperties().open !== true) {
        opened.delete(dk); // already shut (by someone else) or gone
        continue;
      }
      if (moving && pathUsesDoor(livePath, entry.pos)) continue; // still about to walk back through
      if (someoneNear(bot, entry.pos)) continue;
      opened.delete(dk);
      void toggle(door, false);
      return;
    }
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function someoneNear(bot: Bot, doorPos: Vec3): boolean {
  const center = doorPos.offset(0.5, 0, 0.5);
  for (const name of Object.keys(bot.players)) {
    if (name === bot.username) continue;
    const e = bot.players[name]?.entity;
    if (e && e.position.distanceTo(center) < PLAYER_NEARBY_DIST) return true;
  }
  return false;
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}
