import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";
import { Vec3 } from "vec3";
import { readWorldKnowledge } from "../memory/world-knowledge.js";
import { getBotState } from "../state/index.js";
import { creativeGive } from "./creative.js";
import { isCreative } from "./game-mode.js";
import { resolveItem } from "./item-naming.js";
import { placeFromInventoryNearby } from "./place-helper.js";
import { navigate } from "./navigation.js";
import type { Coords, SkillResult } from "./types.js";

const TABLE_SEARCH_RADIUS = 32;
const TABLE_REACH = 3;

const FURNACE_SEARCH_RADIUS = 32;
const FURNACE_REACH = 3;
const SMELT_POLL_MS = 500;
const SMELT_MS_PER_ITEM = 12_000; // 10s server-side + 2s headroom for network jitter

/**
 * Items-smelted-per-fuel-unit lookup. Logs/planks use `WOOD_FUEL_BURN`;
 * anything else falls through to `FUEL_DEFAULT_BURN` (1) — undercounting is
 * safer than overrunning out of fuel mid-batch. Numbers from the vanilla Minecraft wiki (burn-time /
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
/** Logs / planks / wood burn 300 ticks = 1.5 smelts. Nether stems don't burn. */
const WOOD_FUEL_BURN = 1.5;
function isWoodFuel(name: string): boolean {
  if (name.startsWith("crimson_") || name.startsWith("warped_")) return false;
  return name.endsWith("_planks") || name.endsWith("_log") || name.endsWith("_wood");
}
function burnPerUnit(name: string): number {
  return FUEL_BURN_PER_UNIT.get(name) ?? (isWoodFuel(name) ? WOOD_FUEL_BURN : FUEL_DEFAULT_BURN);
}
/** No input/fuel/output change for this long after loading = furnace isn't working. */
const SMELT_STALL_MS = 12_000;
const SMELT_MAX_PER_CALL = 64;

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

  if (isCreative(bot)) return craftCreative(bot, resolved);

  let table: Block | null = null;
  let tableSource: TableSource | null = null;
  const crafted: Array<{ item: string; count: number }> = [];
  const notes: string[] = [];

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
      crafted.push({ item: r.name, count: (result.state as { produced: number }).produced });
      continue;
    }

    // Inventory-only failed — distinguish "needs table" from "short on
    // ingredients" via recipesAll. If a 2×2 recipe exists at all, it's a
    // shortfall and walking to a table won't help.
    const invAll = bot.recipesAll(r.itemId, null, false);
    if (invAll.length > 0) {
      return failAt(i, r.name, shortfallMessage(bot, r.name, r.count, invAll, null));
    }

    // 3×3 recipe — needs a table. Resolve and walk once, on first demand.
    if (!table) {
      const tableResolution = await resolveCraftingTable(bot, tablePos);
      if (!tableResolution.ok) return failAt(i, r.name, tableResolution.message);
      const resolvedTable = tableResolution.block;
      const resolvedSource = tableResolution.source;
      if (tableResolution.note) notes.push(tableResolution.note);
      const nav = await navigate(
        bot,
        new goals.GoalNear(resolvedTable.position.x, resolvedTable.position.y, resolvedTable.position.z, TABLE_REACH),
        { label: `crafting_table at ${fmt(resolvedTable.position)} (${resolvedSource})`, target: resolvedTable.position },
      );
      if (!nav.ok) return failAt(i, r.name, nav.message);
      table = resolvedTable;
      tableSource = resolvedSource;
    }

    // Table-aware retry.
    const tableRecipes = bot.recipesFor(r.itemId, null, r.count, table);
    if (tableRecipes.length === 0) {
      const tableAll = bot.recipesAll(r.itemId, null, table);
      if (tableAll.length === 0) {
        return failAt(i, r.name, `no crafting recipe for "${r.name}" (it may be smelted, mined, or dropped instead)`);
      }
      return failAt(i, r.name, shortfallMessage(bot, r.name, r.count, tableAll, table));
    }

    const result = await runCraft(bot, r.name, r.count, tableRecipes[0]!, table);
    if (!result.ok) return failAt(i, r.name, result.message);
    crafted.push({ item: r.name, count: (result.state as { produced: number }).produced });
  }

  const summary = crafted.map((c) => `${c.count} ${c.item}`).join(", ");
  const tableNote = table ? ` at crafting_table ${fmt(table.position)} (${tableSource})` : "";
  const extra = notes.length > 0 ? `; ${notes.join("; ")}` : "";
  return {
    ok: true,
    message: crafted.length === 1
      ? `crafted ${summary}${tableNote}${extra}`
      : `crafted ${crafted.length} item types (${summary})${tableNote}${extra}`,
    state: { crafted, usedTable: table !== null },
  };
}

