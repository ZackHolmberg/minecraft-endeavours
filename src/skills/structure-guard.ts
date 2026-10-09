/**
 * Deterministic "is this block part of something a player built?" check, used
 * by `mineBlocks` to skip candidates instead of tearing up houses.
 *
 * The motivating failure: the bot couldn't path into a building, so the LLM
 * re-planned with `mineBlock("oak_planks")` / `mineBlock("glass")` and walked
 * straight through the wall. The type was explicitly requested, so a
 * type-based allowlist can't help — we have to look at *where* the block is.
 *
 * Heuristic (cheap: one blockAt per neighbour):
 *  - "Crafted" blocks — things worldgen essentially never scatters in the
 *    open: planks, stairs, slabs, glass, doors, bricks, wool, concrete, … —
 *    are protected when they touch another crafted block (i.e. are part of a
 *    build, not a lone stray), and doors / gates / trapdoors / glass are
 *    protected always.
 *  - Any other block (logs, stone, dirt, …) is protected when it touches two
 *    or more crafted blocks — log-cabin corner posts, the stone wall of a
 *    hillside house — while trees (logs + leaves only), ore veins and
 *    terrain are never affected.
 *
 * Deliberate gaps: cobblestone isn't "crafted" (it's what mining produces
 * and what the bot pillars with), and village / mineshaft structures count
 * as builds. Callers expose an explicit override for when a player really
 * did ask for something to be demolished.
 */

import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";

const CRAFTED_PATTERNS: readonly RegExp[] = [
  /_planks$/, /_stairs$/, /_slab$/, /_door$/, /_trapdoor$/, /_fence$/, /_fence_gate$/,
  /glass/, /_wall$/, /bricks?$/, /_wool$/, /_carpet$/, /_concrete$/, /glazed_terracotta$/,
  /^polished_/, /^smooth_(?!basalt)/, /^cut_/, /^chiseled_/, /_bed$/, /^bookshelf$/, /^quartz_/,
  /^lantern$/, /_lantern$/, /^ladder$/, /^iron_bars$/, /_pane$/,
];

// Protected regardless of neighbours: no one wants a lone door or window
// "harvested".
const ALWAYS_PATTERNS: readonly RegExp[] = [/_door$/, /_trapdoor$/, /_fence_gate$/, /glass/];

const NEIGHBOURS: readonly Vec3[] = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0), new Vec3(0, -1, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1),
];

export function isCraftedBlockName(name: string): boolean {
  return CRAFTED_PATTERNS.some((re) => re.test(name));
}

/** Returns a short reason if `block` looks player-built, else null. */
export function builtStructureReason(bot: Bot, block: Block): string | null {
  if (ALWAYS_PATTERNS.some((re) => re.test(block.name))) return `${block.name} is a door/window`;
  const crafted = isCraftedBlockName(block.name);
  let craftedNeighbours = 0;
  for (const off of NEIGHBOURS) {
    const n = bot.blockAt(block.position.plus(off));
    if (n && isCraftedBlockName(n.name)) craftedNeighbours += 1;
  }
  if (crafted && craftedNeighbours >= 1) return `${block.name} is joined to other building blocks`;
  if (!crafted && craftedNeighbours >= 2) return `${block.name} is set into a built wall`;
  return null;
}

/**
 * Natural-terrain allowlist for A* tunnelling (the scoped dig Movements in
 * pathfinder-config). Pathing may only BREAK blocks that worldgen produces as
 * terrain; everything else (cobblestone, planks, logs, glass, wool, beds,
 * furnaces, crafting tables, containers, signs, crops, torches, ...) is
 * unbreakable to the planner whatever its neighbours are. Deliberately
 * excludes logs (no log tunnelling) and cobblestone (what mining produces and
 * what players build with). Explicit `mineBlock` of a specific block is NOT
 * governed by this: it only limits what A* may dig through on the way.
 */
const NATURAL_TERRAIN_EXACT: ReadonlySet<string> = new Set([
  // stone family
  "stone", "granite", "diorite", "andesite", "deepslate", "tuff", "calcite",
  "dripstone_block", "pointed_dripstone",
  // soil
  "dirt", "grass_block", "coarse_dirt", "podzol", "mycelium", "rooted_dirt", "mud",
  // loose / sedimentary
  "sand", "red_sand", "gravel", "clay", "sandstone", "red_sandstone",
  // badlands terracotta (not glazed, not the other dye colours)
  "terracotta", "white_terracotta", "orange_terracotta", "yellow_terracotta",
  "brown_terracotta", "red_terracotta", "light_gray_terracotta",
  // nether / end
  "netherrack", "basalt", "blackstone", "soul_sand", "soul_soil", "end_stone",
  // cold / lush
  "snow", "snow_block", "ice", "packed_ice", "moss_block",
]);
const NATURAL_TERRAIN_PATTERNS: readonly RegExp[] = [/_ore$/, /_leaves$/];

/** True for blocks the dig-enabled pathfinder is allowed to break. */
export function isNaturalTerrain(name: string): boolean {
  return NATURAL_TERRAIN_EXACT.has(name) || NATURAL_TERRAIN_PATTERNS.some((re) => re.test(name));
}
