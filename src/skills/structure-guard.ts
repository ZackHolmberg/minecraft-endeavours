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

/**
 * Cheap-break allowlist: foliage a player would simply cut through, so the BASE
 * (never-digging) pathfinder policy may break it: all leaves (jungle canopies
 * otherwise make `Took to long to decide path` / unreachable logs), vines and
 * non-solid plants. Everything else stays unbreakable to A*. Leaves count as
 * natural even when they touch player builds (hedges, tree-hugging walls), so
 * the structure guard never protects them.
 */
const CHEAP_BREAK_PATTERNS: readonly RegExp[] = [
  /_leaves$/,
  /^(vine|cave_vines(_plant)?|weeping_vines(_plant)?|twisting_vines(_plant)?)$/,
  /^(short_grass|tall_grass|grass|fern|large_fern|dead_bush|seagrass|tall_seagrass)$/,
];

export function isCheapBreak(name: string): boolean {
  return CHEAP_BREAK_PATTERNS.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// Tree check (v2 regression pl.no_grief: the bot chopped a player's log hut)
// ---------------------------------------------------------------------------

/** Unstripped log / wood blocks. Stripped ones never occur in natural trees. */
const TREE_LOG_RE = /^(?!stripped_)[a-z_]+_(log|wood)$/;
const ANY_LOG_RE = /_(log|wood)$/;
const TREE_LEAF_RADIUS = 2;
const TREE_CLUSTER_CAP = 200;
/** Natural trunks/limbs never run 3+ logs in a straight horizontal line (2x2 trunks and 2-long limbs do). */
const HORIZONTAL_RUN = 3;

export function isLogName(name: string): boolean {
  return ANY_LOG_RE.test(name);
}

type NameAt = (p: Vec3) => { name: string } | null;

/**
 * Is the log at `start` part of a natural tree? True only if its connected log
 * cluster (26-neighbourhood) (a) has leaves within {@link TREE_LEAF_RADIUS}
 * blocks of some log and (b) has no horizontal run of {@link HORIZONTAL_RUN}+
 * logs, i.e. is not a wall/beam/floor. A bare pillar or wall of logs, or any
 * stripped log, is treated as player-built. Pure over `nameAt`, so unit-testable.
 * `verdicts` (optional) memoises the answer for every cell of the cluster.
 */
export function isTreeLog(nameAt: NameAt, start: Vec3, verdicts?: Map<string, boolean>): boolean {
  const k = (p: Vec3): string => `${p.x},${p.y},${p.z}`;
  const first = nameAt(start);
  if (!first || !TREE_LOG_RE.test(first.name)) return false;
  const known = verdicts?.get(k(start));
  if (known !== undefined) return known;

  const seen = new Set<string>([k(start)]);
  const cells: Vec3[] = [start];
  for (let i = 0; i < cells.length && cells.length < TREE_CLUSTER_CAP; i++) {
    const c = cells[i]!;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const n = new Vec3(c.x + dx, c.y + dy, c.z + dz);
      const nk = k(n);
      if (seen.has(nk)) continue;
      const b = nameAt(n);
      if (!b || !ANY_LOG_RE.test(b.name)) continue;
      seen.add(nk);
      cells.push(n);
    }
  }
  const anyStripped = cells.some((c) => !TREE_LOG_RE.test(nameAt(c)?.name ?? ""));
  let verdict = !anyStripped;
  if (verdict) {
    for (const c of cells) {
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
        if (seen.has(k(new Vec3(c.x + dx, c.y, c.z + dz))) && seen.has(k(new Vec3(c.x + 2 * dx, c.y, c.z + 2 * dz)))) {
          verdict = false;
        }
      }
      if (!verdict) break;
    }
  }
  if (verdict) verdict = clusterTouchesLeaves(nameAt, cells);
  if (verdicts) for (const c of cells) verdicts.set(k(c), verdict);
  return verdict;
}

function clusterTouchesLeaves(nameAt: NameAt, cells: Vec3[]): boolean {
  const r = TREE_LEAF_RADIUS;
  // top cells first: the crown is above the trunk
  const order = [...cells].sort((a, b) => b.y - a.y);
  for (const c of order) {
    for (let dy = r; dy >= -r; dy--) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const b = nameAt(new Vec3(c.x + dx, c.y + dy, c.z + dz));
      if (b && b.name.endsWith("_leaves")) return true;
    }
  }
  return false;
}

let treeCache: { bot: Bot | null; at: number; map: Map<string, boolean> } = { bot: null, at: 0, map: new Map() };
const TREE_CACHE_MS = 1_500;

/** Returns a short reason if `block` looks player-built, else null. */
export function builtStructureReason(bot: Bot, block: Block): string | null {
  if (isCheapBreak(block.name)) return null;
  if (isLogName(block.name)) {
    const now = Date.now();
    if (treeCache.bot !== bot || now - treeCache.at > TREE_CACHE_MS) treeCache = { bot, at: now, map: new Map() };
    if (!isTreeLog((p) => bot.blockAt(p), block.position, treeCache.map)) return `${block.name} is not part of a tree (log wall/pillar/stripped: looks player-built)`;
  }
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

/**
 * Blocks that fall when the block under them is removed. Breaking a block with one of
 * these directly above it drops it into the hole, onto whoever stands in that column
 * (v2 R6: gravel/sand over a dug cell). Used by the pathfinder (`gravityBlocks`,
 * `dontMineUnderFallingBlock`) and by the explicit-dig guard in `mineOneBlock`.
 */
const FALLING_RE = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|dragon_egg|anvil|chipped_anvil|damaged_anvil)$|_concrete_powder$/;

export function isFallingBlockName(name: string): boolean {
  return FALLING_RE.test(name);
}

/**
 * Would breaking `target` drop a falling block onto `standing`? True when the block directly
 * above `target` falls AND the bot stands in `target`'s column (below the dug cell). A bot
 * beside the column is safe: the block just refills the hole. Pure over `nameAt`.
 */
export function fallsOnBot(
  nameAt: (p: Vec3) => { name: string } | null,
  target: Vec3,
  standing: { x: number; y: number; z: number },
): boolean {
  const above = nameAt(target.offset(0, 1, 0));
  if (!above || !isFallingBlockName(above.name)) return false;
  return Math.floor(standing.x) === target.x && Math.floor(standing.z) === target.z && standing.y < target.y + 1;
}
