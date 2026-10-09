import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { isUtilityBlockType, readWorldKnowledge } from "../memory/world-knowledge.js";
import { getBotState } from "../state/index.js";
import { currentGameMode, type GameMode } from "./game-mode.js";
import type { SkillResult } from "./types.js";

const DEFAULT_RADIUS = 16;
const MAX_BLOCK_GROUPS = 15;
const MAX_ENTITIES = 10;
const MAX_DROPPED_ITEMS = 10;
const FIND_BLOCK_LIMIT = 256;

export interface ObserveSurroundingsParams {
  radius?: number;
}

export interface ObserveSurroundings extends SkillResult {
  ok: true;
  state: ObserveSurroundingsState;
}

export interface ObserveSurroundingsState {
  /** Live game mode — creative changes the rules (getItems, no drops, flight). */
  gameMode: GameMode;
  position: { x: number; y: number; z: number };
  dimension: string;
  facing: string;
  time: { timeOfDay: number; phase: "day" | "night" | "dusk" | "dawn" };
  weather: "clear" | "rain" | "thunder";
  status: {
    health: number;
    food: number;
    saturation: number;
    experience: number;
    isInWater: boolean;
    isOnFire: boolean;
  };
  heldItem: { name: string; count: number } | null;
  nearbyBlocks: Array<{
    type: string;
    count: number;
    nearest: { x: number; y: number; z: number; dist: number };
  }>;
  nearbyEntities: Array<{
    type: "player" | "hostile" | "passive" | "vehicle" | "object" | "other";
    name: string;
    pos: { x: number; y: number; z: number };
    dist: number;
    lookingAt?: boolean;
  }>;
  nearbyDroppedItems: Array<{ item: string; count: number; dist: number }>;
  knownStorage: Array<{
    type: string;
    pos: { x: number; y: number; z: number };
    dist: number;
    lastOpened?: number;
    lastOpenedBy?: string;
    contents?: Array<{ item: string; count: number }>;
  }>;
  knownUtilities: Array<{
    type: string;
    pos: { x: number; y: number; z: number };
    dist: number;
    name?: string;
  }>;
  /**
   * Named waypoints the bot has `remember`-ed that aren't utility blocks —
   * mine entrances, named bases, portals, the surface above a deep cave, etc.
   * Separate from `knownUtilities` because no skill auto-walks to these; they
   * exist purely as navigation references for the agent to pass to `goTo`.
   */
  knownWaypoints: Array<{
    type: string;
    pos: { x: number; y: number; z: number };
    dist: number;
    name?: string;
  }>;
  recentActions: string[];
  /** Most recent death (auto-captured), so "go get my stuff" has a target. */
  lastDeath: { pos: { x: number; y: number; z: number }; cause: string; minutesAgo: number } | null;
  recentlySeenPlayers: Array<{ name: string; lastSeen: number; lastPos: { x: number; y: number; z: number } | null }>;
  currentTask: string | null;
  remainingTasks: string[];
}

