# v2 status

**Resume:** in `~/dev/minecraft-endeavours-v2` (branch `v2`), say "continue v2 per v2/STATUS.md". Never work in `~/dev/minecraft-endeavours` (live panel). Mission: [../V2_KICKOFF_PROMPT.md in the main checkout] — the most competent, comprehensive, efficient Haiku-brained Minecraft bot. Decisions: [DECISIONS.md](DECISIONS.md). Test server: [TEST_SERVER.md](TEST_SERVER.md).

## Phase
**1 — Define "best", measure v1.** Goal: benchmark + v1 baseline + targets.

## Done
- Step 0: tag `v1` (= `b184e5e`, local only, not pushed), worktree + branch `v2`, isolated test server (boots, RCON ok), `Steve_v2` config, port-aware bot scripts. Commit `c1587b0`.
- Research: `v2/reports/research-sota.md`. Top ideas: recipe-graph `achieve(item,n)` planner in middleware; per-step postconditions + typed failures; one LLM call per goal, re-enter only on events; deterministic recovery ladder; plan cache on disk; blueprint builder; pathfinder master pin (VERIFIED: npm 2.4.5 = 2023; master has Sep–Oct 2026 fixes incl. A* heap bug, corner cuts, water, goto-rejects-unreachable (semantics change!), door nodes, `createHuman` controller); item-name validation; tech-tree ladder eval.
- Eval harness `d44eb1c` ([EVAL.md](EVAL.md)). Smoke vs v1: 2/4 — chop_logs 3/10 (mineBlock counts digs not pickups), door_house dug through wall beside door. ~$0.001/task, cache hit 99%.
- Scenario catalogue spec: `v2/SCENARIOS.md` (33 scenarios, core + stretch).

## In flight (2026-10-09 ~16:00)
- **v1 core baseline** running (no agent; process `src/eval/runner.ts --label v1-baseline --suite core --wait-limit --out v2/runs/v1-baseline`). Harness agent died at the usage limit before writing `v2/reports/baseline-v1.md` — lead writes it when the run ends. Tier 1 so far 6/8.
- **Slice 1** committed `5bc85c2` (pending benchmark). Reviewer agent → `v2/reports/slice1-review.md`.
- **Slice 2a** planner committed `5017410` (37 tests).
- **Slice 2b** agent: job runner + step executors + recovery ladder + `achieve`/`cancelJob` + job-end re-entry + eval busy signal → `v2/reports/slice2b.md`. Waits for the baseline to finish before live runs.
- Frozen v1 bot checkout: `../minecraft-endeavours-v1base` (detached `c1587b0`). Don't edit it.
If a session died mid-flight: check `git status` + those report files; typecheck; whatever exists is the progress.

## Next steps
1. Baseline done → write `v2/reports/baseline-v1.md`, set targets, tell owner.
2. Slice 1 → benchmark core vs baseline → review → commit.
3. Slice 2b (executor + job runner + `achieve` tool + agent re-entry + eval busy signal) after slice 1 lands (touches same files). Then benchmark.

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
