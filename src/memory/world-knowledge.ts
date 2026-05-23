/**
 * Per-bot durable world knowledge — the structured, programmatically-captured
 * memory half of the architecture's two-tier memory model. Stored as
 * `data/orchestrator/memory/<bot-username>/world.json`.
 *
 * Read by `observeSurroundings` to surface `knownStorage`, written by the
 * `remember` skill when a player names a location. Container snapshots and
 * automatic POI/death capture are deferred — wire them via mineflayer events
 * in a later phase. The file shape is forward-compatible with those additions.
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
  last_opened: number;
  last_opened_by: string;
  contents?: Array<{ item: string; count: number }>;
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
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`world.json for ${username} is malformed: ${message}`);
  }
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
  const world = await readWorldKnowledge(username);
  const existing = world.pois.find(
    (p) =>
      p.type === input.type &&
      p.position.x === input.position.x &&
      p.position.y === input.position.y &&
      p.position.z === input.position.z,
  );
  if (existing) return { added: false, existing };

  const poi: POI = {
    type: input.type,
    position: input.position,
    timestamp: Date.now(),
    source: input.source,
  };
  if (input.name !== undefined) poi.name = input.name;
  world.pois.push(poi);
  await writeWorldKnowledge(username, world);
  return { added: true };
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
  return UTILITY_BLOCK_TYPES.has(name);
}