/**
 * Creative: crafting is pointless — a creative player takes the finished item
 * from the menu. Rather than fail and cost Haiku a round-trip to switch to
 * getItems, deliver the end result the player asked for (each `count` is
 * ADDED to what's held, matching what a craft would have produced). The
 * message names getItems so the model learns the right tool.
 */
async function craftCreative(
  bot: Bot,
  resolved: Array<{ name: string; itemId: number; count: number }>,
): Promise<SkillResult> {
  const got: Array<{ item: string; count: number }> = [];
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i]!;
    const have = bot.inventory.count(r.itemId, null);
    try {
      const res = await creativeGive(bot, r.itemId, have + r.count);
      got.push({ item: r.name, count: res.added });
      if (res.full) {
        return {
          ok: false,
          message: `creative mode: inventory full after taking ${res.added} ${r.name} — drop or deposit something`,
          state: { crafted: got, failedIndex: i, failedItem: r.name },
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `creative mode: couldn't take ${r.name}: ${message}`, state: { crafted: got, failedIndex: i } };
    }
  }
  const summary = got.map((g) => `${g.count} ${g.item}`).join(", ");
  return {
    ok: true,
    message: `creative mode, no crafting needed: took ${summary} from the creative inventory (use getItems for this next time)`,
    state: { crafted: got, usedTable: false, creative: true },
  };
}

/**
 * `bot.craft(recipe, n)` runs the recipe `n` *times* — not "until n items
 * exist". A recipe like planks yields 4 per craft, so asking for 4 planks
 * means one craft, not four (which would consume 4 logs, or throw "missing
 * ingredient" on the second pass with only one log).
 */
async function runCraft(
  bot: Bot,
  item: string,
  count: number,
  recipe: Recipe,
  table: Block | null,
): Promise<SkillResult> {
  const perCraft = Math.max(1, recipe.result.count);
  const times = Math.ceil(count / perCraft);
  const produced = times * perCraft;
  try {
    await bot.craft(recipe, times, table ?? undefined);
    return {
      ok: true,
      message: `crafted ${produced} ${item}${table ? ` at crafting_table ${fmt(table.position)}` : ""}`,
      state: { count: produced, produced, usedTable: table !== null },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `craft failed for ${item}: ${message}` };
  }
}

/**
 * Explain why no recipe variant is satisfiable. Recipes for tag-based
 * ingredients (planks, logs, wool) come back as one variant per concrete
 * item, so we pick the variant the bot is *closest* to completing — the
 * first variant is often bamboo/crimson and would mislead the model.
 *
 * Every missing ingredient is listed, and each gets a next-step hint when
 * it's itself craftable from current inventory ("craft oak_planks first").
 */
