# Slice 3: blueprint builder + deliver (branch `v2-build`, worktree `../mcv2-build`)

Status: **done.** `tsc`, `tsc -p src/web/ui`, `vitest` (180 tests, 12 files) clean. Live: 5/5 target scenarios pass (3 eval invocations, the cap). Not committed.

## Design as built
Pure core `src/build/` (no mineflayer) + bot-bound executor `src/jobs/steps/`. `Job.kind: "achieve" | "build"` is additive.
- **Blueprints** `blueprints.ts`: `house` :106 (ring walls, door gap with the door last, optional `glass` windows, full-footprint flat roof; `height` counts rows incl. the roof, so 3 = 2-high interior; optional floor), `portal` :163 (10 obsidian, corners omitted, `ignite`), `farm` :186 (`till` all cells, centre `water` or external, `plant` on top). `orientCell` rotates to `facing` (door side; dims swap for east/west).
- **Site** `site.ts:98` `findSite(grid, req)`: nearest footprint to the anchor (requester, else bot): natural ground, level within 1 (farm: exact, tillable), only replaceables above (returned as `clearCells`), 1-block `foundation`, no crafted block in the margin ring (reuses `isCraftedBlockName`/`isNaturalTerrain` read-only), requester never inside footprint+1, door faces the anchor. Farm: existing water within 4 of every cell, else plans a centre water cell.
- **Order/scaffolds** `support.ts:57` `planOrder`: bottom-up, nearest-first, supported cells only; unsupported ones get a scaffold chain (<=3) never inside blueprint/`clear` cells; scaffolds come down as soon as nothing adjacent still needs them, so the portal needs ONE reusable block (3 placements); door last; then till, water, plant, ignite.
- **Materials** `materials.ts:59`, `prepare.ts:77`: consumed items, hoe (any tier)/door (any non-iron) substitutes, glass skipped without stock, seeds capped at 9; skips cells already done (retries resume), foundation, planner goals for the gap. Scaffold dirt is dug by the executor (`selfSupply`), not planned.
- **Executor** `build.ts` `Builder` :103: clear replaceables, creative `getItems`, survival `acquire` (:491, dig dirt + `collect` :477), ordered actions. Survival pre-positions with `standSpots` :356 (reach 4.0, never inside a cell to fill, outside preferred), then calls `placeBlock` unchanged; creative leaves walking/flying to `placeBlock`. `stepOutside` :407 leaves through the gap before the door. Postcondition `judge` :247 = blueprint cells matching the world (farm: all tilled, >= min(9, cells) planted). Telemetry `step` ops `clear|layer|scaffold|light|build`; `job_end.placed/total`.
- **Runner** `runner.ts`: `startBuildInner` :230 (prepare, plan materials, job), `runBuildJob` :677 (materials via the normal ladder in the same job, then prepare/run up to 3 attempts; site re-picked once after gathering, fixed once placing starts), `runDeliver` :645, `timed` :609 (shared timeout/abandon), `run` split into `runGoals` :441 + `runAchieve` :429.
- **Deliver** `deliver.ts:46`: creative `getItems`, `giveItemsTo`, then checks inventory fell by the goal counts AND the dropped item entities vanished (picked up, <= 8 s) AND nothing came back. `achieve({deliverTo})` also works when the items are already held (deliver-only job) and in creative.
- **Haiku**: tool `build({blueprint, params?, at?})` (`tools.ts:101`, `registry.ts:622`), `achieve.deliverTo` (`tools.ts:45`); `build` exempt from auto-cancel. Prompt: new "Building" section (propose if big, then `build` once), "give me" -> `deliverTo`, rule 1 says text is invisible. Backstop `queueSilentFollowUp` (`claude-backend.ts:630`, `isDirectAddress` `coalesce.ts:34`): a directly-addressed task/job event that ends with no `say`/`whisper` gets ONE nudge.
- Other additive edits: `FailureKind` += `no_site`, `build_incomplete`; `pure.test.ts` exempt-tool count 9 -> 10. world.ts, auto-behaviors.ts, pathfinder-config.ts, structure-guard.ts untouched.

## Tests (new)
`build/build.test.ts` (geometry x4 facings, site on synthetic grids, ordering/support invariant, material math, prepare/resume), `jobs/build-job.test.ts` (runner build/deliver flows with fake deps, `createDeliver` with a fake bot), `jobs/steps/build.sim.test.ts` (real `Builder` vs an in-memory world with reach/neighbour/body rules: door last from outside, scaffold reuse + lost drop, farm, creative), `agent/silent.test.ts`.

## Live results (`v2/runs/dev-build{,2,3}`, bot dir mcv2-build, 1 repeat)
Final run `dev-build3` (all PASS, 1.00): job time = `build` job; turns/wall from the eval.
| scenario | wall | turns | job | placed | note |
|---|---|---|---|---|---|
| t3.build_house | 45 s | 7 | 26 s | 57/57 | propose -> "yes" -> `build`; 53 planks, 2 glass, door |
| t3.portal | 50 s | 6 | 42 s | 11/11 | 6 portal blocks; attempt 1 stalled at 5/11 (lost scaffold dirt), retry finished |
| t3.wheat_farm | 15 s | 3 | 12 s | 32/32 | existing water; 15 crops (16 seeds) |
| cr.build_house | 35 s | 7 | 15 s | 57/57 | `getItems` + same blueprint |
| cr.give_torches | 10 s | 5 | 2 s | - | `achieve{deliverTo}`: 64/64 torch in Tester's inventory |
Earlier runs: `dev-build` 4/5 (portal: planner `gather dirt` flaked on drops, then the bot was kicked; houses passed the eval but the job reported 56/57: the mineflayer client never shows a door's upper half although the server has both halves -> `placementDone` now treats the derived half as done). `dev-build2`: house 57/57 verified by RCON (clean ring, 2 windows, door). Scenarios share one site per repeat, so inspect the world only after a single-scenario run.

## Known gaps
- Portal scaffold recovery (dig + pick up the dirt) failed once live; fixed afterwards with a retrying `collect`, an on-demand `acquire` and one spare dirt, covered only by the sim (no live run left).
- Flat roof only; no interior light (mobs can spawn inside); windows are plain `glass`; no fence/path around farms, no harvest/replant.
- Portal needs 10 obsidian + flint_and_steel in hand (the planner cannot make flint); farm centre-water mode needs a water bucket (planner cannot make one).
- Site radius 20, slope <= 1, trees are obstacles (never cleared). `deliverTo` needs the player in sight; pick-up is inferred from the item entities vanishing (cannot read their inventory).
- Haiku sometimes adds `floor` to a creative house; fine, but sizes beyond the defaults are untested live.
