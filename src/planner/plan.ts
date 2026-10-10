/**
 * Pure goal planner (v2 slice 2). Design: v2/PLANNER.md.
 *
 * Two phases over a dependency graph with ONE node per item (so shared
 * resources are counted once, tools/stations are acquired once, and 1 log →
 * 4 planks leftovers are used by every consumer):
 *
 *  A. expand(): for each reachable item choose its production method —
 *     craft (best recipe variant) → smelt → gather — rejecting cycles and
 *     unobtainable branches. Inventory/containers are consulted in phase B
 *     (a node's method is its fallback for any shortfall).
 *  B. Demand propagation in reverse topological order (consumers first):
 *     total need = consumed-by-dependents + held (goals/tools/stations);
 *     take from inventory, then containers (withdraw), then run the method for
 *     the remainder, which adds demand on its inputs. Steps are then emitted
 *     in topological order (dependencies first).
 */
import { getRecipeBook, type NormRecipe, type RecipeBook } from "./recipes.js";
import {
  SMELT_BY_OUTPUT,
  burnUnits,
  isWoodFuel,
  oreBandForBlock,
  blockDimension,
  CROP_DROPS,
  WOOD_FAMILIES,
  isGoalTag,
  knownTagNames,
  tagMembers,
} from "./knowledge/index.js";
import type { Goal, Plan, PlanFn, PlanOptions, Step, Vec3, WorldView } from "./types.js";

const INF = Infinity;
const MAX_DEPTH = 40;
const DEFAULT_MAX_STEPS = 200;
const AVOIDED_OWNED_COST = 2;
const TABLE = "@crafting_table";
const FURNACE = "@furnace";

type SearchHint = { kind: "surface" | "underground"; yRange?: [number, number] };

type Method =
  | { t: "craft"; recipe: NormRecipe }
  | { t: "smelt"; input: string; fuel: string }
  | { t: "gather"; blocks: string[]; tool: string | null; toolHold: string | null; hint?: SearchHint }
  | { t: "place"; item: string };

interface Node {
  key: string;
  method?: Method;
  /** Station node whose station is already nearby (no work). */
  satisfied?: boolean;
  /** Method chosen only so phase B can report the unresolved leaf; not a real way to make the item. */
  partial?: boolean;
  fail?: string;
  deps: string[];
}

class Planner {
  private nodes = new Map<string, Node>();
  private costMemo = new Map<string, number>();
  private costBusy = new Set<string>();
  private cycleTo = INF;
  private containerTotals = new Map<string, number>();
  /** Block types the executor failed to reach (WorldView.avoidBlocks): treated as not in view. */
  private avoid: ReadonlySet<string>;

  constructor(
    private book: RecipeBook,
    private view: WorldView,
  ) {
    this.avoid = new Set(view.avoidBlocks ?? []);
    for (const c of view.containers) for (const [k, v] of Object.entries(c.items)) this.containerTotals.set(k, (this.containerTotals.get(k) ?? 0) + v);
  }

  // ---------------------------------------------------------------- availability

  private owned(item: string): number {
    return (this.view.inventory[item] ?? 0) + (this.containerTotals.get(item) ?? 0);
  }

  /** Lower = more readily available. 0 owned; ~1 mineable in view; +1 per crafting layer; +2 smelting; INF = nothing in reach. */
  private cost(item: string, depth = 0, ignoreOwned = false): number {
    const m = ignoreOwned ? undefined : this.costMemo.get(item);
    if (m !== undefined) return m;
    if (!ignoreOwned && this.owned(item) > 0) {
      // Held, but only obtainable from avoided blocks: a replacement is cheap to plan around, so any
      // species that is actually in view (cost ~1) beats topping this one up; still beats "nothing in reach".
      const src = this.book.blocksYielding(item);
      if (this.avoid.size > 0 && src.length > 0 && src.every((s) => this.avoid.has(s.block))) return AVOIDED_OWNED_COST;
      return 0;
    }
    if (depth > 4 || this.costBusy.has(item)) return INF;
    this.costBusy.add(item);
    let best = INF;
    for (const s of this.book.blocksYielding(item)) {
      if (this.avoid.has(s.block)) continue;
      const nb = this.view.nearbyBlocks[s.block];
      if (nb && nb.count > 0) best = Math.min(best, 1 + nb.nearest / 1000);
    }
    for (const r of this.book.recipes(item)) {
      let worst = 0;
      for (const ing of Object.keys(r.ingredients)) worst = Math.max(worst, this.cost(ing, depth + 1));
      best = Math.min(best, 1 + worst);
    }
    for (const rule of SMELT_BY_OUTPUT.get(item) ?? []) best = Math.min(best, 2 + this.cost(rule.input, depth + 1));
    this.costBusy.delete(item);
    if (depth === 0 && !ignoreOwned) this.costMemo.set(item, best);
    return best;
  }

