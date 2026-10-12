/**
 * Fuel burn values in "items smelted per fuel item" (burn ticks / 200).
 * Extends v1's table (src/skills/crafting.ts FUEL_BURN_PER_UNIT).
 */
const FUEL: Record<string, number> = {
  lava_bucket: 100,
  coal_block: 80,
  dried_kelp_block: 20,
  blaze_rod: 12,
  coal: 8,
  charcoal: 8,
  bamboo_block: 1.5,
  stick: 0.5,
  bamboo: 0.25,
  scaffolding: 0.25,
  wooden_pickaxe: 1,
  wooden_axe: 1,
  wooden_shovel: 1,
  wooden_hoe: 1,
  wooden_sword: 1,
  crafting_table: 1.5,
  chest: 1.5,
  bookshelf: 1.5,
};

/** Wood-family fuel: logs/planks/wood 1.5; Nether stems do NOT burn. */
export function isWoodFuel(name: string): boolean {
  if (name.startsWith("crimson_") || name.startsWith("warped_")) return false;
  return name.endsWith("_planks") || name.endsWith("_log") || name.endsWith("_wood");
}

/** Items smelted per one `name`; 0 if it isn't fuel. */
export function burnUnits(name: string): number {
  const v = FUEL[name];
  if (v !== undefined) return v;
  if (isWoodFuel(name)) return 1.5;
  if (name.endsWith("_sapling")) return 0.5;
  if (name.endsWith("_slab") && name.startsWith("oak_")) return 0.75;
  return 0;
}

/** Fuel the planner may choose for a smelt. Wasteful/building items (slabs, sticks, tools, saplings) are never auto-picked. */
export const PLANNABLE_FUEL_ORDER: readonly string[] = ["coal", "charcoal", "coal_block"];

/** Items smelted per fuel item, for fuel the planner would use; ceil(n / units) fuel items needed. */
export function fuelItemsFor(smelts: number, fuel: string): number {
  const u = burnUnits(fuel);
  return u > 0 ? Math.ceil(smelts / u - 1e-9) : Infinity;
}
