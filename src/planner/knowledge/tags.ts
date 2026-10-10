/**
 * Generic goal tags: `{ item: "#log", count: 10 }` means "any N of the matching items".
 * The planner resolves a tag to concrete species per plan (what is owned, then what is in
 * view, then the default order), so "chop 10 logs" takes whatever tree is nearby instead of
 * making the model name a species. Members are exact minecraft-data item names.
 */
import { WOOD_FAMILIES } from "./wood.js";

const COLORS = [
  "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
  "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
];

export const GOAL_TAGS: Readonly<Record<string, { members: readonly string[]; note: string }>> = {
  log: {
    members: WOOD_FAMILIES.filter((w) => !w.nether && w.species !== "bamboo").map((w) => w.log),
    note: "any overworld log (whichever tree is nearest)",
  },
  planks: { members: WOOD_FAMILIES.map((w) => w.planks), note: "planks of any wood" },
  wool: { members: COLORS.map((c) => `${c}_wool`), note: "wool of any colour (needs sheep: not plannable yet unless held)" },
  stone_tool_material: { members: ["cobblestone", "cobbled_deepslate", "blackstone"], note: "what stone tools are crafted from" },
  coal: { members: ["coal", "charcoal"], note: "coal or charcoal" },
  sand: { members: ["sand", "red_sand"], note: "sand or red sand" },
};

export function isGoalTag(item: string): boolean {
  return item.startsWith("#");
}

/** Members of a tag (`"#log"`), or null when unknown. */
export function tagMembers(item: string): readonly string[] | null {
  return GOAL_TAGS[item.slice(1)]?.members ?? null;
}

export function knownTagNames(): string[] {
  return Object.keys(GOAL_TAGS).map((t) => `#${t}`);
}