function shortfallMessage(
  bot: Bot,
  item: string,
  count: number,
  recipes: Recipe[],
  table: Block | null,
): string {
  let best: { missing: Array<{ id: number; need: number; have: number }>; total: number } | null = null;
  for (const recipe of recipes) {
    const times = Math.ceil(count / Math.max(1, recipe.result.count));
    const required = new Map<number, number>();
    for (const d of recipe.delta) {
      if (d.count < 0) required.set(d.id, (required.get(d.id) ?? 0) - d.count * times);
    }
    const missing: Array<{ id: number; need: number; have: number }> = [];
    let total = 0;
    for (const [id, need] of required) {
      const have = bot.inventory.count(id, null);
      if (have < need) {
        missing.push({ id, need, have });
        total += need - have;
      }
    }
    if (!best || total < best.total) best = { missing, total };
  }
  if (!best || best.missing.length === 0) {
    return `cannot craft ${count} ${item}: ingredients check inconclusive — try a smaller count`;
  }
  const parts = best.missing.map(({ id, need, have }) => {
    const name = bot.registry.items[id]?.name ?? `item#${id}`;
    const craftable = bot.recipesFor(id, null, need - have, table).length > 0;
    return `need ${need} ${name}, have ${have}${craftable ? ` (craft ${name} first)` : ""}`;
  });
  return `cannot craft ${count} ${item}: ${parts.join("; ")}`;
}

type TableSource = "caller" | "nearby" | "placed" | "remembered";
type TableResolution =
  | { ok: true; block: Block; source: TableSource; note?: string }
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

  // Carrying one (or the planks for one)? Put it down right here — that's
  // what a player does, and it beats walking back to a remembered table.
  const placed = await placeOwnCraftingTable(bot);
  if (placed) return placed;

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
    message: `no crafting_table within ${TABLE_SEARCH_RADIUS} blocks, none in inventory, and none remembered; get 4 planks (1 log → 4 planks) and retry — I'll craft and place one`,
  };
}

/**
 * Place a crafting_table from inventory, crafting one from 4 planks first if
 * needed. Returns null when neither is possible (caller falls through), or a
 * failed resolution when placement itself fails so the model sees why.
 */
