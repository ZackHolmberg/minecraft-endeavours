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

const FURNACE_SEARCH_RADIUS = 32;
const FURNACE_REACH = 3;
const SMELT_POLL_MS = 500;
const SMELT_MS_PER_ITEM = 12_000; // 10s server-side + 2s headroom for network jitter

/**
 * Items-smelted-per-fuel-unit lookup. Anything not listed falls through to
 * `FUEL_DEFAULT_BURN` — most plant materials (wood, planks, sticks-ish) burn
 * for one item at minimum, so undercounting is safer than overrunning out
 * of fuel mid-batch. Numbers from the vanilla Minecraft wiki (burn-time /
 * 200 ticks per smelt).
 */
const FUEL_BURN_PER_UNIT: ReadonlyMap<string, number> = new Map([
  ["coal", 8],
  ["charcoal", 8],
  ["coal_block", 80],
  ["lava_bucket", 100],
  ["dried_kelp_block", 20],
  ["blaze_rod", 12],
]);
const FUEL_DEFAULT_BURN = 1;
const FUEL_PREFERENCE_ORDER = ["coal", "charcoal", "coal_block", "blaze_rod", "dried_kelp_block"];

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

export interface SmeltParams {
  /** Item ID to smelt, e.g. "raw_iron", "raw_copper", "sand". */
  input: string;
  /** Fuel item ID. If omitted, the bot picks the best available from inventory. */
  fuel?: string;
  /** How many to smelt. Default 1. */
  count?: number;
  /** Optional explicit furnace position. Otherwise auto-resolves (nearby → remembered POI). */
  furnacePos?: Coords;
}

/**
 * Composite smelting. Closes the multi-step production loop alongside
 * `craft`: mine ore → walk to remembered furnace → `smelt` → walk to
 * crafting table → `craft`. Same furnace-resolution fallback as `craft`'s
 * table resolution (caller → nearby 32 blocks → remembered POI from
 * world.json) so the bot can return to a remembered furnace from deep in
 * a cave.
 *
 * Fuel auto-pick: when `fuel` is omitted, prefers coal → charcoal →
 * coal_block → blaze_rod → dried_kelp_block. Falls back to "any burnable in
 * inventory" assumption of 1 item per unit if nothing in the preference
 * list is available.
 */
export async function smelt(
  bot: Bot,
  { input, fuel, count = 1, furnacePos }: SmeltParams,
): Promise<SkillResult> {
  if (!input) return { ok: false, message: "input is required" };
  if (count < 1) return { ok: false, message: `count must be >= 1, got ${count}` };

  const inputData = bot.registry.itemsByName[input];
  if (!inputData) return { ok: false, message: `unknown input item "${input}"` };
  const haveInput = bot.inventory.count(inputData.id, null);
  if (haveInput < count) {
    return {
      ok: false,
      message: `cannot smelt ${count} ${input}: only ${haveInput} in inventory`,
    };
  }

  // Resolve fuel — either caller-provided or auto-pick.
  const fuelResolved = resolveFuel(bot, fuel, count);
  if (!fuelResolved.ok) return fuelResolved;
  const { item: fuelItem, units: fuelUnits } = fuelResolved;

  // Resolve furnace.
  const furnaceResolution = await resolveFurnace(bot, furnacePos);
  if (!furnaceResolution.ok) return furnaceResolution;
  const { block: furnaceBlock, source } = furnaceResolution;

  // Walk to furnace.
  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);
  try {
    await pBot.pathfinder.goto(
      new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, FURNACE_REACH),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `couldn't reach ${furnaceBlock.name} at ${fmt(furnaceBlock.position)} (${source}): ${message}` };
  }

  // Open furnace.
  let furnace;
  try {
    furnace = await bot.openFurnace(furnaceBlock);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `failed to open furnace at ${fmt(furnaceBlock.position)}: ${message}` };
  }

  let collected = 0;
  try {
    // Put input first so progress can start as soon as fuel hits.
    try {
      await furnace.putInput(inputData.id, null, count);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `putInput ${count} ${input} failed: ${message}` };
    }
    try {
      await furnace.putFuel(fuelItem.type, null, fuelUnits);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `putFuel ${fuelUnits} ${fuelItem.name} failed: ${message}` };
    }

    // Poll for output. Each smelt is ~10s server-side; budget 12s per item.
    const deadline = Date.now() + count * SMELT_MS_PER_ITEM;
    while (collected < count) {
      if (Date.now() > deadline) {
        return {
          ok: false,
          message: `smelt timeout: collected ${collected} of ${count} ${input} from furnace at ${fmt(furnaceBlock.position)}`,
          state: { collected },
        };
      }
      await sleep(SMELT_POLL_MS);
      const output = furnace.outputItem();
      if (output && output.count > 0) {
        try {
          const taken = await furnace.takeOutput();
          collected += taken.count;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            message: `takeOutput from furnace at ${fmt(furnaceBlock.position)} failed: ${message}`,
            state: { collected },
          };
        }
      }
    }
  } finally {
    furnace.close();
  }

  return {
    ok: true,
    message: `smelted ${collected} ${input} at furnace ${fmt(furnaceBlock.position)} (${source})`,
    state: { collected, furnace: furnaceBlock.name, pos: { x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z } },
  };
}