export async function observeSurroundings(
  bot: Bot,
  { radius = DEFAULT_RADIUS }: ObserveSurroundingsParams = {},
): Promise<ObserveSurroundings> {
  const me = bot.entity.position;
  const noteworthyIds = collectNoteworthyBlockIds(bot);

  const positions = bot.findBlocks({
    point: me,
    matching: noteworthyIds,
    maxDistance: radius,
    count: FIND_BLOCK_LIMIT,
  });

  const groups = new Map<string, { count: number; nearest: { pos: { x: number; y: number; z: number }; dist: number } }>();
  for (const p of positions) {
    const block = bot.blockAt(p);
    if (!block) continue;
    const dist = me.distanceTo(p);
    const existing = groups.get(block.name);
    if (!existing) {
      groups.set(block.name, {
        count: 1,
        nearest: { pos: { x: p.x, y: p.y, z: p.z }, dist },
      });
    } else {
      existing.count += 1;
      if (dist < existing.nearest.dist) {
        existing.nearest = { pos: { x: p.x, y: p.y, z: p.z }, dist };
      }
    }
  }

  const nearbyBlocks = [...groups.entries()]
    .map(([type, g]) => ({
      type,
      count: g.count,
      nearest: { x: g.nearest.pos.x, y: g.nearest.pos.y, z: g.nearest.pos.z, dist: round2(g.nearest.dist) },
    }))
    .sort((a, b) => a.nearest.dist - b.nearest.dist)
    .slice(0, MAX_BLOCK_GROUPS);

  const nearbyEntities = collectEntities(bot, radius);
  const nearbyDroppedItems = collectDroppedItems(bot, radius);

  const held = bot.heldItem;
  const heldItem = held ? { name: held.name, count: held.count } : null;

  const botState = getBotState(bot.username);
  const world = await readWorldKnowledge(bot.username);
  const knownStorage = world.containers
    .map((c) => {
      const d = me.distanceTo(new Vec3(c.position.x, c.position.y, c.position.z));
      const entry: ObserveSurroundingsState["knownStorage"][number] = {
        type: c.type,
        pos: c.position,
        dist: round2(d),
      };
      if (c.last_opened !== undefined) entry.lastOpened = c.last_opened;
      if (c.last_opened_by !== undefined) entry.lastOpenedBy = c.last_opened_by;
      if (c.contents !== undefined) entry.contents = c.contents;
      return entry;
    })
    .sort((a, b) => a.dist - b.dist);

  const knownUtilities = world.pois
    .filter((p) => isUtilityBlockType(p.type))
    .map((p) => {
      const d = me.distanceTo(new Vec3(p.position.x, p.position.y, p.position.z));
      const entry: ObserveSurroundingsState["knownUtilities"][number] = {
        type: p.type,
        pos: p.position,
        dist: round2(d),
      };
      if (p.name !== undefined) entry.name = p.name;
      return entry;
    })
    .sort((a, b) => a.dist - b.dist);

  const knownWaypoints = world.pois
    .filter((p) => !isUtilityBlockType(p.type))
    .map((p) => {
      const d = me.distanceTo(new Vec3(p.position.x, p.position.y, p.position.z));
      const entry: ObserveSurroundingsState["knownWaypoints"][number] = {
        type: p.type,
        pos: p.position,
        dist: round2(d),
      };
      if (p.name !== undefined) entry.name = p.name;
      return entry;
    })
    .sort((a, b) => a.dist - b.dist);

  return {
    ok: true,
    message: `${nearbyBlocks.length} block group(s), ${nearbyEntities.length} entit(ies) within ${radius} blocks`,
    state: {
      gameMode: currentGameMode(bot),
      position: { x: round2(me.x), y: round2(me.y), z: round2(me.z) },
      dimension: bot.game.dimension,
      facing: yawToCardinal(bot.entity.yaw),
      time: { timeOfDay: bot.time.timeOfDay, phase: timePhase(bot.time.timeOfDay) },
      weather: weather(bot),
      status: {
        health: round2(bot.health),
        food: bot.food,
        saturation: round2(bot.foodSaturation),
        experience: bot.experience.level,
        isInWater: (bot.entity as Entity & { isInWater?: boolean }).isInWater ?? false,
        isOnFire: (bot.entity as Entity & { onFire?: boolean }).onFire ?? false,
      },
      heldItem,
      nearbyBlocks,
      nearbyEntities,
      nearbyDroppedItems,
      knownStorage,
      knownUtilities,
      knownWaypoints,
      recentActions: botState?.actions.recent() ?? [],
      lastDeath: summarizeLastDeath(world.deaths),
      recentlySeenPlayers: botState?.presence.recentlySeen() ?? [],
      currentTask: botState?.tasks.current() ?? null,
      remainingTasks: botState?.tasks.remaining() ?? [],
    },
  };
}

function summarizeLastDeath(
  deaths: Array<{ position: { x: number; y: number; z: number }; cause: string; timestamp: number }>,
): ObserveSurroundingsState["lastDeath"] {
  const d = deaths[deaths.length - 1];
  if (!d) return null;
  return { pos: d.position, cause: d.cause, minutesAgo: Math.round((Date.now() - d.timestamp) / 60_000) };
}

function collectNoteworthyBlockIds(bot: Bot): number[] {
  const ids: number[] = [];
  for (const block of bot.registry.blocksArray) {
    if (isNoteworthy(block.name)) ids.push(block.id);
  }
  return ids;
}

function isNoteworthy(name: string): boolean {
  if (name.endsWith("_log") || name.endsWith("_wood")) return true;
  if (name.endsWith("_ore")) return true;
  if (name.endsWith("_bed")) return true;
  if (name.endsWith("_door") || name.endsWith("_trapdoor")) return true;
  if (name === "water" || name === "lava") return true;
  if (name === "crafting_table" || name === "furnace" || name === "blast_furnace" || name === "smoker" || name === "smithing_table" || name === "loom" || name === "stonecutter" || name === "anvil") return true;
  if (name === "chest" || name === "trapped_chest" || name === "ender_chest" || name === "barrel" || name.endsWith("_shulker_box") || name === "shulker_box") return true;
  if (name.includes("portal")) return true;
  if (name === "spawner" || name === "respawn_anchor" || name === "lodestone" || name === "beacon") return true;
  return false;
}