async function placeOwnCraftingTable(bot: Bot): Promise<TableResolution | null> {
  let note: string | undefined;
  const hasTable = bot.inventory.items().some((i) => i.name === "crafting_table");
  if (!hasTable) {
    const ctItemId = bot.registry.itemsByName.crafting_table?.id;
    if (ctItemId === undefined) return null;
    const recipe = bot.recipesFor(ctItemId, null, 1, null)[0];
    if (!recipe) return null;
    try {
      await bot.craft(recipe, 1, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `no crafting_table nearby and crafting one failed: ${message}` };
    }
    note = "crafted a crafting_table (4 planks)";
  }
  const placed = await placeFromInventoryNearby(bot, "crafting_table");
  if (!placed.ok) {
    return { ok: false, message: `no crafting_table nearby; have one in inventory but ${placed.message}` };
  }
  return { ok: true, block: placed.block, source: "placed", note: note ? `${note} and placed it` : "placed my crafting_table" };
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
 * table resolution (caller → nearby 32 blocks → furnace from inventory →
 * remembered POI from world.json) so the bot can return to a remembered
 * furnace from deep in a cave.
 *
 * Only furnace types that can actually process the input are considered:
 * a smoker only cooks food and a blast furnace only smelts ores, and either
 * one would silently sit idle with the wrong input.
 *
 * Fuel auto-pick: when `fuel` is omitted, prefers coal → charcoal →
 * coal_block → blaze_rod → dried_kelp_block, then planks, then logs.
 *
 * Cancellable via the `stop` skill / chat side-channel; the furnace keeps
 * whatever is still loaded, so the agent can come back for it.
 */
export async function smelt(
  bot: Bot,
  { input, fuel, count = 1, furnacePos }: SmeltParams,
): Promise<SkillResult> {
  if (count < 1) return { ok: false, message: `count must be >= 1, got ${count}` };
  if (count > SMELT_MAX_PER_CALL) {
    return { ok: false, message: `count must be <= ${SMELT_MAX_PER_CALL} per smelt call (one furnace stack); split the batch` };
  }
  const r = resolveItem(bot, input);
  if (!r.ok) return { ok: false, message: `input ${r.message}` };
  if (isCreative(bot)) {
    // No smelting recipe table to map input → output, and a creative player
    // wouldn't wait on a furnace anyway: point at getItems with the result.
    return {
      ok: false,
      message: `creative mode: no need to smelt — use getItems for the smelted result directly (e.g. raw_iron → iron_ingot, sand → glass, beef → cooked_beef)`,
      state: { creative: true },
    };
  }
  const inputData = r.data;
  const inputName = r.normalized;
  const haveInput = bot.inventory.count(inputData.id, null);
  if (haveInput < count) {
    return {
      ok: false,
      message: `cannot smelt ${count} ${inputName}: only ${haveInput} in inventory${haveInput > 0 ? ` — retry with count ${haveInput}` : ""}`,
    };
  }

  // Pre-flight fuel check at the requested count, so we don't walk to a
  // furnace we can't use. After opening we re-resolve against the *real*
  // goal (which may include leftover input from a prior interrupted smelt),
  // and that second resolution can still fail — that's fine.
  const preflightFuel = resolveFuel(bot, fuel, count);
  if (!preflightFuel.ok) return preflightFuel;

  // Resolve furnace.
  const allowed = furnaceTypesFor(bot, inputName);
  const furnaceResolution = await resolveFurnace(bot, allowed, inputName, furnacePos);
  if (!furnaceResolution.ok) return furnaceResolution;
  const { block: furnaceBlock, source } = furnaceResolution;
  const pos = { x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z };

  // Walk to furnace.
  const nav = await navigate(
    bot,
    new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, FURNACE_REACH),
    { label: `${furnaceBlock.name} at ${fmt(furnaceBlock.position)} (${source})`, target: furnaceBlock.position },
  );
  if (!nav.ok) return nav;

  // Open furnace.
  let furnace;
  try {
    furnace = await bot.openFurnace(furnaceBlock);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `failed to open furnace at ${fmt(furnaceBlock.position)}: ${message}` };
  }

  // runSkill already reset the stop flag; a stop during the walk above was
  // handled by navigate().
  const state = getBotState(bot.username);

  let collected = 0;
  let goal = count;
  let leftoverAtStart = 0;
  let clearedOutput = "";
  try {
    // Output slot holding something from an earlier batch blocks new output
    // (and if it's a different item, the furnace stalls forever). Take it.
    const staleOutput = furnace.outputItem();
    if (staleOutput && staleOutput.count > 0) {
      try {
        const taken = await furnace.takeOutput();
        clearedOutput = ` (also took ${taken.count} ${taken.name} left in the output slot)`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `furnace output slot is occupied and taking it failed: ${message} — is my inventory full?` };
      }
    }

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
          message: `furnace at ${fmt(furnaceBlock.position)} is busy with ${existingInput.count} ${existingName}; wait for it, or use another furnace via furnacePos`,
          state: { existingInputType: existingName, existingInputCount: existingInput.count, position: pos },
        };
      }
      leftoverAtStart = existingInput.count;
      goal = Math.min(SMELT_MAX_PER_CALL, count + leftoverAtStart);
    }
    const toLoad = goal - leftoverAtStart;

    // Resolve fuel against the real goal (may exceed pre-flight if leftover
    // existed). Keeps fuel name/units in scope for the refuel path below.
    // Fuel already sitting in the fuel slot counts toward the need.
    const fuelResolved = resolveFuel(bot, fuel, goal);
    if (!fuelResolved.ok) return fuelResolved;
    const { item: fuelItem } = fuelResolved;
    const fuelPer = burnPerUnit(fuelItem.name);
    const existingFuel = furnace.fuelItem();
    const fuelAlready = existingFuel && existingFuel.type === fuelItem.type ? existingFuel.count : 0;
    const fuelUnits = Math.max(0, fuelResolved.units - fuelAlready);

    try {
      if (toLoad > 0) await furnace.putInput(inputData.id, null, toLoad);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `putInput ${toLoad} ${inputName} failed: ${message}` };
    }
    try {
      if (fuelUnits > 0) await furnace.putFuel(fuelItem.type, null, fuelUnits);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `putFuel ${fuelUnits} ${fuelItem.name} failed: ${message} (fuel slot may hold a different fuel — take it out or pass that fuel explicitly)` };
    }

    // Poll for output. Each smelt is ~10s server-side; budget 12s per item.
    const deadline = Date.now() + goal * SMELT_MS_PER_ITEM;
    let lastSig = furnaceSignature(furnace);
    let lastChangeAt = Date.now();
    while (collected < goal) {
      if (state?.cancellation.isRequested()) {
        const stillIn = furnace.inputItem()?.count ?? 0;
        return {
          ok: true,
          message: `stopped smelting: collected ${collected} ${inputName}; ${stillIn} still in the furnace at ${fmt(furnaceBlock.position)} (it keeps smelting — come back to collect)`,
          state: { collected, goal, leftoverInput: stillIn, position: pos, cancelled: true },
        };
      }
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
            message: `takeOutput from furnace at ${fmt(furnaceBlock.position)} failed: ${message} — is my inventory full?`,
            state: { collected, goal, position: pos },
          };
        }
      }
      if (collected >= goal) break;

      // Stall detection: a furnace that's actually working changes its
      // input / fuel / output slots at least every ~10s (lighting consumes
      // a fuel item immediately). Nothing moving for 12s means the input
      // isn't smeltable here — take everything back instead of sitting out
      // the full deadline.
      const sig = furnaceSignature(furnace);
      if (sig !== lastSig) {
        lastSig = sig;
        lastChangeAt = Date.now();
      } else if (collected === 0 && Date.now() - lastChangeAt > SMELT_STALL_MS) {
        await reclaim(furnace);
        return {
          ok: false,
          message: `${furnaceBlock.name} isn't smelting ${inputName} (no progress in ${SMELT_STALL_MS / 1000}s) — it may not be smeltable, or needs a regular furnace; took input and fuel back`,
          state: { collected, goal, position: pos },
        };
      }

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
            message: `furnace ran out of fuel: ${remainingInput.count} ${inputName} still in input slot at ${fmt(furnaceBlock.position)}; no more ${fuelItem.name} in inventory (collected ${collected}/${goal}) — get coal or planks and call smelt again`,
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
    message: `smelted ${collected} ${inputName} at ${furnaceBlock.name} ${fmt(furnaceBlock.position)} (${source})${leftoverNote}${clearedOutput}`,
    state: { collected, goal, furnace: furnaceBlock.name, pos },
  };
}

