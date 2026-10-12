/** Placeable crafting/smelting stations. Recipes come from minecraft-data (furnace = 8 cobblestone, needs a table). */
export const STATIONS = ["crafting_table", "furnace"] as const;
export type StationBlock = (typeof STATIONS)[number];

export interface StationInfo {
  block: StationBlock;
  /** Item that is placed (consumed on placement). */
  item: string;
  /** Needed for: crafting 3x3 recipes / smelting. */
  purpose: "craft3x3" | "smelt";
}

export const STATION_INFO: Record<StationBlock, StationInfo> = {
  crafting_table: { block: "crafting_table", item: "crafting_table", purpose: "craft3x3" },
  furnace: { block: "furnace", item: "furnace", purpose: "smelt" },
};

/** Faster smelting variants; not planned, listed for the executor. */
export const OPTIONAL_STATIONS = { blast_furnace: "ores/metal gear, 2x speed", smoker: "food, 2x speed" } as const;
