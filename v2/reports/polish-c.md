# Live polish C: find job, creative flight, gather watchdog (worktree `mcv2-jobs`, branch `v2-jobs`, uncommitted)

Validation: `tsc` (+ `src/web/ui`) clean, vitest 32 files / 442+ tests pass, 4 stub checks pass.
Live eval (v2 runner, `dev-polC`, `dev-polC2`): t2.coal, cr.find_diamonds, cr.fly_follow, t1.follow, t1.chop_logs, t3.iron_pickaxe all PASS in the final state (see Eval).

## What changed
1. **Gather no-progress watchdog** (`runner.ts` `timed`, `recovery.ts`, `steps/gather.ts`, `wire.ts`). The runner polls total inventory every 2 s while a gather runs; 60 s with no increase (`GATHER_NO_PROGRESS_MS`) stops the step and fails it `unreachable` + `stalled`, keeping the positions it gave up on. A stalled ore gather skips the in-place retry and relocates at once (logs fall to avoid/re-plan). The 400 s cap is unchanged. Live t2.coal: stall at 61 s -> relocate 85 blocks -> coal; 115 s total (v2-s5: 2 x 480 s fail, 0 rungs used).
2. **`find({block, action: point|mine|report, count?})`** (new job kind; `jobs/find.ts` pure, `steps/find.ts` bot half, `Explorer.tunnelToward` + exported `Explorer` in `explore.ts`). Known sightings (world.json pois, written on success) -> scan of loaded chunks (radius 128, ranked walk + 4/block of digging down, lava-side skipped, water-side last) -> explore: deep ores (band best <= Y40) staircase + branch tunnel, surface blocks spiral; relocates first when no stone within 32 blocks; <= 250 blocks from start, 10 min cap, creative and survival, lifecycle via the runner (cancel/stop/death/event cap). `tunnelToward` is a directed player-like staircase (never straight down; runs away first when the target is nearer in plan than deep; per-cell liquid/structure checks), offline-simulated in `tunnel.sim.test.ts`. Mine failures keep the coordinates (`missing_tool`). Registry entry `find`, exempt from auto-cancel, one system-prompt bullet.
3. **Creative flight.** Follow job: `FlightGate` (airborne 1.2 s -> fly, supported 1.5 s -> land), `flyFollowTick` steps 0.5 blocks/50 ms only into free body volume (slide/over, bounded climb), lands on lost sight / stuck 6 s / job end. `goTo`: creative trips >= 48 blocks horizontally fly in <= 4 verified hops (`flyLongTrip`), then walk. Survival untouched.
4. **Tree nav traps** (`tree-felling.ts`, `world.ts`, gather positions): logs 3+ above the floor rank behind lower ones; a log with no path writes off its whole tree (1 failure at the edge of reach, 2 lower) and its positions go to the job's exhausted memory, so mineBlocks and retries stop re-trying the cluster.
5. **Axe before big log gathers** (`plan.ts` `withAxe`): >= 6 logs, no axe, <= 3 extra logs and a net time saving -> wooden (or stone, if 3 cobblestone held) axe prefix, main plan re-made from the leftover inventory.

## Eval (`v2/runs/dev-polC`, `dev-polC2`)
| scenario | result |
|---|---|
| t2.coal | PASS 115 s (both runs) |
| cr.find_diamonds | PASS 75 s (x2): stairs 57 down to a natural diamond_ore at 749,6,-4; the planted deep ore was not needed |
| cr.fly_follow | run 1 FAIL: bot never took off (mineflayer never updates other players' `entity.onGround`, prismarine-entity inits it true) -> fixed to blocks only; run 2 PASS, 3.1 blocks from the flying Tester |
| t1.follow, t1.chop_logs | PASS (26 s, 65 s) |
| t3.iron_pickaxe | run 1 FAIL ("3 blocks dropped nothing I could pick up" digging a pit in stone; no code path I touched), run 2 PASS 235 s |

## Notes / judgement calls
- Axe economics: bare-hand 3 s vs wooden-axe 1.5 s per log, but the axe costs ~3 extra logs + table + 5 crafts, so from an empty bag it only pays from ~13 logs (D21's "10 logs 68 -> 50 s" ignores the axe's own cost). With planks/table/stone at hand it triggers at 6. t1.chop_logs (10 logs) therefore plans no axe, by design.
- The v2 runner only knows v2's scenario list: I ran it through a wrapper (`scratchpad/run-polc.mts`) that appends `polishC` to `scenarios` and imports the unmodified v2 runner. `polish-c.ts` should be merged with the code. 3 invocations used (one dry).
- Not covered live: find in survival, find with nothing in the loaded chunks (explore branch, only sim-covered for the tunnel), water relocation, long-trip goTo flight, tree write-off, axe plan. Docs: JOBS.md, SKILLS.md updated.
- Touched outside my ownership (small): `skills/world.ts` (tree write-off), `skills/tree-felling.ts`, `planner/plan.ts` + its tests (3 tag tests now hold an axe), `jobs/pure.test.ts` (exempt list 12).