  /** Tiebreak when nothing is owned/in view: prefer oak, cobblestone, coal. */
  private defaultIndex(item: string): number {
    let best = -1;
    let bestLen = 0;
    WOOD_FAMILIES.forEach((w, i) => {
      if ((item === w.species || item.startsWith(w.species + "_")) && w.species.length > bestLen) {
        best = i;
        bestLen = w.species.length;
      }
    });
    if (best >= 0) return best;
    const pref = ["cobblestone", "cobbled_deepslate", "blackstone", "coal", "charcoal"].indexOf(item);
    return pref >= 0 ? 20 + pref : 60;
  }

  /** Collapses tag variants: best-available variant first (owned > in view > default species). */
  private rankedRecipes(item: string): NormRecipe[] {
    const scored = this.book.recipes(item).map((r, i) => {
      let s = 0;
      for (const ing of Object.keys(r.ingredients)) {
        const c = this.cost(ing);
        s += c < INF ? c : 1000 + this.defaultIndex(ing);
        // bamboo stands in for wood in sticks/planks, but it's a poor stand-in (hard to reach in jungles, 2 per stick): last resort
        if ((ing === "bamboo" || ing === "bamboo_block") && !item.startsWith("bamboo")) s += 6;
      }
      return { r, s, i };
    });
    scored.sort((a, b) => a.s - b.s || a.i - b.i);
    return scored.map((x) => x.r);
  }

  private chooseFuel(exclude: string): string {
    const ok = (f: string) => f !== exclude;
    // A log burns 1.5 smelts but crafts into 4 planks that burn 1.5 each (6 smelts): fuel with planks.
    const planksOf = (log: string) => WOOD_FAMILIES.find((w) => w.log === log)?.planks ?? log;
    for (const f of ["coal", "charcoal", "coal_block"]) if (ok(f) && (this.view.inventory[f] ?? 0) > 0) return f;
    if (ok("coal") && this.cost("coal") < INF) return "coal";
    // owned wood, then wood in view, else default log
    const woodFuels = (names: Iterable<string>) => [...names].filter((n) => ok(n) && isWoodFuel(n) && burnUnits(n) > 0);
    const ownedWood = woodFuels([...Object.keys(this.view.inventory), ...this.containerTotals.keys()]).filter((n) => this.owned(n) > 0);
    // planks first (a log is worth 4 planks as fuel); an owned log is crafted into planks and used as planks
    ownedWood.sort((a, b) => Number(b.endsWith("_planks")) - Number(a.endsWith("_planks")) || this.defaultIndex(a) - this.defaultIndex(b));
    if (ownedWood[0]) return ownedWood[0].endsWith("_log") || ownedWood[0].endsWith("_wood") ? planksOf(ownedWood[0]) : ownedWood[0];
    const logs = WOOD_FAMILIES.filter((w) => !w.nether && w.species !== "bamboo").map((w) => w.log);
    const near = logs.filter((l) => ok(planksOf(l)) && this.cost(l) < INF).sort((a, b) => this.cost(a) - this.cost(b));
    if (near[0]) return planksOf(near[0]);
    return ok("oak_planks") ? "oak_planks" : "spruce_planks";
  }

  // ---------------------------------------------------------------- generic goals

