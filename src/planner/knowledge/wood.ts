/** Wood families: log → planks. Recipes come from minecraft-data; this is for defaults/ordering and fuel. */
export interface WoodFamily {
  species: string;
  log: string;
  planks: string;
  /** planks per log item (bamboo_block gives 2). */
  planksPerLog: number;
  nether?: boolean;
}

export const WOOD_FAMILIES: readonly WoodFamily[] = [
  { species: "oak", log: "oak_log", planks: "oak_planks", planksPerLog: 4 },
  { species: "spruce", log: "spruce_log", planks: "spruce_planks", planksPerLog: 4 },
  { species: "birch", log: "birch_log", planks: "birch_planks", planksPerLog: 4 },
  { species: "jungle", log: "jungle_log", planks: "jungle_planks", planksPerLog: 4 },
  { species: "acacia", log: "acacia_log", planks: "acacia_planks", planksPerLog: 4 },
  { species: "dark_oak", log: "dark_oak_log", planks: "dark_oak_planks", planksPerLog: 4 },
  { species: "mangrove", log: "mangrove_log", planks: "mangrove_planks", planksPerLog: 4 },
  { species: "cherry", log: "cherry_log", planks: "cherry_planks", planksPerLog: 4 },
  { species: "pale_oak", log: "pale_oak_log", planks: "pale_oak_planks", planksPerLog: 4 },
  { species: "bamboo", log: "bamboo_block", planks: "bamboo_planks", planksPerLog: 2 },
  { species: "crimson", log: "crimson_stem", planks: "crimson_planks", planksPerLog: 4, nether: true },
  { species: "warped", log: "warped_stem", planks: "warped_planks", planksPerLog: 4, nether: true },
];

/** Default preference order when no species is owned or in view (surface-common first). */
export const WOOD_DEFAULT_ORDER: readonly string[] = WOOD_FAMILIES.map((w) => w.species);

export function woodFamilyOfPlanks(item: string): WoodFamily | undefined {
  return WOOD_FAMILIES.find((w) => w.planks === item);
}
export function woodFamilyOfLog(item: string): WoodFamily | undefined {
  return WOOD_FAMILIES.find((w) => w.log === item);
}
