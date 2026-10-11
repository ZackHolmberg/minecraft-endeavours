/**
 * Per-bot durable world knowledge — the structured, programmatically-captured
 * memory half of the architecture's two-tier memory model. Stored as
 * `data/orchestrator/memory/<bot-username>/world.json`.
 *
 * Read by `observeSurroundings` to surface `knownStorage`, written by the
 * `remember` skill when a player names a location. Container snapshots,
 * utility-block POIs, and deaths are auto-captured by mineflayer event hooks
 * in `mineflayer-glue/event-hooks.ts`.
 *
 * Reads return `EMPTY` when the file doesn't exist yet, so callers never need
 * to special-case first-launch. Writes are atomic via tmp-then-rename to
 * avoid leaving a truncated JSON on crash.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BASE_DIR = "data/orchestrator/memory";

export interface Pos {
  x: number;
  y: number;
  z: number;
}

export interface POI {
  /** Free-form classification: `base`, `portal`, `bed`, `crafting_table`, etc. */
  type: string;
  /** Optional player-supplied name (e.g. "main base"). */
  name?: string;
  position: Pos;
  /** Unix ms when this was recorded. */
  timestamp: number;
  /** `auto` = captured from mineflayer event hook, `claude` = via `remember` skill. */
  source: "auto" | "claude";
}

export interface Container {
  /** `chest`, `barrel`, `shulker_box`, etc. */
  type: string;
  position: Pos;
  /** Absent on a seen-only entry (never opened). */
  last_opened?: number;
  last_opened_by?: string;
  contents?: Array<{ item: string; count: number }>;
  /** True when the bot only saw this container (proximity scan) and never opened it: no contents known. Cleared by the first open. */
  seen?: boolean;
  /** Unix ms of the last proximity scan that saw it (seen-only entries). */
  last_seen?: number;
}

export interface Death {
  position: Pos;
  cause: string;
  timestamp: number;
}

export interface WorldKnowledge {
  pois: POI[];
  containers: Container[];
  deaths: Death[];
}

const EMPTY: WorldKnowledge = { pois: [], containers: [], deaths: [] };

function fileFor(username: string): string {
  return resolve(process.cwd(), BASE_DIR, username, "world.json");
}

export async function readWorldKnowledge(username: string): Promise<WorldKnowledge> {
  const path = fileFor(username);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY);
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorldKnowledge>;
    return {
      pois: parsed.pois ?? [],
      containers: parsed.containers ?? [],
      deaths: parsed.deaths ?? [],
    };
  } catch (err) {
    // Set the bad file aside and start fresh rather than failing every
    // read/write forever (matches conversation-log / persist behavior).
    const message = err instanceof Error ? err.message : String(err);
    const aside = `${path}.corrupt-${Date.now()}`;
    console.warn(`world.json for ${username} is malformed (${message}); moved to ${aside}, starting fresh`);
    await rename(path, aside).catch(() => {});
    return structuredClone(EMPTY);
  }
}

/**
 * Per-bot write serialization. Every mutator below is read-modify-write on
 * the whole file, and several fire concurrently (the 5s utility scan, the
 * windowClose container snapshot, `remember`, death capture). Without a lock
 * two writers read the same base, the later rename wins, and the other's
 * update is silently lost — or both share the `.tmp` path and the second
 * rename throws ENOENT. Chaining mutations per username fixes both.
 */
const writeChains = new Map<string, Promise<unknown>>();

function withWorldLock<T>(username: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(username) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive regardless of this step's outcome.
  writeChains.set(username, next.catch(() => undefined));
  return next;
}

export async function writeWorldKnowledge(username: string, world: WorldKnowledge): Promise<void> {
  const target = fileFor(username);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(world, null, 2), "utf8");
  await rename(tmp, target);
}

export interface AddPoiInput {
  type: string;
  name?: string;
  position: Pos;
  source: POI["source"];
}

/**
 * Idempotent POI add. Returns `{ added: false }` if a POI with the same
 * `type` and `position` is already recorded — caller can surface this to
 * Claude as "already known" rather than treating it as a new fact.
 */
export async function addPoi(
  username: string,
  input: AddPoiInput,
): Promise<{ added: boolean; existing?: POI }> {
  const [result] = await addPois(username, [input]);
  return result!;
}

/**
 * Batch form of {@link addPoi}: one read + at most one write for the whole
 * list. Used by the utility-block proximity scan, which can see dozens of
 * blocks per tick and used to do a full read/write cycle per block.
 */
export async function addPois(
  username: string,
  inputs: AddPoiInput[],
): Promise<Array<{ added: boolean; existing?: POI }>> {
  return withWorldLock(username, async () => {
    const world = await readWorldKnowledge(username);
    const results: Array<{ added: boolean; existing?: POI }> = [];
    let dirty = false;
    for (const input of inputs) {
      const existing = world.pois.find(
        (p) =>
          p.type === input.type &&
          p.position.x === input.position.x &&
          p.position.y === input.position.y &&
          p.position.z === input.position.z,
      );
      if (existing) {
        results.push({ added: false, existing });
        continue;
      }
      const poi: POI = {
        type: input.type,
        position: input.position,
        timestamp: Date.now(),
        source: input.source,
      };
      if (input.name !== undefined) poi.name = input.name;
      world.pois.push(poi);
      dirty = true;
      results.push({ added: true });
    }
    if (dirty) await writeWorldKnowledge(username, world);
    return results;
  });
}