  /**
   * Replace tag goals ("#log" x10) by concrete ones. Owned members count first (largest stack
   * first, so held items are delivered/kept as they are); any shortfall goes to the member that is
   * cheapest to obtain right now (cost: in view / craftable from what is held), ties broken by
   * owned count then the default species order. The chosen member's goal is "hold owned + shortfall".
   */
  resolveGoals(goals: Goal[]): { goals: Goal[]; bad: Plan["unresolved"] } {
    if (!goals.some((g) => isGoalTag(g.item))) return { goals, bad: [] };
    const out = new Map<string, number>();
    const bad: Plan["unresolved"] = [];
    const add = (item: string, n: number) => out.set(item, (out.get(item) ?? 0) + n);
    for (const g of goals) {
      if (!isGoalTag(g.item)) {
        add(g.item, g.count);
        continue;
      }
      const members = (tagMembers(g.item) ?? []).filter((m) => this.book.hasItem(m));
      if (members.length === 0) {
        bad.push({ item: g.item, count: g.count, reason: `unknown_item: "${g.item}" is not a known item tag (known: ${knownTagNames().join(", ")})` });
        continue;
      }
      if (!(g.count > 0)) continue;
      let remaining = Math.ceil(g.count);
      const byOwned = members.filter((m) => this.owned(m) > 0).sort((a, b) => this.owned(b) - this.owned(a) || this.defaultIndex(a) - this.defaultIndex(b));
      for (const m of byOwned) {
        if (remaining <= 0) break;
        const take = Math.min(this.owned(m), remaining);
        add(m, take);
        remaining -= take;
      }
      if (remaining > 0) {
        // cost to GET more of it (ignoring what is already held): a held species that is out of view must not beat one at hand
        const fresh = new Map(members.map((m) => [m, this.cost(m, 0, true)]));
        const best = [...members].sort((a, b) => fresh.get(a)! - fresh.get(b)! || this.owned(b) - this.owned(a) || this.defaultIndex(a) - this.defaultIndex(b))[0]!;
        add(best, remaining);
      }
    }
    return { goals: [...out.entries()].map(([item, count]) => ({ item, count })), bad };
  }

  // ---------------------------------------------------------------- phase A

  private viable(n: Node | null): boolean {
    return !!n && (!!n.satisfied || (!!n.method && !n.partial) || this.owned(n.key) > 0);
  }

  private expandStation(block: "crafting_table" | "furnace", stack: string[]): Node | null {
    const key = block === "crafting_table" ? TABLE : FURNACE;
    const hit = this.nodes.get(key);
    if (hit) return hit;
    const node: Node = { key, deps: [] };
    if (this.view.stations[block]) {
      node.satisfied = true;
    } else {
      const child = this.expand(block, stack);
      if (!child) return null; // cycle
      if (this.viable(child)) {
        node.method = { t: "place", item: block };
        node.deps = [block];
      } else node.fail = `station_unavailable: cannot obtain a ${block} (${child.fail ?? "no source"})`;
    }
    this.nodes.set(key, node);
    return node;
  }

