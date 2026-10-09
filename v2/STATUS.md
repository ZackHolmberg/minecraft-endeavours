# v2 status

**Resume:** in `~/dev/minecraft-endeavours-v2` (branch `v2`), say "continue v2 per v2/STATUS.md". Never work in `~/dev/minecraft-endeavours` (live panel). Mission: [../V2_KICKOFF_PROMPT.md in the main checkout] — the most competent, comprehensive, efficient Haiku-brained Minecraft bot. Decisions: [DECISIONS.md](DECISIONS.md). Test server: [TEST_SERVER.md](TEST_SERVER.md).

## Phase
**1 — Define "best", measure v1.** Goal: benchmark + v1 baseline + targets.

## Done
- Step 0: tag `v1` (= `b184e5e`, local only, not pushed), worktree + branch `v2`, isolated test server (boots, RCON ok), `Steve_v2` config, port-aware bot scripts. Commit `c1587b0`.
- Research: `v2/reports/research-sota.md`. Top ideas: recipe-graph `achieve(item,n)` planner in middleware; per-step postconditions + typed failures; one LLM call per goal, re-enter only on events; deterministic recovery ladder; plan cache on disk; blueprint builder; pathfinder master pin (VERIFIED: npm 2.4.5 = 2023; master has Sep–Oct 2026 fixes incl. A* heap bug, corner cuts, water, goto-rejects-unreachable (semantics change!), door nodes, `createHuman` controller); item-name validation; tech-tree ladder eval.
- Eval harness `d44eb1c` ([EVAL.md](EVAL.md)). Smoke vs v1: 2/4 — chop_logs 3/10 (mineBlock counts digs not pickups), door_house dug through wall beside door. ~$0.001/task, cache hit 99%.
- Scenario catalogue spec: `v2/SCENARIOS.md` (33 scenarios, core + stretch).

## In flight (2026-10-09 ~17:30)
- Eval chain (background shell): v1 re-run of `t1.eat`,`conv.followup_chest` into `v2/runs/v1-baseline`, then **v2 core run** `v2/runs/v2-s2b` (bot = live worktree @ `4e290f7`-equivalent src `ff27f8d`). Log: `v2/runs/v2-s2b.out` ends with CHAIN_DONE. **Don't edit `src/` until it finishes** (D11).
- Slice 2b review done (`b7bbdda`); fix agent works in worktree `../mcv2-dev` (branch `v2-fixes`, docker disabled there) → appends "## Fixes" to `v2/reports/slice2b-review.md`. Lead commits on `v2-fixes`, then `git merge --ff-only v2-fixes` into `v2` after the benchmark ends.
- Frozen v1 bot checkout: `../minecraft-endeavours-v1base` (detached `c1587b0`). Don't edit it.
If a session died mid-flight: `pgrep -f src/eval/runner.ts`; check run dirs + report files; whatever exists is the progress.

## Next steps
1. When `v2-s2b` finishes: summarize vs baseline (`npm run eval:compare -- v2/runs/v1-baseline v2/runs/v2-s2b`), add a row to Benchmark scores, patch baseline-v1.md re-run lines.
2. Apply slice 2b review fixes; implement D12 pillar `purpose` (pillar.ts `pillarUpBy` param; navigation escape + world.ts water escape = "escape"; eval counts purpose != escape).
3. Milestone check-in with the owner (first-milestone DoD met if v2 beats v1).
4. Then slice 2c: prompt/tool-surface trim, request-handling (deliver to player, don't stop at a plan), builder (blueprints + scaffolding) for build_house/portal, pathfinder master pin (D9 #3).

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
| v1-baseline | 12/30 | 6/8 | 4/8 | 0/5 | 0/3 | 0/2 | 1/2 | 1/2 | 202 | [report](reports/baseline-v1.md) |

## Open questions for the owner
- None yet. (Pushing the `v1` tag / `v2` branch to GitHub: will ask before doing it.)
