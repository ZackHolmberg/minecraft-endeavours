/**
 * Tool tiers and kinds. "Can harvest block X" is derived from minecraft-data
 * `harvestTools` (see recipes.ts); this table only provides ordering and names.
 *
 * Harvest level: wooden 0 = gold 0 < stone 1 = copper 1 < iron 2 < diamond 3 < netherite 4.
 * Gold quirk: golden tools are wood-tier for harvesting (fast but mines like wood).
 * Copper (1.21.9) harvests like stone (copper_pickaxe appears under iron_ore, not gold_ore).
 */
export const TOOL_KINDS = ["pickaxe", "axe", "shovel", "hoe", "sword"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export interface ToolTier {
  name: string;
  harvestLevel: number;
  /** Crafting material (for reference; recipes themselves come from minecraft-data). */
  material: string;
}

export const TOOL_TIERS: readonly ToolTier[] = [
  { name: "wooden", harvestLevel: 0, material: "planks" },
  { name: "golden", harvestLevel: 0, material: "gold_ingot" },
  { name: "stone", harvestLevel: 1, material: "cobblestone" },
  { name: "copper", harvestLevel: 1, material: "copper_ingot" },
  { name: "iron", harvestLevel: 2, material: "iron_ingot" },
  { name: "diamond", harvestLevel: 3, material: "diamond" },
  { name: "netherite", harvestLevel: 4, material: "netherite_ingot" },
];

/**
 * Tiers the planner *acquires*, cheapest first. Gold and copper are only ever used
 * if already owned (they satisfy requirements via harvestTools).
 */
export const ACQUIRE_LADDER: readonly string[] = ["wooden", "stone", "iron", "diamond", "netherite"];

export function toolItem(tier: string, kind: ToolKind): string {
  return `${tier}_${kind}`;
}

export function parseTool(item: string): { tier: string; kind: ToolKind } | null {
  for (const kind of TOOL_KINDS) {
    if (item.endsWith(`_${kind}`)) {
      const tier = item.slice(0, -(kind.length + 1));
      if (TOOL_TIERS.some((t) => t.name === tier)) return { tier, kind };
    }
  }
  return null;
}

export function harvestLevel(tier: string): number {
  return TOOL_TIERS.find((t) => t.name === tier)?.harvestLevel ?? -1;
}

/** Index in ACQUIRE_LADDER (or -1) — used to order candidate tools by cost. */
export function ladderIndex(tier: string): number {
  return ACQUIRE_LADDER.indexOf(tier);
}