  /** Returns null when `item` is already on the stack (cycle). */
  private expand(item: string, stack: string[]): Node | null {
    const memo = this.nodes.get(item);
    if (memo) return memo;
    const at = stack.indexOf(item);
    if (at >= 0) {
      this.cycleTo = Math.min(this.cycleTo, at);
      return null;
    }
    const node: Node = { key: item, deps: [] };
    if (!this.book.hasItem(item)) {
      node.fail = `unknown_item: "${item}" is not a Minecraft item name`;
      this.nodes.set(item, node);
      return node;
    }
    if (stack.length >= MAX_DEPTH) {
      node.fail = "not_obtainable: dependency chain too deep";
      return node;
    }
    const myIndex = stack.length;
    const outer = this.cycleTo;
    this.cycleTo = INF;
    stack.push(item);

    const failures: string[] = [];
    let partial: NormRecipe | null = null;
    let partialSmelt: string | null = null;
    // 1. craft
    for (const r of this.rankedRecipes(item)) {
      const deps: string[] = [];
      let bad: string | null = null;
      for (const ing of Object.keys(r.ingredients)) {
        const c = this.expand(ing, stack);
        if (!c) { bad = `${ing} (cycle)`; break; }
        if (!this.viable(c)) { bad = `${ing}: ${c.fail ?? "no source"}`; break; }
        deps.push(ing);
      }
      if (!bad && r.table) {
        const st = this.expandStation("crafting_table", stack);
        if (!this.viable(st)) bad = `crafting_table: ${st?.fail ?? "cycle"}`;
        else deps.push(TABLE);
      }
      if (bad) {
        if (failures.length < 1) failures.push(`cannot craft ${item}, needs ${bad}`);
        if (!partial && !bad.endsWith("(cycle)")) partial = r;
        continue;
      }
      node.method = { t: "craft", recipe: r };
      node.deps = deps;
      break;
    }
    // 2. smelt
    if (!node.method) {
      const rules = [...(SMELT_BY_OUTPUT.get(item) ?? [])].sort((a, b) => this.cost(a.input) - this.cost(b.input));
      for (const rule of rules) {
        const inp = this.expand(rule.input, stack);
        if (!this.viable(inp)) {
          failures.push(`cannot smelt ${rule.input}: ${inp?.fail ?? "cycle"}`);
          if (inp && !partialSmelt) partialSmelt = rule.input;
          continue;
        }
        const fuel = this.chooseFuel(item);
        const fn = this.expand(fuel, stack);
        if (!this.viable(fn)) { failures.push(`no fuel (${fuel}: ${fn?.fail ?? "cycle"})`); continue; }
        const fur = this.expandStation("furnace", stack);
        if (!this.viable(fur)) { failures.push(`furnace: ${fur?.fail ?? "cycle"}`); continue; }
        node.method = { t: "smelt", input: rule.input, fuel };
        node.deps = [rule.input, fuel, FURNACE];
        break;
      }
    }
    // 3. gather
    if (!node.method) {
      const g = this.planGather(item, stack);
      if (g.method) {
        node.method = g.method;
        node.deps = g.method.toolHold ? [g.method.toolHold] : [];
      } else if (g.fail) failures.push(g.fail);
    }
    if (!node.method) {
      // Prefer a specific non-craft reason (e.g. "wheat needs a farm") over the craft chain.
      node.fail = failures.find((f) => !f.startsWith("cannot craft")) ?? failures[0] ?? this.noSourceReason(item);
      if (partialSmelt && this.book.mobsDropping(item).length === 0) {
        const fuel = this.chooseFuel(item);
        this.expand(fuel, stack);
        this.expandStation("furnace", stack);
        node.method = { t: "smelt", input: partialSmelt, fuel };
        node.partial = true;
        node.deps = [partialSmelt, fuel, FURNACE];
      } else if (partial && failures.every((f) => f.startsWith("cannot craft")) && this.book.mobsDropping(item).length === 0) {
        // keep the best recipe so phase B reports the missing LEAF (e.g. wheat) rather than the parent
        for (const ing of Object.keys(partial.ingredients)) this.expand(ing, stack);
        node.method = { t: "craft", recipe: partial };
        node.partial = true;
        node.deps = Object.keys(partial.ingredients);
        if (partial.table && this.viable(this.expandStation("crafting_table", stack))) node.deps.push(TABLE);
      }
    }

    stack.pop();
    const tainted = this.cycleTo < myIndex;
    this.cycleTo = Math.min(outer, tainted ? this.cycleTo : INF);
    if (!tainted) this.nodes.set(item, node);
    else node.fail = node.fail ?? "cycle";
    return node;
  }

  private noSourceReason(item: string): string {
    const mobs = this.book.mobsDropping(item);
    if (mobs.length) return `not_obtainable: ${item} is a mob drop (${mobs.slice(0, 3).join(", ")}); mob hunting not supported`;
    return `not_obtainable: no known way to get ${item} (not craftable, smeltable or minable)`;
  }

