# Slice 2c-B: explore-elsewhere recovery + night survival (branch `v2-build`, worktree `../mcv2-build`)

Status: A (t2.coal) PASSES live 2/2; B (t3.survive_night) built, offline-verified, NOT passing live (3 evals used). Not committed.
Checks: `tsc`, `tsc -p src/web/ui`, `vitest` (19 files, 287 tests) and the 4 `__checks__` stubs all exit 0.

## A. Explore elsewhere (t2.coal)
- `src/jobs/exhausted.ts` (pure): per-job memory `job.exhausted = { positions[], regions[{x,z,r,y,dy}] }` (persisted in job.json). A region = centroid of the unreachable blocks + 24, vertical band +-20 (so a deepslate seam far below is still allowed). `excludeFor()` gives the predicate.
- `mineBlocks` gains `exclude?(x,y,z)` (world.ts, 3 small hunks) and returns `state.unreachablePositions`; `gatherStep` passes `ctx.exclude` and reports positions on an unreachable failure; `buildWorldView(…, exclude)` hides excluded blocks from the planner's view.
- Ladder (`recovery.ts`): new rung `relocate`, first for an unreachable gather with >= 3 dead positions (not logs), max `MAX_RELOCATIONS`=2 per job. The species is NOT put on the avoid list then. After the move the runner re-plans from the new spot (rescan), so coal_ore in view is gathered, else the planner falls back to deep variants / shafts as before. Out of relocations / could not move: old avoid-and-replan.
- `explore.ts`: `rankRelocations` (pure: 16 bearings x 56/72/90 blocks, drops wet/lava/unloaded/excluded/beyond 250 from the start, scores dry path, away from the exhausted area, ~64 blocks, level) + `Explorer.relocate` (hops of 20, next distinct bearing when blocked, early stop once an un-excluded target is within 32 and >= 48 blocks out, 4 min box, no return trip). Surface/underground explores also ignore excluded blocks.

## B. Night survival (t3.survive_night)
- Tool `surviveNight({useBed?})` (tools.ts, registry.ts, one prompt line under "Building", exempt from auto-cancel). Runs as a `build` job with `hold:"night"`: refuses by day (needs 10500 <= time < 23500), creative refuses.
  - bed within 32 blocks or carried (and `useBed !== false`) -> `sleepIn`, re-sleeps if woken, waits for dawn;
  - else blueprint `shelter` (blueprints.ts: house geometry fixed at 5x5 = 3x3 interior, 2 high, full roof, no windows; wall = cobblestone/dirt/planks the bot holds >= 57, else dirt dug by hand; a door only if one is carried, else the 2-high doorway is plugged with 2 wall blocks from inside, +2 in `computeNeeds`). Built beside the requester by the existing Builder (site, scaffolds, materials ladder), then `runNightHold`: open door, walk to the middle, close it / plug, torch in a back corner if carried, wait (OUTSIDE any tracked skill, so auto-eat and defend stay live) until time >= 23500, then open up and walk out. Ends with `job_end`; job event "survived the night".
  - pure `jobs/night.ts` (clock, wall choice, `shelterGeometry`), bot-bound `jobs/steps/night.ts`, runner `NightDeps` + `runNightHold`.
- Reflexes (`auto-behaviors.ts`): the defensive swing no longer waits for an idle bot (only `attack|flee|eat|sleepIn|fish` block it), so a bot being hit mid-dig/mid-build fights back; new `armTick`: at night, idle, hostile within 6 blocks -> equip best sword/axe.
- Found + fixed: `notifyStop` (death / watchdog) crashed for a job with no plan steps (`steps[-1]!`), i.e. any build with no materials phase.

## Later edits (after the first live run)
- `wire.ts` initially lacked `night:` (a chained `sed && python` aborted): run 1 said "night survival isn't available". Fixed; no wire-level test exists (wire.ts imports the agent), so an unwired dep is only caught live.
- Dirt-wall shelter: walls dug by the Builder's `acquire` (`selfSupply` covers the whole dirt need; planner `gather dirt` lost its drops, 5 dug / 2 collected), up to ~1.6x tries, never the block underfoot, fresh grass tops before dirt.
- Ranking prefers dry exposed ore (`dryOres`, `ORE_BONUS`); after a written-off area, gathers and the view skip ore touching water/lava (`withDryOres`).
- Builder owns its hands: `melee-guard.ts` fights a mob within 3.4 blocks between actions; `build` added to the swing reflex's skip list (reflex equipped the sword between the Builder's equip and place: "Server refused to place stone_sword"). Added in the LAST edit: tested offline only.

## Live results (test server, 1 repeat each; `v2/runs/dev-2cb`, `dev-2cb2`, `dev-2cb3` in the v2 worktree)
| scenario | run 1 | run 2 | run 3 |
|---|---|---|---|
| t2.coal | FAIL 0/3, 396 s, alive: relocated 52 blocks, new area's ore was lake-wall too (6 unreachable), 2nd relocation blocked, fell back to deep/explore | PASS 3/3, 255 s: 199 s on the first area, relocate 70 blocks to (-335,64,-514), 3 coal from dry ore at (-332,57,-506) | PASS 3/3, 235 s |
| t3.iron_pickaxe | PASS 180 s | PASS 180 s | FAIL 0/1: job itself finished (216 s, 14 steps, no relocation) but Haiku passed `deliverTo:"Tester"`, so the bot's inventory was empty (model variance; run 1/2 had no deliverTo) |
| t3.survive_night | FAIL 0.75/0.5: `night` not wired, 2 refusals, 4 deaths | FAIL 0.5 (1 death): `gather dirt` lost drops, job failed after 37 s, bot idled, skeleton arrows killed it at t=417 s | FAIL 0.5 (1 death): `surviveNight` ok, dirt dug, shelter 39/55 (2 layers, roof unfinished) in 137 s, skeletons + creeper killed it while building; two placements failed with the sword in hand; job `failed(died)`; the idle bot then survived the rest |
- Weapon-ready reflex confirmed live ("readied stone_sword", run 2).

## Unverified live
- The whole hold phase (enter, close door / plug, torch, wait, leave) and the sleep path: only `steps/night.sim.test.ts` + runner tests.
- melee guard and `build` in the reflex skip list; dirt digging via `acquire` for 58 blocks (sim only, spread over columns); `sleepIn`/bed placement.
- Risk: at the plains site mobs arrive within ~2 min of dusk; gathering+building takes ~2.5 min. Next steps: let the Builder wall in first (walls before roof) and skip dirt digging by using the roof-less 2-row ring when under attack, or start with a 1x2 dug-in pit; consider flee/arrow cover for skeletons.
- Other: `notifyStop` crash for step-less jobs fixed (found while writing tests). world.ts hunks: `exclude`, `unreachablePositions` (x2), `findMineCandidate` filters. system-prompt.ts: one line under "Building". tools.ts: `surviveNight` + exempt-tool entry.
