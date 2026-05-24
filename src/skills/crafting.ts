import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";
import { Vec3 } from "vec3";
import { readWorldKnowledge } from "../memory/world-knowledge.js";
import { resolveItem } from "./item-naming.js";
import { ensureMovements, type BotWithPathfinder } from "./pathfinder-config.js";
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

/**
 * Items the agent has been observed picking as "fuel" that vanilla allows
 * but real players would never use because they burn for a fraction of an
 * item — wooden slabs at 0.75/unit, saplings at 0.5/unit, buttons at 0.5,
 * etc. Crafted from valuable wood and then thrown into a furnace for
 * almost no return.
 *
 * The auto-pick path skips them (they're not in FUEL_PREFERENCE_ORDER), but
 * the LLM can still pass them explicitly via the `fuel` param. We reject
 * those with an actionable message so the agent reroutes to "get coal first"
 * rather than torching its own building materials.
 */
const WASTEFUL_FUEL_SUFFIXES: ReadonlyArray<string> = [
  "_slab",
  "_sapling",
  "_button",
  "_trapdoor",
  "_fence_gate",
  "_pressure_plate",
];
const WASTEFUL_FUEL_EXACT: ReadonlySet<string> = new Set([
  "bamboo",
  "scaffolding",
  "stick",
]);
function isWastefulExplicitFuel(name: string): boolean {
  if (WASTEFUL_FUEL_EXACT.has(name)) return true;
  return WASTEFUL_FUEL_SUFFIXES.some((s) => name.endsWith(s));
}

export interface CraftParams {
  item: string;
  count?: number;
  tablePos?: Coords;
}

/**
 * Single-item craft. Thin wrapper around `craftMany` so size-1 calls share
 * exactly the batch code path.
 */
export async function craft(
  bot: Bot,
  { item, count = 1, tablePos }: CraftParams,
): Promise<SkillResult> {
  return craftMany(bot, { items: [{ item, count }], tablePos });
}

export interface CraftManyParams {
  items: Array<{ item: string; count?: number }>;
  tablePos?: Coords;
}

/**
 * Batch craft. Resolves a crafting table lazily — only walks to one when
 * the first 3×3 recipe in the list demands it — then runs each recipe in
 * order. One LLM round-trip covers an arbitrary toolset / armor set; the
 * unary `craft` is a wrapper around this.
 *
 * Table resolution order, when needed:
 *   1. caller-supplied `tablePos`
 *   2. nearest crafting_table within 32 blocks
 *   3. nearest crafting_table POI in world.json
 *
 * Failure model: stops at the first per-item failure with
 * `state.crafted[]` (what landed) and `state.failedIndex`. Order matters
 * — earlier crafts consume ingredients that later ones may need, so a
 * shortfall mid-batch means re-plan from that index, not retry the lot.
 */