  private planGather(item: string, stack: string[]): { method?: Extract<Method, { t: "gather" }>; fail: string } {
    const inView = (b: string) => !this.avoid.has(b) && (this.view.nearbyBlocks[b]?.count ?? 0) > 0;
    const dist = (b: string) => this.view.nearbyBlocks[b]?.nearest ?? INF;
    const all = this.book.blocksYielding(item);
    if (all.length === 0) return { fail: "" };
    // crops (wheat): only with a standing crop in view
    const crop = CROP_DROPS[item];
    if (crop && !inView(crop.block)) {
      return { fail: `no_source: ${item} needs a farm/village crop (no ${crop.block} in view)` };
    }
    let allowed = all.filter((s) => blockDimension(s.block) === this.view.dimension || inView(s.block));
    if (allowed.length === 0) {
      return { fail: `not_obtainable: ${item} only generates in ${blockDimension(all[0]!.block)} (not supported)` };
    }
    // avoided (unreachable) sources only as a last resort
    const usable = allowed.filter((s) => !this.avoid.has(s.block));
    if (usable.length > 0) allowed = usable;
    allowed.sort((a, b) => dist(a.block) - dist(b.block));
    const base = allowed.some((s) => inView(s.block)) ? allowed.filter((s) => inView(s.block)) : allowed;
    const rank = (t: string | null) => (t === null ? -1 : this.toolRank(t));
    const levels = [...new Set(base.map((s) => s.minTool))].sort((a, b) => rank(a) - rank(b));
    let lastFail = `no_source: no tool available to mine ${item}`;
    for (const level of levels) {
      const chosen = allowed.filter((s) => rank(s.minTool) <= rank(level));
      const ownedOk = chosen.every((s) => s.tools === null || [...s.tools].some((t) => (this.view.inventory[t] ?? 0) > 0));
      let toolHold: string | null = null;
      if (!ownedOk && level !== null) {
        const tn = this.expand(level, stack);
        if (!this.viable(tn)) { lastFail = `missing_tool: ${level} (${tn?.fail ?? "cycle"})`; continue; }
        toolHold = level;
      } else if (!ownedOk) continue;
      const blocks = chosen.map((s) => s.block);
      let hint: SearchHint | undefined;
      if (!blocks.some(inView)) {
        const band = blocks.map(oreBandForBlock).find(Boolean);
        hint = band ? { kind: "underground", yRange: [...band.search] as [number, number] } : { kind: "surface" };
      }
      return { method: { t: "gather", blocks, tool: level, toolHold, ...(hint ? { hint } : {}) }, fail: "" };
    }
    return { fail: lastFail };
  }

  private toolRank(tool: string): number {
    const tier = tool.slice(0, tool.lastIndexOf("_"));
    return ["wooden", "stone", "iron", "diamond", "netherite"].indexOf(tier);
  }

  // ---------------------------------------------------------------- phase B

  run(goals: Goal[], opts?: PlanOptions): Plan {
    const maxSteps = opts?.maxSteps ?? DEFAULT_MAX_STEPS;
    const unresolved: Plan["unresolved"] = [];
    const goalHold = new Map<string, number>();
    for (const g of goals) {
      if (!(g.count > 0)) continue;
      goalHold.set(g.item, (goalHold.get(g.item) ?? 0) + Math.ceil(g.count));
    }
    for (const item of goalHold.keys()) this.expand(item, []);

    // topological postorder (dependencies first)
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (k: string) => {
      if (seen.has(k)) return;
      seen.add(k);
      const n = this.nodes.get(k);
      if (!n) return;
      for (const d of n.deps) visit(d);
      order.push(k);
    };
    for (const item of goalHold.keys()) visit(item);

    const consumed = new Map<string, number>();
    const toolHold = new Map<string, number>();
    const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
    const hold = (k: string) => Math.max(goalHold.get(k) ?? 0, toolHold.get(k) ?? 0);
    const stepsByNode = new Map<string, Step[]>();
    const emit = (k: string, s: Step) => {
      const l = stepsByNode.get(k) ?? [];
      l.push(s);
      stepsByNode.set(k, l);
    };

    for (const key of [...order].reverse()) {
      const node = this.nodes.get(key)!;
      const total = (consumed.get(key) ?? 0) + hold(key);
      if (total <= 0) continue;

      if (key.startsWith("@")) {
        if (node.satisfied) continue;
        if (node.method?.t === "place") {
          add(consumed, node.method.item, 1);
          emit(key, { op: "place_station", block: key.slice(1) as "crafting_table" | "furnace" });
        } else {
          unresolved.push({ item: key.slice(1), count: 1, reason: node.fail ?? "station unavailable" });
        }
        continue;
      }

      let rem = total - Math.min(this.view.inventory[key] ?? 0, total);
      if (rem > 0) {
        const pos = this.view.position;
        const sorted = [...this.view.containers].sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos));
        for (const c of sorted) {
          const have = c.items[key] ?? 0;
          if (have <= 0 || rem <= 0) continue;
          const take = Math.min(have, rem);
          emit(key, { op: "withdraw", item: key, count: take, from: c.pos });
          rem -= take;
        }
      }
      if (rem <= 0) continue;