function collectEntities(bot: Bot, radius: number): ObserveSurroundingsState["nearbyEntities"] {
  const me = bot.entity.position;
  const all: ObserveSurroundingsState["nearbyEntities"] = [];
  const myId = bot.entity.id;

  for (const id of Object.keys(bot.entities)) {
    const entity = bot.entities[id];
    if (!entity || entity.id === myId) continue;
    const dist = me.distanceTo(entity.position);
    if (dist > radius) continue;
    if (entity.name === "item" || entity.name === "item_stack") continue;

    const type = classifyEntity(entity);
    if (type === null) continue; // pure noise — arrows, xp orbs, area effects, etc.

    const displayName = entity.username ?? entity.name ?? entity.displayName ?? "unknown";
    all.push({
      type,
      name: displayName,
      pos: { x: round2(entity.position.x), y: round2(entity.position.y), z: round2(entity.position.z) },
      dist: round2(dist),
    });
  }

  const priority: Record<ObserveSurroundingsState["nearbyEntities"][number]["type"], number> = {
    player: 0,
    hostile: 1,
    passive: 2,
    vehicle: 3,
    object: 4,
    other: 5,
  };
  all.sort((a, b) => {
    const p = priority[a.type] - priority[b.type];
    return p !== 0 ? p : a.dist - b.dist;
  });
  return all.slice(0, MAX_ENTITIES);
}

/**
 * Pure-noise entity names we never surface — projectiles, particle effects,
 * physics state. Anything not in this denylist that also isn't a player /
 * mob / vehicle / immobile-object falls through to "other".
 */
const ENTITY_NOISE_NAMES = new Set([
  "arrow",
  "spectral_arrow",
  "trident",
  "experience_orb",
  "area_effect_cloud",
  "falling_block",
  "tnt",
  "snowball",
  "egg",
  "ender_pearl",
  "eye_of_ender",
  "fireball",
  "small_fireball",
  "dragon_fireball",
  "wither_skull",
  "shulker_bullet",
  "fishing_bobber",
  "fishing_hook",
  "leash_knot",
  "lightning_bolt",
  "evoker_fangs",
]);

/**
 * Classify a world entity for the perception layer. Returns null for
 * pure noise (projectiles, xp orbs, etc.) so the caller can drop it.
 * Vehicles (boats, minecarts) and immobile objects (item_frame, painting,
 * armor_stand) get their own categories so the bot can actually see player-
 * placed decorations and means of transport — previously these were lumped
 * into "other" and dropped entirely.
 */
function classifyEntity(
  entity: Entity,
): "player" | "hostile" | "passive" | "vehicle" | "object" | "other" | null {
  if (entity.type === "player") return "player";

  const name = (entity.name ?? "").toLowerCase();
  if (ENTITY_NOISE_NAMES.has(name)) return null;

  const kind = (entity.kind ?? "").toLowerCase();
  if (kind.includes("hostile")) return "hostile";
  if (kind.includes("passive") || kind.includes("animal")) return "passive";
  if (kind.includes("vehicle")) return "vehicle";
  if (kind.includes("immobile")) return "object";
  return "other";
}

function collectDroppedItems(bot: Bot, radius: number): ObserveSurroundingsState["nearbyDroppedItems"] {
  const me = bot.entity.position;
  const groups = new Map<string, { count: number; nearestDist: number }>();
  for (const id of Object.keys(bot.entities)) {
    const entity = bot.entities[id];
    if (!entity) continue;
    if (entity.name !== "item" && entity.name !== "item_stack") continue;
    const dist = me.distanceTo(entity.position);
    if (dist > radius) continue;
    const item = entity.getDroppedItem?.();
    if (!item) continue;
    const existing = groups.get(item.name);
    if (!existing) {
      groups.set(item.name, { count: item.count, nearestDist: dist });
    } else {
      existing.count += item.count;
      if (dist < existing.nearestDist) existing.nearestDist = dist;
    }
  }
  return [...groups.entries()]
    .map(([item, g]) => ({ item, count: g.count, dist: round2(g.nearestDist) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_DROPPED_ITEMS);
}

function yawToCardinal(yawRad: number): string {
  const deg = ((yawRad * 180) / Math.PI + 360) % 360;
  // mineflayer yaw = π − notchian yaw: 0 = north (−Z), +90° = west,
  // 180° = south, 270° = east (see mineflayer/lib/conversions.js).
  if (deg < 22.5 || deg >= 337.5) return "north";
  if (deg < 67.5) return "north-west";
  if (deg < 112.5) return "west";
  if (deg < 157.5) return "south-west";
  if (deg < 202.5) return "south";
  if (deg < 247.5) return "south-east";
  if (deg < 292.5) return "east";
  return "north-east";
}

function timePhase(timeOfDay: number): "day" | "night" | "dusk" | "dawn" {
  // Minecraft day is 24000 ticks; 0 = sunrise, 6000 = noon, 12000 = sunset, 18000 = midnight.
  const t = timeOfDay % 24000;
  if (t < 1000 || t >= 23000) return "dawn";
  if (t < 12000) return "day";
  if (t < 13000) return "dusk";
  return "night";
}

function weather(bot: Bot): "clear" | "rain" | "thunder" {
  if (bot.thunderState > 0) return "thunder";
  if (bot.isRaining) return "rain";
  return "clear";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Block re-export so other skills can use the matcher style.
export { type Block };