export interface UpsertContainerInput {
  type: string;
  position: Pos;
  contents: Array<{ item: string; count: number }>;
  openedBy: string;
}

/**
 * Capture a container snapshot. Idempotent on `position`: a second open of
 * the same chest overwrites contents + lastOpened + lastOpenedBy instead of
 * appending a duplicate. Called from the windowOpen/windowClose event hook
 * (any chest the bot opens) and from the deposit/withdraw skills.
 */
export async function upsertContainer(
  username: string,
  input: UpsertContainerInput,
): Promise<{ created: boolean }> {
  return withWorldLock(username, async () => {
    const world = await readWorldKnowledge(username);
    const idx = world.containers.findIndex(
      (c) =>
        c.position.x === input.position.x &&
        c.position.y === input.position.y &&
        c.position.z === input.position.z,
    );
    const record: Container = {
      type: input.type,
      position: input.position,
      last_opened: Date.now(),
      last_opened_by: input.openedBy,
      contents: input.contents,
    };
    if (idx >= 0) {
      world.containers[idx] = record;
    } else {
      world.containers.push(record);
    }
    await writeWorldKnowledge(username, world);
    return { created: idx < 0 };
  });
}

/** Seen-only containers kept on disk (oldest `last_seen` dropped first). */
const MAX_SEEN_CONTAINERS = 40;

export interface SeenContainerInput {
  type: string;
  position: Pos;
}

/**
 * Proximity-scan capture: remember containers the bot has SEEN (not opened) so a chest 30 blocks away is
 * still known after the bot walks off. Never overwrites an opened entry (that one has contents); skips
 * the other half of a double chest already recorded; refreshes `last_seen`. `shouldPrune` is asked about
 * every seen-only entry and returns true when the container is verifiably gone (broken), dropping it.
 * One read, at most one write. Returns the number of newly added entries.
 */
export async function syncSeenContainers(
  username: string,
  seen: SeenContainerInput[],
  shouldPrune: (c: Container) => boolean = () => false,
): Promise<number> {
  return withWorldLock(username, async () => {
    const world = await readWorldKnowledge(username);
    const now = Date.now();
    let dirty = false;
    let added = 0;
    const before = world.containers.length;
    world.containers = world.containers.filter((c) => !(c.seen && shouldPrune(c)));
    if (world.containers.length !== before) dirty = true;
    for (const input of seen) {
      const { x, y, z } = input.position;
      const same = world.containers.find((c) => c.position.x === x && c.position.y === y && c.position.z === z);
      if (same) {
        // refresh the timestamp at most once a minute (don't rewrite the file every 5s scan)
        if (same.seen && now - (same.last_seen ?? 0) > 60_000) {
          same.last_seen = now;
          dirty = true;
        }
        continue;
      }
      const isChest = input.type === "chest" || input.type === "trapped_chest";
      const half = isChest && world.containers.some((c) => c.type === input.type && c.position.y === y && Math.abs(c.position.x - x) + Math.abs(c.position.z - z) === 1);
      if (half) continue;
      world.containers.push({ type: input.type, position: { x, y, z }, seen: true, last_seen: now });
      added += 1;
      dirty = true;
    }
    const seenOnly = world.containers.filter((c) => c.seen);
    if (seenOnly.length > MAX_SEEN_CONTAINERS) {
      const drop = new Set(seenOnly.sort((a, b) => (a.last_seen ?? 0) - (b.last_seen ?? 0)).slice(0, seenOnly.length - MAX_SEEN_CONTAINERS));
      world.containers = world.containers.filter((c) => !drop.has(c));
      dirty = true;
    }
    if (dirty) await writeWorldKnowledge(username, world);
    return added;
  });
}

/** Most recent deaths kept on disk — older ones are noise for the agent. */
const MAX_DEATHS = 20;

/**
 * Append a death record (auto-captured by the `death` hook in
 * `mineflayer-glue/event-hooks.ts`). Trimmed to the newest {@link MAX_DEATHS}.
 */
export async function addDeath(username: string, death: Death): Promise<void> {
  await withWorldLock(username, async () => {
    const world = await readWorldKnowledge(username);
    world.deaths.push(death);
    if (world.deaths.length > MAX_DEATHS) world.deaths = world.deaths.slice(-MAX_DEATHS);
    await writeWorldKnowledge(username, world);
  });
}

/**
 * Block types whose locations are worth remembering as durable POIs because
 * Claude will want to walk back to them later — crafting, smelting, etc.
 * Surfaced by `observeSurroundings` as `knownUtilities` so the model can
 * plan trips back to a remembered table from deep in a mine.
 */
export const UTILITY_BLOCK_TYPES = new Set([
  "crafting_table",
  "furnace",
  "blast_furnace",
  "smoker",
  "smithing_table",
  "loom",
  "stonecutter",
  "anvil",
  "chipped_anvil",
  "damaged_anvil",
  "enchanting_table",
  "brewing_stand",
  "grindstone",
  "cartography_table",
  "fletching_table",
]);

export function isUtilityBlockType(name: string): boolean {
  if (UTILITY_BLOCK_TYPES.has(name)) return true;
  // Beds count as utility blocks for auto-capture and knownUtilities surfacing —
  // `sleepIn` needs to be able to walk back to a remembered bed.
  if (name.endsWith("_bed")) return true;
  return false;
}
