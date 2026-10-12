# Jobs, planner & builder

Reference for v2's execution layer: the goal planner (`src/planner/`), the job runner and step executors (`src/jobs/`), and the blueprint builder (`src/build/`). Architecture context: [ARCHITECTURE.md](ARCHITECTURE.md) *Jobs*. Tool params/messages: [SKILLS.md](SKILLS.md). History: [v2/DECISIONS.md](v2/DECISIONS.md) D9, D10, D14, D15; [v2/PLANNER.md](v2/PLANNER.md) is the original design note.

## Lifecycle

```
Haiku task ── achieve | build | followPlayer | surviveNight ──► JobRunner.start*  (plans/prepares, persists job.json, returns at once)
                                                                      │  background loop, one active job per bot
                                                       steps ─► postcondition ─► (fail ─► recovery ladder) ─► next step
                                                                      ▼
                          job_end ─► formatJobEvent ─► NpcAgent.pushJobEvent ─► fresh Haiku task ("[job finished] …" / "[job failed] …")
```

- **One active job per bot.** Starting a job replaces the running one. A running job is shown to every new task as `# Current job` (goals, progress, requester); an ended one for 2 min.
- **Job statuses:** `running done failed cancelled interrupted`. `cancelled` (player stop, `cancelJob`, replacement, death) and `interrupted` (disconnect, orchestrator restart) queue **no** event; `done`/`failed` do.
- **Persistence:** `data/orchestrator/memory/<bot>/job.json`. On boot a `running` job becomes `interrupted`; it is never auto-resumed. Scaffold blocks a crashed build left are reclaimed ~5 s after spawn.
- **Caps:** job 30 min (`JOB_MAX_MS`, one deadline across a build's phases); follow 30 min; per-step timeouts below. A cancel waits <=35 s for the in-flight step.
- **Auto-cancel:** any Haiku tool call outside the exempt set cancels the running job first and prefixes the result "your running job ... was cancelled". Exempt: `say whisper observeSurroundings checkInventory remember setTaskQueue advanceTaskQueue achieve build surviveNight cancelJob`.
- **Hooking:** `jobs/wire.ts` builds the runner for a connection (deps: world view, executors, explorer, relocator, build/deliver/follow/night deps, persistence, telemetry, ledger callbacks, the cancellation subscription) and registers the job-requester routing probe. It imports the agent; nothing else under `jobs/` may. An unwired dep (e.g. `night`) is only caught live: no wire-level test exists.

### Job event texts (`describe.ts`)
- achieve done: `[job finished] achieve iron_pickaxe x1 — done in 4m12s (requested by Alex — tell them). The items are in your inventory (crafted, not placed)...` (the note stops Haiku claiming it placed something).
- build done: `... — done in 26s, 57/57 blocks placed`; night: `survived the night — <detail>`; deliver: `handed over in ...`.
- failed: `[job failed] <goals> — failure: <kind> — <detail>; remaining plan: a → b → ...` (builds omit the plan). Follow: see below.

## Planner (`src/planner/`, pure, no bot)

`plan(goals, view, {maxSteps = 200}) → Plan { goals, steps, rawNeeds, unresolved[], summary }`. CLI for eyeballing: `npx tsx src/planner/cli.ts iron_pickaxe 1 --inv oak_log=3 --near coal_ore=10,oak_log=5 [--stations table,furnace] [--chest iron_ingot=3] [--creative] [--json]`.

**Goal:** `{ item, count }` = end up holding at least `count`. **Tags** (`knowledge/tags.ts`): `#log` (overworld logs, not bamboo), `#planks`, `#wool` (needs sheep: unplannable unless held), `#stone_tool_material` (cobblestone / cobbled_deepslate / blackstone), `#coal` (coal/charcoal), `#sand`. `Planner.resolveGoals` resolves a tag first from held members (largest stack first), then the member cheapest to *get* now (in view, craftable from what's held; avoided blocks excluded; ties: owned, then default species order). `Plan.goals` is always concrete; the runner keeps the asked tags as `Job.generic` and re-plans from them (species re-chosen each time); `Job.goals` is the latest concrete resolution (what `deliverTo` hands over).

**WorldView** (`planner/types.ts`, built by `jobs/world-view.ts`, ~0.7-1.4 s per build, at start and each re-plan): inventory incl. armor/offhand, `gameMode`, `nearbyBlocks` {type: {count, nearest}} (per-type `findBlocks` over logs/stone/ores/sand/gravel + blocks of a first-pass plan; radius 48, 96/160 when widened; logs carry the felling score, unfellable species +60), `stations` (<=32 blocks), `containers` (from `world.json`), `position`, `dimension`, `avoidBlocks`, optional `sightings` (unused).

**Resolution order for `have(item, n)`, first viable source wins:** inventory -> known container (withdraw) -> craft (recurse on ingredients) -> smelt (recurse on input + fuel + furnace) -> gather (blocks whose drops yield it; recurse on the minimum tool) -> `unresolved`. Phase A picks a method per item node (cycle/depth guarded; recipe variants ranked owned > in view (recursive cost) > default species oak); phase B propagates demand consumers-first (sum of consumption, max of held tool/goal), then emits steps dependencies-first. Shared resources are counted once; crafts are `ceil` with leftovers tracked; tools/stations are acquired once; an owned higher-tier tool satisfies lower requirements.

**Behaviour rules worth knowing**
- Tools: owned tool satisfies a block iff it is in that block's `harvestTools` (golden mines like wood; copper like stone). Otherwise acquire the cheapest of wooden -> stone -> iron -> diamond -> netherite (gold/copper only if already owned). `gather.tool` = minimum tool name.
- Stations: `place_station` only if `view.stations` says none nearby; furnace = 8 cobblestone + table.
- Fuel (`chooseFuel`): owned coal/charcoal > coal if coal ore in view > owned planks/wood > logs in view > oak_log default; planks beat logs per smelt-count (1 log = 4 planks = 6 smelts). Fuel gathers fold into the log gather.
- `searchHint` (`{kind: "surface"|"underground", yRange}`) is set only when no source is in `nearbyBlocks`: ores get `underground` + the `ORE_BANDS` search window (coal 48-112, iron -16..48, copper 32-64, gold -48..-8, diamond/redstone -64..-48, lapis -16..16, emerald 100-236); everything else `surface`.
- Variants: bamboo is penalised for sticks/planks (+6); static per item, so species can't mix within a plan. Avoided blocks (`avoidBlocks`) count as not in view and are used only if nothing else can supply the item; held logs of an avoided species cost 2.
- bread needs a table; wheat is gathered only if mature `wheat` crop blocks are in view, else unresolved ("needs a farm"). torch: coal (owned/in view) else charcoal via smelting logs else coal with an underground hint.
- Creative: empty steps, summary "creative: use getItems".
- **Unresolved** reasons are tagged `unknown_item: not_obtainable: no_source: missing_tool: station_unavailable:` (`kindFromUnresolved` maps them to `FailureKind`). `achieve` refuses to start on any unresolved leaf; the rest of the partial plan is still reported.
- **Not modelled:** mob drops (string, leather, beef, gunpowder), trading, fishing, farming/bonemeal, blast furnace/smoker/stonecutter/smithing/brewing, enchanting, dye cycles, buckets, silk touch/fortune, Nether/End routing (blocks of another dimension are unresolved), netherite. Item names must be exact minecraft-data names (the `achieve` tool adds did-you-mean).
- Knowledge tables (`knowledge/`): `smelting` (furnace rules), `fuel` (burn units; coal 8, wood 1.5, ...), `tools` (tiers, ladder), `ores` (1.21 Y-bands, block dimension, crop override), `wood` (12 families), `stations`, `tags`. `recipes.ts` is the minecraft-data adapter (cached per `MC_VERSION`; a recipe needs a table iff its shape is wider/taller than 2 or has >4 shapeless inputs).

## Job kinds

| Kind | Started by | Fields | Ends |
|---|---|---|---|
| `achieve` | `achieve({goals, deliverTo?})` | `goals`, `generic?`, `plan`, `stepIndex`, `replans`, `deliverTo?` | goals met (verified by a fresh re-plan returning empty), failure, cancel |
| `build` | `build(...)`, `surviveNight(...)` | `build: BuildState` (blueprint, params, anchor, origin/facing, phase `materials|building|holding`, placed/total, `hold?: "night"`, `holdMode`, `pocket?`) | blueprint verified, failure, cancel |
| `follow` | `followPlayer` | `follow: {player, dist}` | stop, cancel, replacement, non-exempt tool, failure, 30-min cap |

Common: `id`, `status`, `requestedBy` (conversation partner), `startedAt/endedAt`, `progress` (one-liner for the context), `failure`, `exhausted`, `relocations`, `scaffolds[]`.

`achieve` refusals (returned as `ok:false`, no job): creative without `deliverTo`; `deliverTo` player not in sight; unknown item/tag (with did-you-mean); operator item with `deliverTo` (denylist, see SKILLS `getItems`); goal-ledger refusal; unresolved plan; goals already satisfied. Hand-over amounts are clamped to 2 stacks (4 for unstackables) with a note.

## Step executors (`jobs/steps/`)

Each executes one planner step through the v1 skill via `runSkill` (telemetry, cancel reset, current tool, action log), checks a **postcondition against a baseline captured once per episode** (retries after partial progress don't overshoot), and maps the skill's message to a `FailureKind` (`classify.ts`, regexes over real skill messages; specific causes first).

| Step | Skill | Postcondition | Timeout |
|---|---|---|---|
| `gather` | `mineBlocks` (natural source blocks first: `stone` before `cobblestone`), loops while it gains items, <=4 attempts, caps 128/call | inventory count of `item` >= baseline + count | `min(15 min, 4 min + 20 s x count)` |
| `craft` | `craft` (finds/places its own table for 3x3) | inventory delta (`settleCount` waits <=3 s for the lagging client) | 2 min |
| `smelt` | `smelt` (chunks to 64; checks `furnace.fuel > 0`) | output delta | `60 s + 12 s x count` |
| `withdraw` | `withdrawFromChest` | inventory delta | 2 min |
| `place_station` | `placeBlock` near the work area | block present in the world | 1 min |
| `build` phases | `Builder` (`steps/build.ts`) | blueprint cells match the world | 14 min per attempt, <=3 attempts |
| `deliver` | `giveItemsTo` (+ `getItems` in creative) | see Hand-over | 2 min |

A timeout first stops cooperatively, then abandons a skill that ignores it after 20 s. A gather reporting positions it gave up on (`state.unreachablePositions`) feeds the exhausted-area memory.

## FailureKinds

| Kind | Meaning | Typical source |
|---|---|---|
| `no_source` | nothing to gather/withdraw in range | "no X within N blocks" |
| `unreachable` | seen but no path / drops unpickable / dig failed | gather, follow lost/stuck, hand-over |
| `missing_tool` | tool needed, not obtainable | "no pickaxe in inventory", lost tool |
| `missing_input` | craft/smelt inputs absent (plan drifted) | postcondition miss |
| `station_unavailable` | can't find/place table or furnace | craft/smelt |
| `inventory_full` | no fix by recovery | gather |
| `cancelled` / `died` | player stop, replacement / death | recovery `cancel` rung |
| `timeout` | step or job cap | runner |
| `hostile` | aborted for danger | melee guard |
| `no_site` | no suitable level natural spot near the requester | build `prepare` |
| `build_incomplete` | some blueprint blocks could not be placed | build |
| `unknown_item` / `not_obtainable` | name not in minecraft-data / no planner source | planner (no recovery) |
| `internal` | bug/exception | any |

## Recovery ladder (`recovery.ts`, pure `decideRecovery`)

Per step **episode** (keyed by `op|item|count|blocks`): `fails`, `radiusIdx`, `retried`, `replanned`, `explores`, `baseline`. Decision order for a failure:

1. `cancelled`/`died` -> `cancel`. `unknown_item not_obtainable inventory_full` -> `fail` immediately.
2. `no_source`: gather with no `searchHint` -> re-plan once (stale view); else **widen** the scan (`SCAN_RADII` 64 -> 96 -> 160); then **explore** (<=`MAX_EXPLORES` 2) if a hint exists; else fail ("no X within R blocks after exploring"). Non-gather: re-plan once, else fail.
3. `unreachable` gather with >= `RELOCATE_MIN_POSITIONS` (3) dead positions and not a log step, relocations left (`MAX_RELOCATIONS` 2/job) -> **relocate**.
4. `unreachable` gather with `failure.avoid` (block types) -> **re-plan now** with them in `WorldView.avoidBlocks` (another species/source). Avoid lists accumulate per job.
5. Transient (`unreachable timeout internal hostile station_unavailable`) first time -> **retry** once.
6. `unreachable` gather after a re-plan with a hint -> explore.
7. `unreachable missing_tool missing_input station_unavailable` -> **re-plan** from the live inventory (once per episode, `MAX_REPLANS` 5/job).
8. Otherwise `fail` with the failure + remaining plan.

**Exhausted areas** (`exhausted.ts`, persisted): positions a gather gave up on plus one circular region (centroid, radius +24, vertical band +-20) per failure; later gathers/scans skip everything matching inside, and after a write-off ore touching water/lava is shunned (`withDryOres`).
**Relocate** (`explore.ts` `rankRelocations` + `Explorer.relocate`): 16 bearings x 56/72/90 blocks, dropping wet/lava/unloaded/excluded/beyond 250 from the start; scores dry path, away from the exhausted area, ~64 blocks, level; hops of 20, next bearing when blocked, stops early once an un-excluded target is within 32 and >= 48 blocks out; 4-min box, no return trip. Then the runner re-plans from the new spot.
**Explore** (hand-rolled digging, per-cell checks: natural whitelist, no water/lava in any of 6 neighbours, structure guard, solid non-magma floor, no pits; no torches; only digs down): surface = square spiral legs 40,40,80,80,120,120 in 20-block hops with re-scan (<=6 legs, 6 min); underground = 3-cell staircase (never straight down) to the hint window's mid Y, then a rake of 2-high tunnels (24 long, 3 apart), re-scan every 3 cells within 10 blocks (<=140 cells, 10 min).

## Loop guards

- `GoalFailureLedger`: the same goal set (tags included) failing `LEDGER_MAX_FAILURES` 2 times within 30 min makes `achieve` refuse ("not started: this same goal already failed ... tell the player what's blocking, ask for help") until a player speaks. A success wipes it; a failed hand-over (`unreachable`) is not a goal failure. Follow and build jobs are not goal-keyed.
- `BuildFailureLedger`: failures per blueprint + place (within 16 blocks of anchor/origin): two in 30 min refuse the build; unfinished structures (placed < total, 2 h TTL) are remembered so the next `build` **resumes onto them** (stored origin/facing/params); a player's chat clears failure counts but keeps the structures.
- `JobEventLimiter`: <=3 synthetic job events per 10 min (a dropped event is logged).
- Reservations: `planReservations` reserves step outputs, every ingredient of every recipe variant, smelt input/fuel, raw needs, goals (and a build's materials/tools) for the job; set at start and each re-plan, cleared at finish. `pickFiller` (escape pillaring) skips reserved items and prefers dirt/netherrack/cobbled_deepslate/andesite/diorite/granite/tuff before cobblestone/stone/blackstone.

## Builder (`src/build/` pure + `jobs/steps/build.ts`)

**Blueprints** (relative cells; `y=0` standing level, `y=-1` ground; rotated to `facing` = door side toward the anchor):

| Blueprint | Params (clamped) | Geometry |
|---|---|---|
| `house` | `width` 5-9 (5), `depth` 5-9 (5), `height` 3-4 (3; rows incl. roof, so 3 = 2-high interior), `wall` (default: planks held, else oak), `roof` (= wall), `floor?`, `door` (true), `windows` 0-8 (2, glass only if held) | ring walls, door gap with the door placed last, flat full-footprint roof |
| `portal` | none | 4x5 frame, corners omitted = 10 obsidian, then ignite (needs `flint_and_steel`) |
| `farm` | `size` 3-9 (5); `water` decided by the site | till all cells, centre `water` (needs bucket) or existing water within 4 of every cell, `plant` seeds (>= min(9, cells), cap 9 seeds); needs a hoe + seeds |
| `shelter` (internal, `surviveNight` hut) | `wall` (dirt), `door` (false) | `house` geometry fixed at 5x5 (3x3 interior), 2 high, full roof, no windows; no door = the 2-high doorway is plugged with 2 wall blocks from inside |

**Pipeline** (`prepare` -> `runBuildJob`): `findSite` (radius 20; nearest footprint to the anchor = requester else bot; natural ground level within 1 (farm exact/tillable); only replaceables above (cleared); 1-block foundation; no crafted block in the margin ring; requester never within footprint+1; trees are obstacles) -> materials (consumed items, hoe/door substitutes, glass skipped without stock; the gap goes through the normal planner/ladder **inside the same job**; creative: `getItems`) -> `Builder`: clear replaceables, acquire scaffold dirt itself (`selfSupply`), place bottom-up nearest-first (`planOrder`; unsupported cells get a scaffold chain <=3, never inside blueprint/`clear` cells, removed as soon as unneeded; the portal needs one reusable block), survival pre-positions on `standSpots` (reach 4.0, never inside a cell to fill), `stepOutside` leaves through the gap before the door, door last, then till/water/plant/ignite -> `judge` = blueprint cells matching the world (the door's upper half is invisible to the client: counted as done). Up to 3 attempts (each resumes, skipping finished cells); site re-picked once after gathering, fixed once placing starts. A placement the server refuses is only retried by the next attempt (a benchmark build ended 80/82; see ROADMAP). Telemetry step ops `clear layer scaffold light build`; `job_end.placed/total`.
**Failure texts:** `no_site` ("no spot for the house: <reason>. Ask the player where, or try another area."), `build_incomplete`, ledger refusals as above.
**Reflex coexistence:** the Builder owns its hands; `melee-guard.ts` fights a mob within 3.4 blocks between actions; `build` is in the swing reflex's skip list.

### Hand-over (`deliverTo`, `steps/deliver.ts`)
After the goals are met (or already held; creative: `getItems` first), `giveItemsTo` walks to the player and tosses. The postcondition is read from the world: inventory fell by the goal counts AND the item entities **this toss created** (tracked by entity id) were picked up (`playerCollect`, or vanishing near the player within 10 s) AND nothing came back. The player must be in sight; the message reports which evidence held. Operator items are refused.

## Follow job (`followPlayer`)

`followPlayer` starts a `follow` job and returns, so chat during the follow gets its own fresh Haiku task (`say`/`whisper` are exempt) and the follow keeps running. Executor `steps/follow.ts`: 250 ms loop, dynamic `GoalFollow` (re-issued after a reflex such as surfacing drops it), idle look at the player; same Movements as `goTo`; runs **outside `runSkill`** (no current-tool slot) so auto-eat/defend/surfacing see an idle bot. Pure `FollowTracker` (`follow.ts`): entity gone but `bot.players[name]` present -> after a 1 s debounce walk to the last known position, then 8 and 20 blocks ahead along their last heading (3 s window); back in view -> follow again. Fails (`[job failed]`, kind `unreachable`) after 45 s without re-acquisition, 3 s after the player left the list, or 40 s visible-but-not-closer (no path). Defaults: `dist` 3 (1-16). Ends `done` after 30 min (`[job finished] ... (time limit)`). The requester's un-named chat routes to the bot (`job-requester`); `# Current job` shows `following <player> (Ns)`. Without a runner (legacy backends) the old blocking skill runs.

## Night job (`surviveNight({useBed?, shelter?})`)

A `build` job with `hold: "night"`. Refuses in creative, and by day (needs time in [10500, 23500); the refusal text says night starts ~12500). Order (`holdMode`): **bed** (a bed within 32 blocks or carried, unless `useBed:false`) -> `sleepIn`, re-sleeps if woken (<=3 tries), waits for dawn; else **pocket** (`pocket.ts` `choosePocket`, started within ~1 s: `down` = dig 3 straight down (1x2 room, top dug cell is the lid) or `hill` = 2 deep into a slope (4 cells, 2-block plug); natural diggable blocks only, no ore, no sand/gravel in or above a dug cell, no water/lava within 2, no crafted block within 3, every wall/floor/roof of the resting cell solid; cheapest by dig seconds + walk; the dig must yield enough dirt/cobble to seal, or filler is carried) -> centre on the column, dig from inside out (melee guard between digs), refill the lid from inside, wait until time >= 23500 with defend/eat live, at dawn dig the lid and `pillarUpBy(3)` out (or reopen the plug); else **hut** (`shelter` blueprint, 57 blocks: 30 wall + 25 roof + 2 plug; wall = cobblestone/dirt/planks held >= 57, else dirt dug by hand; built beside the requester by the normal Builder, then enter, close the door/plug, torch in a back corner if carried, wait, leave). `shelter:"hut"` skips the pocket; a failed dig-in fails the job with that hint. Hold waits run **outside any tracked skill** so reflexes stay live; hold timeout 18 min. Reflex support: at night, idle, hostile within 6 -> equip best sword/axe (`armTick`). Event: `[job finished] survived the night — <detail>`.

## Caveats / known gaps
- Mob drops, farming loops, Nether, trading are unplannable (job refuses with a reason). Planner knows nothing about enchanting/brewing.
- Explore has no torches, only digs down, ignores ore exposure, and ignores world-memory sightings. Hillside pocket, hut-after-failed-pocket, bed sleep and stone-ground pockets without a pickaxe are sim-tested only (see ROADMAP).
- Builds: flat roof only, no interior light, plain glass windows, no farm fence/harvest; portal needs 10 obsidian + flint and steel; farm centre water needs a bucket; site radius 20, slope <=1, trees never cleared; `deliverTo` infers pick-up from entities vanishing.
- A gather takes a tree's reachable bottom logs only (jungle canopy unreachable by design; no climbing/towering).
- `skill` telemetry from job steps can land in an overlapping Haiku task's counters; Haiku read-only tools can blank the dashboard's DOING line while a step runs.
