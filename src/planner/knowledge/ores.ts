/**
 * Overworld ore generation for 1.21 (post-1.18 worldgen; Y in blocks). minecraft-data has none.
 * `min`/`max` = full generation band, `best` = peak-frequency Y, `search` = the practical band the
 * bot should dig toward (dense part of the distribution). Below Y=0..8 the deepslate variant replaces stone.
 * Source: Minecraft wiki "Ore" (1.21).
 */
export interface OreBand {
  /** Item the ore ultimately yields (what a goal asks for). */
  item: string;
  /** Blocks that drop it (stone and deepslate variants). */
  blocks: string[];
  min: number;
  max: number;
  best: number;
  search: [number, number];
  note?: string;
}

export const ORE_BANDS: readonly OreBand[] = [
  { item: "coal", blocks: ["coal_ore", "deepslate_coal_ore"], min: 0, max: 320, best: 96, search: [48, 112], note: "also common on hillsides / exposed at surface" },
  { item: "raw_iron", blocks: ["iron_ore", "deepslate_iron_ore"], min: -64, max: 320, best: 16, search: [-16, 48], note: "second peak at Y=232 in mountains" },
  { item: "raw_copper", blocks: ["copper_ore", "deepslate_copper_ore"], min: -16, max: 112, best: 48, search: [32, 64], note: "dripstone caves are richest" },
  { item: "raw_gold", blocks: ["gold_ore", "deepslate_gold_ore"], min: -64, max: 32, best: -16, search: [-48, -8], note: "badlands: also Y 32-256 near surface" },
  { item: "diamond", blocks: ["diamond_ore", "deepslate_diamond_ore"], min: -64, max: 16, best: -59, search: [-64, -48] },
  { item: "redstone", blocks: ["redstone_ore", "deepslate_redstone_ore"], min: -64, max: 16, best: -59, search: [-64, -48] },
  { item: "lapis_lazuli", blocks: ["lapis_ore", "deepslate_lapis_ore"], min: -64, max: 64, best: 0, search: [-16, 16] },
  { item: "emerald", blocks: ["emerald_ore", "deepslate_emerald_ore"], min: -16, max: 320, best: 232, search: [100, 236], note: "mountain biomes only" },
];

const BY_BLOCK = new Map<string, OreBand>();
for (const o of ORE_BANDS) for (const b of o.blocks) BY_BLOCK.set(b, o);

export function oreBandForBlock(block: string): OreBand | undefined {
  return BY_BLOCK.get(block);
}

/** Blocks generated in other dimensions; used to avoid planning gathers that can't happen in the Overworld. */
export function blockDimension(block: string): "overworld" | "the_nether" | "the_end" {
  if (
    /^(nether|netherrack|soul_|basalt|smooth_basalt|blackstone|gilded_blackstone|crimson_|warped_|glowstone|shroomlight|magma_block|ancient_debris|weeping_|twisting_|polished_blackstone)/.test(
      block,
    )
  )
    return "the_nether";
  if (/^(end_|chorus_|purpur|dragon_)/.test(block)) return "the_end";
  return "overworld";
}

/** Items for which the world offers no *block* to mine but a crop/farm; planner only gathers these when the crop is in view. */
export const CROP_DROPS: Readonly<Record<string, { block: string; item: string }>> = {
  // minecraft-data's `wheat` block drops only seeds; mature wheat drops wheat + seeds.
  wheat: { block: "wheat", item: "wheat" },
};
