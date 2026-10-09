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
- **Slice 1** agent (honest primitives, D9) — `src/skills/pathfinder-config.ts`, `world.ts`, `inventory.ts`, `config.ts`, `chat-router.ts`, registry/system-prompt wording → `v2/reports/slice1.md`. Offline validation only; lead runs the benchmark after the baseline finishes.
- **Slice 2a** agent (pure planner) — `src/planner/**` + vitest → `v2/reports/planner.md`.
- Frozen v1 bot checkout: `../minecraft-endeavours-v1base` (detached `c1587b0`). Don't edit it.
If a session died mid-flight: check `git status` + those report files; typecheck; whatever exists is the progress.

## Next steps
1. Baseline done → write `v2/reports/baseline-v1.md`, set targets, tell owner.
2. Slice 1 → benchmark core vs baseline → review → commit.
3. Slice 2b (executor + job runner + `achieve` tool + agent re-entry + eval busy signal) after slice 1 lands (touches same files). Then benchmark.

## Targets
TBD after baseline.

## Benchmark scores
None yet.

## Open questions for the owner
- None yet. (Pushing the `v1` tag / `v2` branch to GitHub: will ask before doing it.)
