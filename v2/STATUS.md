# v2 status

**Resume:** in `~/dev/minecraft-endeavours-v2` (branch `v2`), say "continue v2 per v2/STATUS.md". Never work in `~/dev/minecraft-endeavours` (live panel). Mission: [../V2_KICKOFF_PROMPT.md in the main checkout] — the most competent, comprehensive, efficient Haiku-brained Minecraft bot. Decisions: [DECISIONS.md](DECISIONS.md). Test server: [TEST_SERVER.md](TEST_SERVER.md).

## Phase
**1 — Define "best", measure v1.** Goal: benchmark + v1 baseline + targets.

## Done
- Step 0: tag `v1` (= `b184e5e`, local only, not pushed), worktree + branch `v2`, isolated test server (boots, RCON ok), `Steve_v2` config, port-aware bot scripts. Commit `c1587b0`.
- Research: `v2/reports/research-sota.md`. Top ideas: recipe-graph `achieve(item,n)` planner in middleware; per-step postconditions + typed failures; one LLM call per goal, re-enter only on events; deterministic recovery ladder; plan cache on disk; blueprint builder; pathfinder master pin (VERIFIED: npm 2.4.5 = 2023; master has Sep–Oct 2026 fixes incl. A* heap bug, corner cuts, water, goto-rejects-unreachable (semantics change!), door nodes, `createHuman` controller); item-name validation; tech-tree ladder eval.
- Eval harness `d44eb1c` ([EVAL.md](EVAL.md)). Smoke vs v1: 2/4 — chop_logs 3/10 (mineBlock counts digs not pickups), door_house dug through wall beside door. ~$0.001/task, cache hit 99%.
- Scenario catalogue spec: `v2/SCENARIOS.md` (33 scenarios, core + stretch).

## In flight (2026-10-10 ~00:30)
- Merged into `v2` @ `110e060`: R5/R6 (`c80abf4`: tree felling, drowning reflex; chop_logs 10/10) + slice 3 (`1d12eba`: blueprint builder + deliverTo; 5/5 build/farm/portal/give live). 193 tests.
- **Milestone run** `v2/runs/v2-s3` (core, `--repeat 2`, bench `../mcv2-bench` @ `110e060`), log `v2/runs/v2-s3.out` ends CHAIN_DONE. ~2–3 h.
- Slice 3 review fixes merged (`c490b54` + `1b5e6b1`, 248 tests). NOT in the milestone run (bench @ `110e060`); re-verify live in the next run.
- Queued after v2-s3: second v1 pass → `v2/runs/v1-baseline-r2`.
- Evals serialize via the runner lock `v2/runs/.eval-lock` (`f-lock` commit); just start them, later ones wait.
If a session died mid-flight: check the run dir + reports; whatever exists is the progress.

## Next steps
1. Read `v2-s3` (compare vs v1-baseline; v1 is 1 repeat — consider a 2nd v1 repeat for fairness), apply slice-3 review fixes, update Benchmark scores, **milestone check-in with the owner**. Known open → slice 2c (conversation + autonomy): conv.followup_chest (unopened nearby chests not in context → bot asked where the chest is), conv.status_midtask (mid-task question waits for blocking mineBlock; gather stops at 8/10 and asks instead of moving to the next tree → route long gathers through jobs, generic `any log` goals), conv.two_part (bot 8.4 blocks from Tester after 'arrived' — something moved it), t2.coal (explore-elsewhere recovery), t3.survive_night (night behavior: shelter blueprint / fight), pathfinder master pin. (Done: targeted re-test (`t1.chop_logs,t2.wooden_pickaxe,t2.stone_pickaxe,t2.door_house,t2.door_exit,t2.coal,pl.no_grief,int.not_stop`) → fix → full core run `v2-s2c`.
2. Re-run v1 on `t3.build_house,cr.build_house,t3.wheat_farm,t3.portal` with the D13 confirm policy (fair baseline).
3. Milestone check-in with the owner once v2 clearly beats v1.
4. Next slices: builder (blueprints + scaffolding: houses, portal), farming, night survival/combat, creative give/deliver (`cr.give_torches`: fetched but never handed over), pathfinder master pin, prompt/tool-surface trim.

## Targets (set 2026-10-09 from the v1 baseline; benchmark = `npm run eval`, see EVAL.md)
| metric | v1 baseline | v2 target |
|---|---|---|
| Core suite success (30 scenarios) | 12/30 (40%) | **≥ 80%** |
| Tier 1 / Tier 2 / Tier 3 | 75% / 50% / 0% | ≥ 95% / ≥ 85% / ≥ 60% |
| Protected blocks broken (player builds) | 4 | **0** |
| Pillar-to-travel / deaths outside combat scenarios | 1 / 0 | 0 / 0 |
| Haiku turns, single-goal progression (stone/iron pickaxe) | 20–21, failed | **≤ 6** |
| Iron pickaxe from empty inventory | fail | **< 5 min** |
| Full iron kit, stretch (`t4.iron_kit`) | not run | ≥ 2/3 runs, < 20 min, ≤ 10 turns |
| Diamonds, stretch (`t4.diamonds`) | not run | ≥ 50% |
| p50 first reply | ~2.6 s | ≤ 3 s |

## Benchmark scores
| run | core | t1 | t2 | t3 | conv | int | pl | cr | turns | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| v1-baseline | 12/30 | 7/8 | 4/8 | 0/5 | 0/3 | 0/2 | 1/2 | 0/2 | ~230 | [report](reports/baseline-v1.md); t1.eat + 4 confirm-policy scenarios re-run (D13); cr.build_house flipped PASS→FAIL on re-run (plan only in thinking, never said) — single-repeat noise is real, use repeats for milestone numbers |
| v2-r1 targeted (`3480223`, 8 regressed scenarios) | 6/8 | | | | | | | | | doors ✓ (0 broken), no_grief ✓, wooden/stone pickaxe ✓, not_stop ✓; chop_logs ✗ (jungle drops), coal ✗ (drowned/suffocated) |
| v2-s2b (`ff27f8d`) | 14/30 | 7/8 | 3/8 | 1/5 | 2/3 | 0/2 | 1/2 | 0/2 | 152 | iron_pickaxe ✓ 5 turns; regressions R1–R4 (pathing timeouts w/o digging, filler eats materials, doors don't open, log hut chopped: 9 broken); builds waited for confirm (D13) |

## Open questions for the owner
- None yet. (Pushing the `v1` tag / `v2` branch to GitHub: will ask before doing it.)
