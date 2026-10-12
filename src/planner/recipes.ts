/**
 * minecraft-data adapter: recipes, block sources, tool requirements, mob loot.
 * Loaded once per version. Pure data; no planning state here (see plan.ts / availability.ts).
 */
import minecraftData from "minecraft-data";
import { CROP_DROPS, parseTool, ACQUIRE_LADDER } from "./knowledge/index.js";

export const DEFAULT_MC_VERSION = "1.21.9";

export interface NormRecipe {
  result: string;
  /** Items produced per craft. */
  yield: number;
  /** ingredient item → count per craft. */
  ingredients: Record<string, number>;
  /** True iff the shape needs a 3x3 grid (wider/taller than 2, or >4 shapeless ingredients). */
  table: boolean;
}

export interface BlockSource {
  block: string;
  /** Tools that can harvest it (item names); null = hand/anything. */
  tools: ReadonlySet<string> | null;
  /** Lowest-cost acquirable tool (wooden<stone<iron<diamond<netherite) from `tools`, null when none needed. */
  minTool: string | null;
}

/** Self-dropping blocks that are natural even though the item is craftable (so not a "man-made" block). */
const NATURAL_OK = new Set(["melon", "glowstone", "snow_block", "clay", "pumpkin", "packed_ice", "ice", "blue_ice"]);
/** Blocks that are not worth treating as a source of their drops. */
const NOT_A_SOURCE = new Set(["farmland", "dirt_path", "spawner", "trial_spawner", "vault", "bedrock", "barrier", "cobweb"]);
/** Crop blocks that have no item of the same name but are real, harvestable sources. */
const CROP_BLOCKS = new Set(["wheat", "carrots", "potatoes", "beetroots", "cocoa", "nether_wart"]);

export class RecipeBook {
  readonly version: string;
  private readonly d: ReturnType<typeof minecraftData>;
  private recipeCache = new Map<string, NormRecipe[]>();
  private sourceCache = new Map<string, BlockSource[]>();
  private lootCache: Map<string, string[]> | null = null;
  private idToName = new Map<number, string>();

  constructor(version: string) {
    this.version = version;
    const d = minecraftData(version);
    if (!d) throw new Error(`minecraft-data has no data for version "${version}"`);
    this.d = d;
    for (const it of d.itemsArray) this.idToName.set(it.id, it.name);
  }

  hasItem(name: string): boolean {
    return name in this.d.itemsByName;
  }
  hasBlock(name: string): boolean {
    return name in this.d.blocksByName;
  }
  /** Item names in data order (for default ordering). */
  private n(id: number): string | undefined {
    return this.idToName.get(id);
  }

  /** All raw recipe variants for `item` (wood/stone tag variants are NOT collapsed here; see rankRecipes). */
  recipes(item: string): NormRecipe[] {
    const hit = this.recipeCache.get(item);
    if (hit) return hit;
    const out: NormRecipe[] = [];
    const meta = this.d.itemsByName[item];
    const list = meta ? this.d.recipes[meta.id] : undefined;
    for (const r of list ?? []) {
      const ing: Record<string, number> = {};
      const add = (v: unknown) => {
        const id = typeof v === "number" ? v : typeof v === "object" && v !== null ? (v as { id?: number }).id : undefined;
        if (id === undefined || id < 0) return;
        const name = this.n(id);
        if (name) ing[name] = (ing[name] ?? 0) + 1;
      };
      let table = false;
      const rr = r as { inShape?: unknown[][]; ingredients?: unknown[]; result: { id: number; count: number } };
      if (rr.inShape) {
        table = rr.inShape.length > 2 || rr.inShape.some((row) => row.length > 2);
        for (const row of rr.inShape) for (const c of row) add(c);
      } else if (rr.ingredients) {
        table = rr.ingredients.length > 4;
        for (const c of rr.ingredients) add(c);
      }
      if (Object.keys(ing).length === 0) continue;
      out.push({ result: item, yield: rr.result.count || 1, ingredients: ing, table });
    }
    this.recipeCache.set(item, out);
    return out;
  }

  /** Blocks whose (silk-touch-less) drops include `item`, filtered to natural, diggable sources. */
  blocksYielding(item: string): BlockSource[] {
    const hit = this.sourceCache.get(item);
    if (hit) return hit;
    const meta = this.d.itemsByName[item];
    const out: BlockSource[] = [];
    if (meta) {
      const craftableSelf = (b: string) => this.recipes(b).length > 0;
      for (const b of this.d.blocksArray) {
        if (!b.diggable || NOT_A_SOURCE.has(b.name) || b.name.startsWith("infested_")) continue;
        // Only placeable blocks (have an item) or known crops: drops potted_*, wall_* variants, tripwire, cauldrons, cakes...
        if (!this.hasItem(b.name) && !CROP_BLOCKS.has(b.name)) continue;
        const drops = (b.drops ?? []).map((x) => {
          const v = typeof x === "number" ? x : (x as { drop: number | { id: number } }).drop;
          return typeof v === "number" ? v : v.id;
        });
        if (!drops.includes(meta.id)) continue;
        // Man-made blocks (planks, crafting tables, chests, bookshelves...): not a source.
        if (craftableSelf(b.name) && !NATURAL_OK.has(b.name)) continue;
        out.push(this.toSource(b.name, b.harvestTools));
      }
    }
    for (const c of Object.values(CROP_DROPS)) {
      if (c.item === item && !out.some((s) => s.block === c.block)) out.push(this.toSource(c.block, undefined));
    }
    this.sourceCache.set(item, out);
    return out;
  }

  private toSource(block: string, harvest: Record<string, boolean> | undefined): BlockSource {
    if (!harvest) return { block, tools: null, minTool: null };
    const tools = new Set<string>();
    for (const id of Object.keys(harvest)) {
      const n = this.n(Number(id));
      if (n) tools.add(n);
    }
    let minTool: string | null = null;
    const first = [...tools][0];
    const kind = first ? parseTool(first)?.kind : undefined;
    if (kind) for (const tier of ACQUIRE_LADDER) if (tools.has(`${tier}_${kind}`)) { minTool = `${tier}_${kind}`; break; }
    return { block, tools, minTool };
  }

  /** Mobs that drop `item` (for "not obtainable: mob drop" reasons). */
  mobsDropping(item: string): string[] {
    if (!this.lootCache) {
      this.lootCache = new Map();
      for (const [mob, loot] of Object.entries(this.d.entityLoot ?? {})) {
        for (const dr of (loot as { drops: Array<{ item: string }> }).drops) {
          const l = this.lootCache.get(dr.item) ?? [];
          l.push(mob);
          this.lootCache.set(dr.item, l);
        }
      }
    }
    return this.lootCache.get(item) ?? [];
  }
}

const books = new Map<string, RecipeBook>();
export function getRecipeBook(version = process.env.MC_VERSION || DEFAULT_MC_VERSION): RecipeBook {
  let b = books.get(version);
  if (!b) {
    b = new RecipeBook(version);
    books.set(version, b);
  }
  return b;
}
