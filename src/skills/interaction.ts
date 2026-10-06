import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { equipItem } from "./inventory.js";
import { navigate } from "./navigation.js";
import type { Coords, SkillResult } from "./types.js";

const BLOCK_REACH = 3;
const ENTITY_REACH = 3;

export interface ActivateBlockParams {
  position: Coords;
  /**
   * Optional item to equip before activating. Saves a round-trip when the
   * natural usage is "use tool X on block at Y" — hoe → till dirt, flint and
   * steel → ignite, bucket → place water/lava (or fill from a water source),
   * bone meal → grow crop, seeds → plant on farmland, doors / levers /
   * buttons → no `with` needed.
   */
  with?: string;
}

/**
 * Right-click on a block at `position`. Wraps `bot.activateBlock`. When
 * `with` is provided, equips that item to hand first (mineflayer's
 * activateBlock uses whatever is currently held). Walks within reach if
 * needed.
 */
export async function activateBlock(
  bot: Bot,
  { position, with: withItem }: ActivateBlockParams,
): Promise<SkillResult> {
  if (!position) return { ok: false, message: "position is required" };

  const target = new Vec3(position.x, position.y, position.z);
  const block = bot.blockAt(target);
  if (!block) {
    return {
      ok: false,
      message: `chunk at ${fmt(target)} isn't loaded — walk closer first`,
    };
  }
  if (block.name === "air" || block.name === "cave_air" || block.name === "void_air") {
    return { ok: false, message: `block at ${fmt(target)} is air — nothing to activate` };
  }

  const nav = await navigate(bot, new goals.GoalNear(target.x, target.y, target.z, BLOCK_REACH), {
    label: `${block.name} at ${fmt(target)}`,
    target,
  });
  if (!nav.ok) return nav;

  if (withItem) {
    const equip = await equipItem(bot, { item: withItem, slot: "hand" });
    if (!equip.ok) return { ok: false, message: `cannot activate with "${withItem}": ${equip.message}` };
  }

  try {
    await bot.activateBlock(block);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `activate ${block.name} at ${fmt(target)}${withItem ? ` with ${withItem}` : ""} failed: ${message}`,
    };
  }

  const heldNow = bot.heldItem?.name;
  return {
    ok: true,
    message: `activated ${block.name} at ${fmt(target)}${heldNow ? ` with ${heldNow}` : ""}`,
    state: { block: block.name, pos: { x: target.x, y: target.y, z: target.z }, with: heldNow ?? null },
  };
}

export interface UseItemParams {
  /** Optional item to equip before using. */
  with?: string;
  /** Use the off-hand item instead of the main-hand. Defaults to main-hand. */
  offhand?: boolean;
}

/**
 * Right-click in mid-air with the held item. Wraps `bot.activateItem`. Use
 * for fire-and-forget interactions that don't target a block or entity:
 * throwing an ender pearl, throwing a splash / lingering potion, casting
 * the fishing rod manually (prefer the dedicated `fish` skill instead),
 * charging a bow or crossbow.
 *
 * Eating food and drinking potions go through the dedicated `eat` skill
 * which handles the equip + activate + consume cycle in one shot. Don't
 * use `useItem` for those — it starts the action but doesn't finish it.
 */
export async function useItem(
  bot: Bot,
  { with: withItem, offhand = false }: UseItemParams = {},
): Promise<SkillResult> {
  if (withItem) {
    const equip = await equipItem(bot, { item: withItem, slot: offhand ? "off-hand" : "hand" });
    if (!equip.ok) return { ok: false, message: `cannot use "${withItem}": ${equip.message}` };
  }
  const held = offhand ? bot.inventory.slots[45] : bot.heldItem;
  if (!held) {
    return {
      ok: false,
      message: offhand ? "off-hand is empty" : "hand is empty — equip something first or pass `with`",
    };
  }
  try {
    bot.activateItem(offhand);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `activateItem ${held.name} failed: ${message}` };
  }
  return {
    ok: true,
    message: `used ${held.name}${offhand ? " (off-hand)" : ""}`,
    state: { used: held.name, offhand },
  };
}

export interface UseOnEntityParams {
  entity: string;
  /** Optional item to equip before using. See ActivateBlockParams.with. */
  with?: string;
}

/**
 * Right-click on an entity. Wraps `bot.useOn`. Covers shears → sheep (wool),
 * bucket → cow (milk), name tag → entity, dye → sheep, lead → animal,
 * saddle → horse, and similar item-on-entity interactions.
 */
export async function useOnEntity(
  bot: Bot,
  { entity, with: withItem }: UseOnEntityParams,
): Promise<SkillResult> {
  if (!entity) return { ok: false, message: "entity is required" };

  const target = findEntityByName(bot, entity);
  if (!target) return { ok: false, message: `entity "${entity}" not visible to the bot` };

  // Walk close enough to interact (~3 blocks reach). Use a static GoalNear
  // around the entity's current position rather than GoalFollow — mobs that
  // wander would otherwise turn this into a chase.
  const pos = target.position;
  const nav = await navigate(bot, new goals.GoalNear(pos.x, pos.y, pos.z, ENTITY_REACH), {
    label: entity,
    target: pos,
  });
  if (!nav.ok) return nav;

  if (withItem) {
    const equip = await equipItem(bot, { item: withItem, slot: "hand" });
    if (!equip.ok) return { ok: false, message: `cannot use on ${entity} with "${withItem}": ${equip.message}` };
  }

  // Re-resolve entity post-walk (it may have moved or despawned).
  const live = findEntityByName(bot, entity);
  if (!live) return { ok: false, message: `lost sight of ${entity} after walking` };

  try {
    await bot.lookAt(live.position.offset(0, live.height ?? 1, 0));
  } catch {
    // lookAt is cosmetic — useOn raycasts internally.
  }

  try {
    bot.useOn(live);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `useOn ${entity}${withItem ? ` with ${withItem}` : ""} failed: ${message}`,
    };
  }

  const heldNow = bot.heldItem?.name;
  return {
    ok: true,
    message: `used ${heldNow ?? "empty hand"} on ${entity}`,
    state: { entity, with: heldNow ?? null },
  };
}

function findEntityByName(bot: Bot, name: string): Entity | null {
  const player = bot.players[name];
  if (player?.entity) return player.entity;

  const lower = name.toLowerCase();
  let best: { entity: Entity; dist: number } | null = null;
  const me = bot.entity.position;
  for (const id of Object.keys(bot.entities)) {
    const entity = bot.entities[id];
    if (!entity || entity.id === bot.entity.id) continue;
    if (entity.name?.toLowerCase() !== lower && entity.username?.toLowerCase() !== lower) continue;
    const d = me.distanceTo(entity.position);
    if (!best || d < best.dist) best = { entity, dist: d };
  }
  return best?.entity ?? null;
}

function fmt(v: { x: number; y: number; z: number }): string {
  return `(${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)})`;
}