type FuelResolution =
  | { ok: true; item: { type: number; name: string }; units: number }
  | { ok: false; message: string };

function resolveFuel(bot: Bot, fuelName: string | undefined, smeltCount: number): FuelResolution {
  if (fuelName) {
    const fuelData = bot.registry.itemsByName[fuelName];
    if (!fuelData) return { ok: false, message: `unknown fuel "${fuelName}"` };
    const per = FUEL_BURN_PER_UNIT.get(fuelName) ?? FUEL_DEFAULT_BURN;
    const units = Math.ceil(smeltCount / per);
    const have = bot.inventory.count(fuelData.id, null);
    if (have < units) {
      return {
        ok: false,
        message: `not enough fuel: need ${units} ${fuelName} (smelts ${per}/unit), have ${have}`,
      };
    }
    return { ok: true, item: { type: fuelData.id, name: fuelName }, units };
  }

  // Auto-pick. Walk the preference order; first one with enough wins.
  for (const candidate of FUEL_PREFERENCE_ORDER) {
    const data = bot.registry.itemsByName[candidate];
    if (!data) continue;
    const per = FUEL_BURN_PER_UNIT.get(candidate) ?? FUEL_DEFAULT_BURN;
    const units = Math.ceil(smeltCount / per);
    const have = bot.inventory.count(data.id, null);
    if (have >= units) return { ok: true, item: { type: data.id, name: candidate }, units };
  }
  return {
    ok: false,
    message: `no fuel in inventory; tried ${FUEL_PREFERENCE_ORDER.join(", ")}`,
  };
}

type FurnaceResolution =
  | { ok: true; block: Block; source: "caller" | "nearby" | "remembered" }
  | { ok: false; message: string };

async function resolveFurnace(bot: Bot, furnacePos?: Coords): Promise<FurnaceResolution> {
  if (furnacePos) {
    const block = bot.blockAt(new Vec3(furnacePos.x, furnacePos.y, furnacePos.z));
    if (!block) {
      return {
        ok: false,
        message: `chunk at ${fmt(new Vec3(furnacePos.x, furnacePos.y, furnacePos.z))} isn't loaded — walk closer first`,
      };
    }
    if (!isFurnaceFamily(block.name)) {
      return {
        ok: false,
        message: `block at ${fmt(block.position)} is ${block.name}, not a furnace`,
      };
    }
    return { ok: true, block, source: "caller" };
  }

  const ids = ["furnace", "blast_furnace", "smoker"]
    .map((n) => bot.registry.blocksByName[n]?.id)
    .filter((id): id is number => id !== undefined);
  if (ids.length > 0) {
    const nearby = bot.findBlock({
      point: bot.entity.position,
      matching: ids,
      maxDistance: FURNACE_SEARCH_RADIUS,
    });
    if (nearby) return { ok: true, block: nearby, source: "nearby" };
  }

  const world = await readWorldKnowledge(bot.username);
  const remembered = world.pois
    .filter((p) => isFurnaceFamily(p.type))
    .map((p) => ({ p, dist: bot.entity.position.distanceTo(new Vec3(p.position.x, p.position.y, p.position.z)) }))
    .sort((a, b) => a.dist - b.dist)[0];

  if (remembered) {
    const block = bot.blockAt(
      new Vec3(remembered.p.position.x, remembered.p.position.y, remembered.p.position.z),
    );
    if (block && isFurnaceFamily(block.name)) {
      return { ok: true, block, source: "remembered" };
    }
    return {
      ok: false,
      message: `nearest remembered ${remembered.p.type} is at ${fmt(new Vec3(remembered.p.position.x, remembered.p.position.y, remembered.p.position.z))} (~${Math.round(remembered.dist)} blocks away) but the chunk isn't loaded — walk closer first`,
    };
  }

  return {
    ok: false,
    message: `no furnace within ${FURNACE_SEARCH_RADIUS} blocks and none remembered in world memory`,
  };
}

function isFurnaceFamily(name: string): boolean {
  return name === "furnace" || name === "blast_furnace" || name === "smoker";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