export async function craftMany(
  bot: Bot,
  { items, tablePos }: CraftManyParams,
): Promise<SkillResult> {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: "items must be a non-empty array" };
  }

  // Pre-resolve all names + counts so a typo fails before walking.
  type Resolved = { name: string; itemId: number; count: number };
  const resolved: Resolved[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]!;
    const r = resolveItem(bot, entry.item);
    if (!r.ok) return { ok: false, message: `items[${i}] ${r.message}` };
    const count = entry.count ?? 1;
    if (count < 1) {
      return { ok: false, message: `items[${i}] count must be >= 1, got ${count}` };
    }
    resolved.push({ name: r.normalized, itemId: r.data.id, count });
  }

  let table: Block | null = null;
  let tableSource: "caller" | "nearby" | "remembered" | null = null;
  const crafted: Array<{ item: string; count: number }> = [];

  const failAt = (i: number, name: string, msg: string): SkillResult => ({
    ok: false,
    message: `craftMany failed at items[${i}] (${name}) after crafting ${crafted.length} of ${resolved.length}: ${msg}`,
    state: { crafted, failedIndex: i, failedItem: name },
  });

  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i]!;

    // Try inventory-only first (2×2). Cheap shortcut for sticks, planks,
    // torches; if every item in the batch is 2×2, we never walk to a table.
    const invRecipes = bot.recipesFor(r.itemId, null, r.count, null);
    if (invRecipes.length > 0) {
      const result = await runCraft(bot, r.name, r.count, invRecipes[0]!, null);
      if (!result.ok) return failAt(i, r.name, result.message);
      crafted.push({ item: r.name, count: r.count });
      continue;
    }

    // Inventory-only failed — distinguish "needs table" from "short on
    // ingredients" via recipesAll. If a 2×2 recipe exists at all, it's a
    // shortfall and walking to a table won't help.
    const invAll = bot.recipesAll(r.itemId, null, false);
    if (invAll.length > 0) {
      const shortfall = shortfallResult(bot, r.name, r.count, invAll[0]!);
      return failAt(i, r.name, shortfall.message);
    }

    // 3×3 recipe — needs a table. Resolve and walk once, on first demand.
    if (!table) {
      const tableResolution = await resolveCraftingTable(bot, tablePos);
      if (!tableResolution.ok) return failAt(i, r.name, tableResolution.message);
      const resolvedTable = tableResolution.block;
      const resolvedSource = tableResolution.source;
      const pBot = bot as BotWithPathfinder;
      ensureMovements(pBot);
      try {
        await pBot.pathfinder.goto(
          new goals.GoalNear(
            resolvedTable.position.x,
            resolvedTable.position.y,
            resolvedTable.position.z,
            TABLE_REACH,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return failAt(
          i,
          r.name,
          `couldn't reach crafting_table at ${fmt(resolvedTable.position)} (${resolvedSource}): ${message}`,
        );
      }
      table = resolvedTable;
      tableSource = resolvedSource;
    }

    // Table-aware retry.
    const tableRecipes = bot.recipesFor(r.itemId, null, r.count, table);
    if (tableRecipes.length === 0) {
      const tableAll = bot.recipesAll(r.itemId, null, table);
      if (tableAll.length === 0) {
        return failAt(i, r.name, `no known recipe for "${r.name}"`);
      }
      const shortfall = shortfallResult(bot, r.name, r.count, tableAll[0]!);
      return failAt(i, r.name, shortfall.message);
    }

    const result = await runCraft(bot, r.name, r.count, tableRecipes[0]!, table);
    if (!result.ok) return failAt(i, r.name, result.message);
    crafted.push({ item: r.name, count: r.count });
  }

  const summary = crafted.map((c) => `${c.count} ${c.item}`).join(", ");
  const tableNote = table ? ` at crafting_table ${fmt(table.position)} (${tableSource})` : "";
  return {
    ok: true,
    message: crafted.length === 1
      ? `crafted ${summary}${tableNote}`
      : `crafted ${crafted.length} item types (${summary})${tableNote}`,
    state: { crafted, usedTable: table !== null },
  };
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
  if (count < 1) return { ok: false, message: `count must be >= 1, got ${count}` };
  const r = resolveItem(bot, input);
  if (!r.ok) return { ok: false, message: `input ${r.message}` };
  const inputData = r.data;
  const inputName = r.normalized;
  const haveInput = bot.inventory.count(inputData.id, null);
  if (haveInput < count) {
    return {
      ok: false,
      message: `cannot smelt ${count} ${inputName}: only ${haveInput} in inventory`,
    };
  }

  // Pre-flight fuel check at the requested count, so we don't walk to a
  // furnace we can't use. After opening we re-resolve against the *real*
  // goal (which may include leftover input from a prior interrupted smelt),
  // and that second resolution can still fail — that's fine.
  const preflightFuel = resolveFuel(bot, fuel, count);
  if (!preflightFuel.ok) return preflightFuel;

  // Resolve furnace.
  const furnaceResolution = await resolveFurnace(bot, furnacePos);
  if (!furnaceResolution.ok) return furnaceResolution;
  const { block: furnaceBlock, source } = furnaceResolution;
  const pos = { x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z };

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
  let goal = count;
  let leftoverAtStart = 0;
  try {
    // Account for input already in the furnace from a prior (interrupted)
    // smelt. Policy: if it's the same type, fold the leftover into the goal
    // and provision fuel for the combined total — interrupted smelts are
    // common and a clean re-entry is friendlier than forcing the agent to
    // drain the slot first. If it's a different type, bail with a clear
    // message; we can't usefully share the slot.
    const existingInput = furnace.inputItem();
    if (existingInput && existingInput.count > 0) {
      if (existingInput.type !== inputData.id) {
        const existingName = bot.registry.items[existingInput.type]?.name ?? `item#${existingInput.type}`;
        return {
          ok: false,
          message: `furnace at ${fmt(furnaceBlock.position)} has ${existingInput.count} ${existingName} in input slot; collect it before smelting ${inputName}`,
          state: { existingInputType: existingName, existingInputCount: existingInput.count, position: pos },
        };
      }
      leftoverAtStart = existingInput.count;
      goal = count + leftoverAtStart;
    }

    // Resolve fuel against the real goal (may exceed pre-flight if leftover
    // existed). Keeps fuel name/units in scope for the refuel path below.
    const fuelResolved = resolveFuel(bot, fuel, goal);
    if (!fuelResolved.ok) return fuelResolved;
    const { item: fuelItem, units: fuelUnits } = fuelResolved;
    const fuelPer = FUEL_BURN_PER_UNIT.get(fuelItem.name) ?? FUEL_DEFAULT_BURN;

    // Put input first so progress can start as soon as fuel hits. (Skipped
    // when count is 0 — only happens via the leftover-only path, which can't
    // actually occur today since count >= 1, but the guard keeps the
    // arithmetic honest.)
    try {
      await furnace.putInput(inputData.id, null, count);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `putInput ${count} ${inputName} failed: ${message}` };
    }
    try {
      await furnace.putFuel(fuelItem.type, null, fuelUnits);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `putFuel ${fuelUnits} ${fuelItem.name} failed: ${message}` };
    }

    // Poll for output. Each smelt is ~10s server-side; budget 12s per item.
    const deadline = Date.now() + goal * SMELT_MS_PER_ITEM;
    while (collected < goal) {
      if (Date.now() > deadline) {
        const stillIn = furnace.inputItem()?.count ?? 0;
        return {
          ok: false,
          message: `smelt timeout: collected ${collected} of ${goal} ${inputName} from furnace at ${fmt(furnaceBlock.position)}; ${stillIn} still in input slot`,
          state: { collected, goal, leftoverInput: stillIn, position: pos },
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
            state: { collected, goal, position: pos },
          };
        }
      }
      if (collected >= goal) break;

      // Detect fuel exhaustion mid-batch: fuel slot empty with input still
      // to burn. The currently-burning item may finish a few more, but
      // topping up early is harmless and avoids the silent timeout-and-
      // partial-return the bug was about. If we're out of fuel in inventory
      // too, surface a fuel-specific error so the agent re-fuels rather
      // than (e.g.) re-mining ore.
      const remainingInput = furnace.inputItem();
      if (furnace.fuelItem() == null && remainingInput && remainingInput.count > 0) {
        const needUnits = Math.ceil((goal - collected) / fuelPer);
        const inInv = bot.inventory.count(fuelItem.type, null);
        if (inInv === 0) {
          return {
            ok: false,
            message: `furnace ran out of fuel: ${remainingInput.count} ${inputName} still in input slot at ${fmt(furnaceBlock.position)}; no more ${fuelItem.name} in inventory (collected ${collected}/${goal})`,
            state: { collected, goal, leftoverInput: remainingInput.count, fuel: fuelItem.name, position: pos },
          };
        }
        const topUp = Math.min(inInv, needUnits);
        try {
          await furnace.putFuel(fuelItem.type, null, topUp);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            message: `furnace ran out of fuel and refuel failed: ${message} (collected ${collected}/${goal}, ${remainingInput.count} ${inputName} still in input slot)`,
            state: { collected, goal, leftoverInput: remainingInput.count, position: pos },
          };
        }
      }
    }
  } finally {
    furnace.close();
  }

  const leftoverNote = leftoverAtStart > 0 ? ` (includes ${leftoverAtStart} leftover from a prior batch)` : "";
  return {
    ok: true,
    message: `smelted ${collected} ${inputName} at furnace ${fmt(furnaceBlock.position)} (${source})${leftoverNote}`,
    state: { collected, goal, furnace: furnaceBlock.name, pos },
  };
}

type FuelResolution =
  | { ok: true; item: { type: number; name: string }; units: number }
  | { ok: false; message: string };

function resolveFuel(bot: Bot, fuelName: string | undefined, smeltCount: number): FuelResolution {
  if (fuelName) {
    const r = resolveItem(bot, fuelName);
    if (!r.ok) return { ok: false, message: `fuel ${r.message}` };
    const fuelData = r.data;
    const normalized = r.normalized;
    if (isWastefulExplicitFuel(normalized)) {
      return {
        ok: false,
        message: `${normalized} is wasteful fuel (burns <1 item/unit); don't smelt with it. Mine coal_ore (drops coal directly with a wooden pickaxe or better), or as a last resort use logs/planks. Omit \`fuel\` to auto-pick the best one in inventory.`,
      };
    }
    const per = FUEL_BURN_PER_UNIT.get(normalized) ?? FUEL_DEFAULT_BURN;
    const units = Math.ceil(smeltCount / per);
    const have = bot.inventory.count(fuelData.id, null);
    if (have < units) {
      return {
        ok: false,
        message: `not enough fuel: need ${units} ${normalized} (smelts ${per}/unit), have ${have}`,
      };
    }
    return { ok: true, item: { type: fuelData.id, name: normalized }, units };
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
