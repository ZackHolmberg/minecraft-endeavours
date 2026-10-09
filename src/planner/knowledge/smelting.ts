/**
 * Smelting rules (minecraft-data has none). Source: vanilla wiki, 1.21.
 * Furnace smelts everything; blast furnace (ores/metal gear, 100 ticks) and smoker
 * (food, 100 ticks) are faster variants. The planner only plans plain furnaces;
 * `blast`/`smoker` flags are eligibility data for the executor.
 * Cook time: 200 ticks (10 s) in a furnace, one fuel-unit == one 10 s smelt.
 */
export interface SmeltRule {
  input: string;
  output: string;
  blast?: boolean;
  smoker?: boolean;
}

const r = (input: string, output: string, kind?: "blast" | "smoker"): SmeltRule => ({
  input,
  output,
  ...(kind === "blast" ? { blast: true } : kind === "smoker" ? { smoker: true } : {}),
});

const LOGS = [
  "oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak",
];

export const SMELTING: readonly SmeltRule[] = [
  // metals (raw item and the silk-touch ore-block forms)
  r("raw_iron", "iron_ingot", "blast"),
  r("iron_ore", "iron_ingot", "blast"),
  r("deepslate_iron_ore", "iron_ingot", "blast"),
  r("raw_copper", "copper_ingot", "blast"),
  r("copper_ore", "copper_ingot", "blast"),
  r("deepslate_copper_ore", "copper_ingot", "blast"),
  r("raw_gold", "gold_ingot", "blast"),
  r("gold_ore", "gold_ingot", "blast"),
  r("deepslate_gold_ore", "gold_ingot", "blast"),
  r("ancient_debris", "netherite_scrap", "blast"),
  // other ores (silk-touch forms; normally these drop their item directly)
  r("coal_ore", "coal", "blast"),
  r("deepslate_coal_ore", "coal", "blast"),
  r("lapis_ore", "lapis_lazuli", "blast"),
  r("redstone_ore", "redstone", "blast"),
  r("diamond_ore", "diamond", "blast"),
  r("emerald_ore", "emerald", "blast"),
  // stone / sand / clay
  r("cobblestone", "stone"),
  r("stone", "smooth_stone"),
  r("cobbled_deepslate", "deepslate"),
  r("sand", "glass"),
  r("red_sand", "glass"),
  r("clay_ball", "brick"),
  r("clay", "terracotta"),
  r("netherrack", "nether_brick"),
  r("quartz_block", "smooth_quartz"),
  // wood
  ...LOGS.map((s) => r(`${s}_log`, "charcoal")),
  r("cactus", "green_dye"),
  r("wet_sponge", "sponge"),
  r("kelp", "dried_kelp", "smoker"),
  // food (furnace or smoker)
  r("beef", "cooked_beef", "smoker"),
  r("porkchop", "cooked_porkchop", "smoker"),
  r("chicken", "cooked_chicken", "smoker"),
  r("mutton", "cooked_mutton", "smoker"),
  r("rabbit", "cooked_rabbit", "smoker"),
  r("cod", "cooked_cod", "smoker"),
  r("salmon", "cooked_salmon", "smoker"),
  r("potato", "baked_potato", "smoker"),
];

/** output → rules that can make it. */
export const SMELT_BY_OUTPUT: ReadonlyMap<string, readonly SmeltRule[]> = (() => {
  const m = new Map<string, SmeltRule[]>();
  for (const rule of SMELTING) {
    const l = m.get(rule.output) ?? [];
    l.push(rule);
    m.set(rule.output, l);
  }
  return m;
})();

/** Items smelted per furnace per second is 0.1; used by the executor for timeouts. */
export const SMELT_SECONDS_PER_ITEM = 10;