type FurnaceWindow = Awaited<ReturnType<Bot["openFurnace"]>>;

function furnaceSignature(furnace: FurnaceWindow): string {
  const c = (i: { type: number; count: number } | null) => (i ? `${i.type}x${i.count}` : "-");
  return `${c(furnace.inputItem())}|${c(furnace.fuelItem())}|${c(furnace.outputItem())}`;
}

async function reclaim(furnace: FurnaceWindow): Promise<void> {
  try {
    if (furnace.inputItem()) await furnace.takeInput();
  } catch {
    /* best-effort */
  }
  try {
    if (furnace.fuelItem()) await furnace.takeFuel();
  } catch {
    /* best-effort */
  }
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
    const per = burnPerUnit(normalized);
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
    const units = Math.ceil(smeltCount / burnPerUnit(candidate));
    const have = bot.inventory.count(data.id, null);
    if (have >= units) return { ok: true, item: { type: data.id, name: candidate }, units };
  }
  // Wood fallback — planks before logs (a log is worth 4 planks but burns
  // the same as one plank).
  const woodStacks = new Map<string, { type: number; count: number }>();
  for (const it of bot.inventory.items()) {
    if (!isWoodFuel(it.name)) continue;
    const prev = woodStacks.get(it.name);
    woodStacks.set(it.name, { type: it.type, count: (prev?.count ?? 0) + it.count });
  }
  const woodOrder = [...woodStacks.entries()].sort(
    ([a], [b]) => Number(!a.endsWith("_planks")) - Number(!b.endsWith("_planks")),
  );
  const units = Math.ceil(smeltCount / WOOD_FUEL_BURN);
  for (const [name, { type, count }] of woodOrder) {
    if (count >= units) return { ok: true, item: { type, name }, units };
  }
  return {
    ok: false,
    message: `no fuel for ${smeltCount} smelt(s): need ${Math.ceil(smeltCount / 8)} coal/charcoal or ${units} planks/logs. Mine coal_ore, or bring wood`,
  };
}

