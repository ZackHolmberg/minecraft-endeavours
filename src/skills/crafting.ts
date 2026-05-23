import type { Bot } from "mineflayer";
import pathfinderPkg, { type Pathfinder } from "mineflayer-pathfinder";

const { goals, Movements } = pathfinderPkg;
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";
import { Vec3 } from "vec3";
import { readWorldKnowledge } from "../memory/world-knowledge.js";
import type { Coords, SkillResult } from "./types.js";

const TABLE_SEARCH_RADIUS = 32;
const TABLE_REACH = 3;

interface BotWithPathfinder extends Bot {
  pathfinder: Pathfinder;
}

export interface CraftParams {
  item: string;
  count?: number;
  tablePos?: Coords;
}

/**
 * Composite craft. Resolve a recipe for `item` × `count`, walk to a crafting
 * table if the recipe needs one (2×2 recipes can be made in inventory), and
 * call bot.craft. Specific failure messages cover the three things players
 * will hit: missing ingredients (with shortfall counts), no nearby table,
 * and "this item has no known recipe at all" (different actionability).
 *
 * Table resolution order, when needed:
 *   1. caller-supplied `tablePos`
 *   2. nearest crafting_table within 32 blocks (live search via findBlock)
 *   3. nearest crafting_table POI in world.json (remembered from prior visit)
 *
 * Option 3 is what makes the iron-armor loop work: bot mined deep in a cave,
 * needs to walk home to its remembered crafting table — Claude sees the
 * known-utility entry in observeSurroundings and the skill walks to it.
 */
export async function craft(
  bot: Bot,
  { item, count = 1, tablePos }: CraftParams,
): Promise<SkillResult> {
  if (!item) return { ok: false, message: "item is required" };
  if (count < 1) return { ok: false, message: `count must be >= 1, got ${count}` };

  const itemData = bot.registry.itemsByName[item];
  if (!itemData) return { ok: false, message: `unknown item "${item}"` };

  // Try inventory-only first (2×2 grid). Cheap shortcut for planks, sticks,
  // torches, etc. and avoids any walking.
  const inventoryRecipes = bot.recipesFor(itemData.id, null, count, null);
  if (inventoryRecipes.length > 0) {
    return await runCraft(bot, item, count, inventoryRecipes[0]!, null);
  }

  // Inventory crafting failed — either the recipe needs a table or we don't
  // have ingredients. Distinguish via recipesAll (ignores inventory).
  const inventoryAllRecipes = bot.recipesAll(itemData.id, null, false);
  if (inventoryAllRecipes.length > 0) {
    // Recipe exists for 2×2; we're short on ingredients.
    return shortfallResult(bot, item, count, inventoryAllRecipes[0]!);
  }

  // 3×3 recipe — needs a crafting table.
  const tableResolution = await resolveCraftingTable(bot, tablePos);
  if (!tableResolution.ok) return tableResolution;
  const { block: table, source } = tableResolution;

  // Walk within reach. The table block's position is the click target.
  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);
  try {
    await pBot.pathfinder.goto(
      new goals.GoalNear(table.position.x, table.position.y, table.position.z, TABLE_REACH),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `couldn't reach crafting_table at ${fmt(table.position)} (${source}): ${message}`,
    };
  }

  // Now check recipes with the table available.
  const tableRecipes = bot.recipesFor(itemData.id, null, count, table);
  if (tableRecipes.length === 0) {
    const all = bot.recipesAll(itemData.id, null, table);
    if (all.length === 0) {
      return { ok: false, message: `no known recipe for "${item}"` };
    }
    return shortfallResult(bot, item, count, all[0]!);
  }

  return await runCraft(bot, item, count, tableRecipes[0]!, table);
}

async function runCraft(
  bot: Bot,
  item: string,
  count: number,
  recipe: Recipe,
  table: Block | null,
): Promise<SkillResult> {
  try {
    await bot.craft(recipe, count, table ?? undefined);
    return {
      ok: true,
      message: `crafted ${count} ${item}${table ? ` at crafting_table ${fmt(table.position)}` : ""}`,
      state: { count, usedTable: table !== null },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `craft failed for ${item}: ${message}` };
  }
}

/**
 * Walk the recipe's ingredient deltas and report the first shortfall. The
 * message is the one Claude will act on — e.g. "need 4 oak_planks; have 2"
 * tells the model exactly which sub-task to spawn.
 */
function shortfallResult(bot: Bot, item: string, count: number, recipe: Recipe): SkillResult {
  const required = new Map<number, number>();
  for (const d of recipe.delta) {
    if (d.count < 0) {
      // delta count is per-recipe-output; scale by requested count.
      const need = -d.count * count;
      required.set(d.id, (required.get(d.id) ?? 0) + need);
    }
  }
  for (const [id, need] of required) {
    const have = bot.inventory.count(id, null);
    if (have < need) {
      const ingredient = bot.registry.items[id]?.name ?? `item#${id}`;
      return {
        ok: false,
        message: `cannot craft ${count} ${item}: need ${need} ${ingredient}; have ${have}`,
      };
    }
  }
  // Shouldn't reach here — recipesFor said no, but our scan says yes.
  return { ok: false, message: `cannot craft ${count} ${item}: ingredients check inconclusive` };
}

type TableResolution =
  | { ok: true; block: Block; source: "caller" | "nearby" | "remembered" }
  | { ok: false; message: string };

async function resolveCraftingTable(bot: Bot, tablePos?: Coords): Promise<TableResolution> {
  if (tablePos) {
    const block = bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z));
    if (!block || block.name !== "crafting_table") {
      return {
        ok: false,
        message: `no crafting_table at ${fmt(new Vec3(tablePos.x, tablePos.y, tablePos.z))} (block is ${block?.name ?? "unloaded"})`,
      };
    }
    return { ok: true, block, source: "caller" };
  }

  const ctId = bot.registry.blocksByName.crafting_table?.id;
  if (ctId !== undefined) {
    const nearby = bot.findBlock({
      point: bot.entity.position,
      matching: ctId,
      maxDistance: TABLE_SEARCH_RADIUS,
    });
    if (nearby) return { ok: true, block: nearby, source: "nearby" };
  }

  // Fall back to a remembered table from world.json.
  const world = await readWorldKnowledge(bot.username);
  const remembered = world.pois
    .filter((p) => p.type === "crafting_table")
    .map((p) => ({ p, dist: bot.entity.position.distanceTo(new Vec3(p.position.x, p.position.y, p.position.z)) }))
    .sort((a, b) => a.dist - b.dist)[0];

  if (remembered) {
    const block = bot.blockAt(
      new Vec3(remembered.p.position.x, remembered.p.position.y, remembered.p.position.z),
    );
    if (block && block.name === "crafting_table") {
      return { ok: true, block, source: "remembered" };
    }
    return {
      ok: false,
      message: `nearest remembered crafting_table is at ${fmt(new Vec3(remembered.p.position.x, remembered.p.position.y, remembered.p.position.z))} (~${Math.round(remembered.dist)} blocks away) but the chunk isn't loaded — walk closer first`,
    };
  }

  return {
    ok: false,
    message: `no crafting_table within ${TABLE_SEARCH_RADIUS} blocks and none remembered in world memory`,
  };
}

function ensureMovements(bot: BotWithPathfinder): void {
  if (!bot.pathfinder.movements || bot.pathfinder.movements.bot !== bot) {
    bot.pathfinder.setMovements(new Movements(bot));
  }
}

function fmt(v: { x: number; y: number; z: number }): string {
  return `(${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)})`;
}