      const m = node.method;
      if (!m) {
        unresolved.push({ item: key, count: rem, reason: node.fail ?? this.noSourceReason(key) });
        continue;
      }
      if (m.t === "craft") {
        const crafts = Math.ceil(rem / m.recipe.yield);
        for (const [ing, n] of Object.entries(m.recipe.ingredients)) add(consumed, ing, n * crafts);
        if (m.recipe.table) toolHold.set(TABLE, 1);
        emit(key, { op: "craft", item: key, count: crafts * m.recipe.yield, crafts, table: m.recipe.table });
      } else if (m.t === "smelt") {
        const fuelCount = Math.ceil(rem / burnUnits(m.fuel) - 1e-9);
        add(consumed, m.input, rem);
        add(consumed, m.fuel, fuelCount);
        toolHold.set(FURNACE, 1);
        emit(key, { op: "smelt", input: m.input, output: key, count: rem, fuel: m.fuel, fuelCount });
      } else if (m.t === "gather") {
        if (m.toolHold) toolHold.set(m.toolHold, Math.max(toolHold.get(m.toolHold) ?? 0, 1));
        emit(key, { op: "gather", item: key, count: rem, blocks: m.blocks, tool: m.tool, ...(m.hint ? { searchHint: m.hint } : {}) });
      }
    }

    // emit in dependency order
    let steps: Step[] = [];
    for (const key of order) steps.push(...(stepsByNode.get(key) ?? []));
    steps = mergeSteps(steps);

    const rawNeeds: Record<string, number> = {};
    for (const s of steps) if (s.op === "gather" || s.op === "withdraw") rawNeeds[s.item] = (rawNeeds[s.item] ?? 0) + s.count;

    if (steps.length > maxSteps) {
      unresolved.push({ item: "(plan)", count: 0, reason: `plan too deep: ${steps.length} steps exceeds limit ${maxSteps}` });
      steps = steps.slice(0, maxSteps);
    }
    const goalList = goals.filter((g) => g.count > 0);
    return { goals: goalList, steps, rawNeeds, unresolved, summary: summarize(steps, unresolved) };
  }
}

function d2(a: Vec3, b: Vec3): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

function mergeSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    const p = out[out.length - 1];
    if (p && s.op === "craft" && p.op === "craft" && p.item === s.item && p.table === s.table) {
      p.count += s.count;
      p.crafts += s.crafts;
    } else if (p && s.op === "gather" && p.op === "gather" && p.item === s.item && p.tool === s.tool) {
      p.count += s.count;
    } else out.push({ ...s });
  }
  return out;
}

function describe(s: Step): string {
  switch (s.op) {
    case "withdraw": return `withdraw ${s.count} ${s.item}`;
    case "gather": return `gather ${s.count} ${s.item}`;
    case "craft": return `craft ${s.count} ${s.item}`;
    case "smelt": return `smelt ${s.count} ${s.input}`;
    case "place_station": return `place ${s.block}`;
  }
}

function summarize(steps: Step[], unresolved: Plan["unresolved"]): string {
  const MAX = 200;
  const tail = `(${steps.length} steps)` + (unresolved.length ? ` UNRESOLVED: ${unresolved.map((u) => `${u.count} ${u.item}`).join(", ")}` : "");
  if (steps.length === 0) return unresolved.length ? `no plan ${tail}` : "nothing to do (already satisfied)";
  const parts: string[] = [];
  let len = tail.length + 1;
  for (const s of steps) {
    const d = describe(s);
    const add = d.length + 3;
    if (len + add > MAX - 4) {
      parts.push("…");
      break;
    }
    parts.push(d);
    len += add;
  }
  return `${parts.join(" → ")} ${tail}`.slice(0, MAX);
}

export const plan: PlanFn = (goals, view, opts) => {
  const planner = new Planner(getRecipeBook(), view);
  const resolved = planner.resolveGoals(goals);
  if (view.gameMode === "creative") {
    return { goals: resolved.goals, steps: [], rawNeeds: {}, unresolved: resolved.bad, summary: "creative: use getItems" };
  }
  const result = planner.run(resolved.goals, opts);
  if (resolved.bad.length === 0) return result;
  const unresolved = [...resolved.bad, ...result.unresolved];
  return { ...result, unresolved, summary: summarize(result.steps, unresolved) };
};
