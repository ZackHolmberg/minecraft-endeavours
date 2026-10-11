/**
 * Where the dirt-hut fallback may dig its dirt (promotion review M4). Pure over a block reader.
 *
 * The requester usually stands in their own base, and a hut needs ~60 dirt, so the old "any grass/dirt in a
 * 15x15 area whose 6 neighbours aren't planks" rule dug dozens of pits in a player's yard and floor.
 * A candidate must now be NATURAL terrain:
 *  - no crafted or player-placed block within {@link CLEARANCE} blocks (cube) of it;
 *  - never a thin layer: the two blocks under it are natural solid ground (not a dirt floor over air / a basement);
 *  - never next to farmland, dirt paths, saplings or crops (3x3x3);
 *  - open above, outside the build site's footprint (+3), never the block underfoot.
 * Slope cells (an open side at the same height) are preferred: removing them notches a bank instead of
 * punching a pit into a lawn. {@link DIRT_DIG_CAP} bounds the total per build.
 */
import { isCraftedBlockName, isNaturalTerrain } from "../skills/structure-guard.js";
import { isAir, isReplaceable } from "../build/site.js";
import type { Cell } from "../build/types.js";

export type NameAt = (x: number, y: number, z: number) => string | null;

/** Blocks within this many blocks (Chebyshev) of a player block rule a cell out. */
export const CLEARANCE = 4;
/** Total dirt blocks one build may dig for itself (a dirt hut needs ~60, a scaffold 1-3). */
export const DIRT_DIG_CAP = 80;

const PLAYER_BLOCK =
  /^(crafting_table|furnace|blast_furnace|smoker|(trapped_|ender_)?chest|barrel|(wall_)?torch|soul_(wall_)?torch|campfire|soul_campfire|farmland|dirt_path|grass_path|rail|powered_rail|detector_rail|activator_rail|composter|hay_block|anvil|enchanting_table|brewing_stand|lectern|loom|cartography_table|fletching_table|smithing_table|stonecutter|grindstone|jukebox|note_block|dispenser|dropper|hopper|piston|sticky_piston|lever|repeater|comparator|tnt|cauldron|bell|scaffolding|cobblestone|mossy_cobblestone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|bricks|smooth_stone|glowstone|sea_lantern|redstone_.*|cobblestone_.*|.*_sign|.*_hanging_sign|.*_button|.*_pressure_plate|.*_banner|.*_head|.*_log_stripped|stripped_.*|potted_.*|flower_pot|bookshelf|chiseled_.*|polished_.*)$/;

/** A block a player (or a crafted structure) put there, as far as names can tell. */
export function isPlayerBlock(name: string): boolean {
  return isCraftedBlockName(name) || PLAYER_BLOCK.test(name);
}

/** Next to these a hole ruins someone's garden / path / planting. */
const GARDEN = /^(farmland|dirt_path|grass_path|.*_sapling|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_.*_stem|sweet_berry_bush|bamboo_sapling)$/;

export interface DirtSiteOpts {
  /** The build site's footprint (+3 margin applied here): never dig inside. */
  site: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  /** Horizontal search radius (default 7). */
  radius?: number;
}

export function chooseDirtCell(nameAt: NameAt, me: { x: number; y: number; z: number }, opts: DirtSiteOpts): Cell | null {
  const R = opts.radius ?? 7;
  const fx = Math.floor(me.x);
  const fy = Math.floor(me.y);
  const fz = Math.floor(me.z);

  // Player blocks in the search box + clearance, collected once (a per-candidate cube scan would be ~600k reads).
  const player: Array<[number, number, number]> = [];
  const pad = R + CLEARANCE;
  for (let x = fx - pad; x <= fx + pad; x++) {
    for (let z = fz - pad; z <= fz + pad; z++) {
      for (let y = fy - 3 - CLEARANCE; y <= fy + 1 + CLEARANCE; y++) {
        const n = nameAt(x, y, z);
        if (n !== null && isPlayerBlock(n)) player.push([x, y, z]);
      }
    }
  }
  const nearPlayer = (c: Cell): boolean =>
    player.some(([x, y, z]) => Math.abs(x - c.x) <= CLEARANCE && Math.abs(y - c.y) <= CLEARANCE && Math.abs(z - c.z) <= CLEARANCE);

  const solidNatural = (x: number, y: number, z: number): boolean => {
    const n = nameAt(x, y, z);
    return n !== null && !isAir(n) && isNaturalTerrain(n) && !/^(water|lava)$/.test(n);
  };
  const gardenNear = (c: Cell): boolean => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const n = nameAt(c.x + dx, c.y + dy, c.z + dz);
      if (n !== null && GARDEN.test(n)) return true;
    }
    return false;
  };

  let best: { c: Cell; d: number } | null = null;
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      for (let dy = -2; dy <= 1; dy++) {
        const c = { x: fx + dx, y: fy + dy - 1, z: fz + dz };
        const n = nameAt(c.x, c.y, c.z);
        if (n !== "grass_block" && n !== "dirt") continue;
        if (dx === 0 && dz === 0 && dy <= 0) continue; // never the block underfoot: digging it only digs the bot into a pit
        const s = opts.site;
        if (s && c.x >= s.minX - 3 && c.x <= s.maxX + 3 && c.z >= s.minZ - 3 && c.z <= s.maxZ + 3) continue;
        const above = nameAt(c.x, c.y + 1, c.z);
        if (above === null || !(isAir(above) || isReplaceable(above))) continue;
        // thin layer (a dirt floor / path over air, a basement, a cave): need two natural solid blocks below
        if (!solidNatural(c.x, c.y - 1, c.z) || !solidNatural(c.x, c.y - 2, c.z)) continue;
        if (gardenNear(c)) continue;
        if (nearPlayer(c)) continue;
        const slope = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, az]) => {
          const q = nameAt(c.x + ax!, c.y, c.z + az!);
          return q !== null && (isAir(q) || isReplaceable(q));
        });
        // fresh grass tops first (a second block down the same column deepens a pit); banks before lawns
        const d = Math.hypot(c.x + 0.5 - me.x, c.z + 0.5 - me.z) + Math.abs(c.y - (fy - 1)) + (n === "dirt" ? 6 : 0) + (slope ? 0 : 10);
        if (!best || d < best.d) best = { c, d };
      }
    }
  }
  return best?.c ?? null;
}
