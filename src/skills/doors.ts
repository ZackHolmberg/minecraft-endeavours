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
 *  - **Execution** (`installDoorAssist`): a physicsTick watcher looks up to
 *    two cells ahead along the travel direction; if a door/gate on the
 *    current path physically blocks that direction (computed from the live
 *    collision shape, so open/closed/hinge/facing all fall out naturally) it
 *    right-clicks it. Doors the bot opened from closed are closed again once
 *    the bot is ≥2 blocks past them and no other player is standing nearby.
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
// Execution-side assist
// ---------------------------------------------------------------------------

const LOOKAHEAD_STEPS = [0, 1, 2] as const;
const PER_DOOR_COOLDOWN_MS = 1_000;
const CLOSE_BEHIND_DIST = 2.0; // horizontal blocks past the door before we close it
const CLOSE_GIVE_UP_DIST = 4.0; // beyond activation reach comfortably — just leave it
const CLOSE_GIVE_UP_MS = 20_000;
const PLAYER_NEARBY_DIST = 2.5; // someone right at the door → leave it open for them
// Bot hitbox spans center ± 0.3; a shape blocks travel along an axis if it
// overlaps that band on the perpendicular horizontal axis.
const HITBOX_LO = 0.2;
const HITBOX_HI = 0.8;

interface OpenedDoor {
  pos: Vec3;
  openedAt: number;
}

const installed = new WeakSet<Bot>();

/**
 * Attach the door watcher to `bot` (idempotent). Cheap: when the bot isn't
 * pathing and has no doors to close, the tick handler is a couple of
 * property reads.
 */
export function installDoorAssist(bot: Bot): void {
  if (installed.has(bot)) return;
  installed.add(bot);

  const pathKeys = new Set<string>();
  const opened = new Map<string, OpenedDoor>();
  const lastToggle = new Map<string, number>();
  let busy = false;

  bot.on("path_update", (results) => {
    pathKeys.clear();
    for (const n of results.path) pathKeys.add(key(n.x, n.y, n.z));
  });
  bot.on("goal_updated", () => pathKeys.clear());

  const toggle = (block: Block, k: string, rememberToClose: boolean): void => {
    busy = true;
    lastToggle.set(k, Date.now());
    const wasClosed = block.getProperties().open === false;
    bot
      .activateBlock(block)
      .then(() => {
        if (rememberToClose && wasClosed) opened.set(k, { pos: block.position.clone(), openedAt: Date.now() });
        const p = block.position;
        recordEvent(bot.username, {
          kind: "door",
          action: wasClosed ? "open" : "close",
          block: block.name,
          pos: { x: p.x, y: p.y, z: p.z },
        });
      })
      .catch((err: unknown) => {
        console.warn(`[${bot.username}] door toggle failed at ${k}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        busy = false;
      });
  };

  bot.on("physicsTick", () => {
    if (busy || !bot.entity) return;
    const pos = bot.entity.position;

    // 1) Open whatever door/gate on the path is in the way.
    const pf = (bot as Bot & { pathfinder?: { isMoving(): boolean } }).pathfinder;
    if (pf?.isMoving() && pathKeys.size > 0) {
      const yaw = bot.entity.yaw;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const axis: "x" | "z" = Math.abs(fx) >= Math.abs(fz) ? "x" : "z";
      const major = axis === "x" ? fx : fz;
      if (Math.abs(major) >= 0.7) {
        const step = new Vec3(axis === "x" ? Math.sign(fx) : 0, 0, axis === "z" ? Math.sign(fz) : 0);
        for (const k of LOOKAHEAD_STEPS) {
          for (const dy of [0, 1]) {
            const cell = pos.plus(step.scaled(k)).offset(0, dy, 0).floored();
            const door = doorAt(bot, cell);
            if (!door) continue;
            const dk = key(door.position.x, door.position.y, door.position.z);
            if (!pathKeys.has(dk)) continue;
            if (!blocksTravel(door, axis)) continue;
            if (Date.now() - (lastToggle.get(dk) ?? 0) < PER_DOOR_COOLDOWN_MS) continue;
            toggle(door, dk, true);
            return;
          }
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
      const door = doorAt(bot, entry.pos);
      if (!door || door.getProperties().open !== true) {
        opened.delete(dk); // already shut (by someone else) or gone
        continue;
      }
      if (pathKeys.has(dk) && pf?.isMoving()) continue; // still about to walk back through
      if (someoneNear(bot, entry.pos)) continue;
      opened.delete(dk);
      toggle(door, dk, false);
      return;
    }
  });
}

/**
 * Door/gate at `cell`, normalised to the lower half for doors (both halves
 * toggle together, and path nodes are feet-level). Null if not hand-openable.
 */
function doorAt(bot: Bot, cell: Vec3): Block | null {
  const b = bot.blockAt(cell);
  if (!b || !isHandOpenable(b.name)) return null;
  if (b.name.endsWith("_door") && b.getProperties().half === "upper") {
    const below = bot.blockAt(cell.offset(0, -1, 0));
    return below && below.name === b.name ? below : null;
  }
  return b;
}

/** Does the block's current collision shape block walking along `axis`? */
function blocksTravel(block: Block, axis: "x" | "z"): boolean {
  for (const s of block.shapes) {
    // shape = [minX, minY, minZ, maxX, maxY, maxZ] in block-local coords
    const lo = axis === "x" ? s[2]! : s[0]!;
    const hi = axis === "x" ? s[5]! : s[3]!;
    if (lo < HITBOX_HI && hi > HITBOX_LO) return true;
  }
  return false;
}

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
