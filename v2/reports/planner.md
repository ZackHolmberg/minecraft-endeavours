# Planner report (slice 2a)

`plan: PlanFn` in `src/planner/plan.ts`; `npx vitest run src/planner` = 37 tests pass; `npx tsc --noEmit -p .` clean (whole project, at time of check).
Eyeball: `npx tsx src/planner/cli.ts iron_pickaxe 1 --inv oak_log=3 [--near coal_ore=10,oak_log=5] [--stations table,furnace] [--chest iron_ingot=3] [--creative] [--json]` (multi-goal: `item count item count`; default view = forest + stone in view).

## Layout
- `knowledge/`: `smelting` (furnace rules + blast/smoker flags), `fuel` (burn units, extends v1 table), `tools` (tiers/kinds/acquire ladder), `ores` (1.21 Y-bands: min/max/best/search window; block dimension; crop override), `wood` (12 families), `stations`.
- `recipes.ts`: minecraft-data adapter (cached per `MC_VERSION`, default 1.21.9): normalised recipes (table iff shape >2 wide/tall, or >4 shapeless), `blocksYielding(item)` (diggable, natural, placeable-or-crop; `minTool` = cheapest ladder tool in `harvestTools`, so gold/copper quirks come from data), `mobsDropping(item)`.
- `plan.ts`: one graph node per item, two phases. A: pick method craft -> smelt -> gather (cycle + depth guarded; recipe variants ranked: owned > in view (recursive cost) > default species oak). B: demand propagation consumers-first (sum of consumption, max of held tool/goal), inventory -> chest withdraw -> method for the remainder, then steps emitted dependencies-first. Result: shared resources counted once, ceil(crafts) with leftovers, tools/stations once.

## Behaviour decisions
- Fuel: owned coal/charcoal > coal if coal ore in view > owned wood > logs in view > oak_log default. Fuel counts fold into the same log gather.
- Stations: `place_station` only if `view.stations` says none nearby; item crafted (or taken from inventory) and consumed. Furnace = 8 cobblestone + table.
- Tools: owned tool satisfies a block iff it is in that block's `harvestTools` (golden pickaxe mines stone, not iron; copper pickaxe mines iron). Otherwise acquire cheapest of wooden/stone/iron/diamond. `gather.tool` = minimum tool name.
- `searchHint`: only when no source block in `nearbyBlocks`: ores -> `underground` + `search` Y window (iron [-16,48], diamond [-64,-48], ...); everything else `surface`.
- bread: needs table (3-wide). Wheat is only gathered if `wheat` crop blocks are in view (data's wheat block drops seeds; overridden); otherwise unresolved `wheat` ("needs a farm/village crop").
- torch: coal if owned/in view; else charcoal via smelting logs if logs in view (heavy: furnace chain); else coal with underground hint.
- Unresolved reports the LEAF (e.g. `beef`, `wheat`) and the partial plan is still emitted for the rest; reasons are prefixed with `FailureKind`-style tags (`unknown_item:`, `not_obtainable:`, `no_source:`, `missing_tool:`, `station_unavailable:`).
- Creative: empty steps, summary "creative: use getItems". `maxSteps` truncates and adds an `(plan)` unresolved entry. Summary <= 200 chars.

## Known gaps
- Mob drops (string, leather, beef, gunpowder...), trading, fishing, farming, bonemeal: unresolved with a "mob drop (cow, ...)" reason. Nether/End blocks: unresolved when `dimension` mismatches (netherrack ok in the Nether); no portal/Nether routing; netherite needs smithing (no recipes in data).
- Not modelled: blast furnace/smoker/stonecutter/smithing/brewing, enchanting, dyes/wool colour cycles (wool unresolved: no shears/sheep), water/lava buckets, silk-touch, fortune.
- Variant choice is static per item (computed from the initial view), so species can't mix mid-plan; fine for practical use.
- Gathering counts items, not blocks; lossy drops (flint 10%, gravel) just mean the executor mines until the inventory delta is met.
- Item names must be exact minecraft-data names (`boat` -> unknown_item; no did-you-mean).
- Fuel for big smelts without coal is heavy (29 ingots = 20 logs); chest/containers are only used when they hold the exact item.

## Proposed contract changes (none applied)
1. `Plan.unresolved[].reason`: document the tag prefixes above so the executor can map to `FailureKind` mechanically (or add an optional `kind: FailureKind`).
2. `Step.gather`: optional `needsMature?: boolean` for crops (wheat) so the executor skips unripe blocks.
3. `WorldView.nearbyBlocks` is used for ranking by `nearest`; document that "count 0" entries are ignored.

## CLI: full iron kit from empty inventory (forest + stone + coal ore in view)
`iron_helmet iron_chestplate iron_leggings iron_boots iron_sword iron_pickaxe --near oak_log=6,stone=10,coal_ore=20` (19 steps; 29 ingots = 24 armor + 2 sword + 3 pickaxe):
```
gather oak_log 3 | craft oak_planks 12 | craft stick 8 | craft crafting_table | place crafting_table
craft wooden_pickaxe | gather cobblestone 11 (tool wooden_pickaxe; 3 stone pick + 8 furnace)
craft stone_pickaxe | gather raw_iron 29 (stone_pickaxe, underground y[-16,48]) | gather coal 4
craft furnace | place furnace | smelt raw_iron->iron_ingot 29 (coal x4)
craft iron_helmet, iron_chestplate, iron_leggings, iron_boots, iron_sword, iron_pickaxe
```
Without coal ore in view the fuel becomes `oak_log x20` and the log gather rises to 23.