type FurnaceType = "furnace" | "blast_furnace" | "smoker";

/** Which furnace blocks can actually process `input`. */
function furnaceTypesFor(bot: Bot, input: string): FurnaceType[] {
  const foods = (bot.registry as { foodsByName?: Record<string, unknown> }).foodsByName ?? {};
  if (foods[input] || input === "kelp") return ["furnace", "smoker"];
  if (input.startsWith("raw_") || input.endsWith("_ore") || input === "ancient_debris") {
    return ["furnace", "blast_furnace"];
  }
  return ["furnace"];
}

type FurnaceResolution =
  | { ok: true; block: Block; source: "caller" | "nearby" | "placed" | "remembered" }
  | { ok: false; message: string };

async function resolveFurnace(
  bot: Bot,
  allowed: FurnaceType[],
  inputName: string,
  furnacePos?: Coords,
): Promise<FurnaceResolution> {
  const isAllowed = (name: string): boolean => (allowed as string[]).includes(name);
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
    if (!isAllowed(block.name)) {
      return { ok: false, message: `a ${block.name} can't smelt ${inputName}; use a ${allowed.join(" or ")}` };
    }
    return { ok: true, block, source: "caller" };
  }

  const ids = allowed
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

  // Carrying a usable furnace? Put it down here.
  const carried = allowed.find((n) => bot.inventory.items().some((i) => i.name === n));
  if (carried) {
    const placed = await placeFromInventoryNearby(bot, carried);
    if (placed.ok) return { ok: true, block: placed.block, source: "placed" };
    return { ok: false, message: `no ${allowed.join("/")} nearby; have one in inventory but ${placed.message}` };
  }

  const world = await readWorldKnowledge(bot.username);
  const remembered = world.pois
    .filter((p) => isAllowed(p.type))
    .map((p) => ({ p, dist: bot.entity.position.distanceTo(new Vec3(p.position.x, p.position.y, p.position.z)) }))
    .sort((a, b) => a.dist - b.dist)[0];

  if (remembered) {
    const block = bot.blockAt(
      new Vec3(remembered.p.position.x, remembered.p.position.y, remembered.p.position.z),
    );
    if (block && isAllowed(block.name)) {
      return { ok: true, block, source: "remembered" };
    }
    return {
      ok: false,
      message: `nearest remembered ${remembered.p.type} is at ${fmt(new Vec3(remembered.p.position.x, remembered.p.position.y, remembered.p.position.z))} (~${Math.round(remembered.dist)} blocks away) but the chunk isn't loaded — walk closer first`,
    };
  }

  const cobble = ["cobblestone", "cobbled_deepslate", "blackstone"]
    .reduce((sum, n) => sum + bot.inventory.count(bot.registry.itemsByName[n]?.id ?? -1, null), 0);
  const hint = cobble >= 8
    ? `craft a furnace (8 cobblestone, needs a crafting_table) and retry — I'll place it`
    : `mine 8 cobblestone, craft a furnace, and retry`;
  return {
    ok: false,
    message: `no ${allowed.join("/")} within ${FURNACE_SEARCH_RADIUS} blocks and none remembered; ${hint}`,
  };
}

function isFurnaceFamily(name: string): boolean {
  return name === "furnace" || name === "blast_furnace" || name === "smoker";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
