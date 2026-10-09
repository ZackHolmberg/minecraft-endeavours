# v2 status

**Resume:** in `~/dev/minecraft-endeavours-v2` (branch `v2`), say "continue v2 per v2/STATUS.md". Never work in `~/dev/minecraft-endeavours` (live panel). Mission: [../V2_KICKOFF_PROMPT.md in the main checkout] — the most competent, comprehensive, efficient Haiku-brained Minecraft bot. Decisions: [DECISIONS.md](DECISIONS.md). Test server: [TEST_SERVER.md](TEST_SERVER.md).

## Phase
**1 — Define "best", measure v1.** Goal: benchmark + v1 baseline + targets.

## Done
- Step 0: tag `v1` (= `b184e5e`, local only, not pushed), worktree + branch `v2`, isolated test server (boots, RCON ok), `Steve_v2` config, port-aware bot scripts. Commit `c1587b0`.
- Research: `v2/reports/research-sota.md`. Top ideas: recipe-graph `achieve(item,n)` planner in middleware; per-step postconditions + typed failures; one LLM call per goal, re-enter only on events; deterministic recovery ladder; plan cache on disk; blueprint builder; pathfinder master pin (claim unverified); item-name validation; tech-tree ladder eval.
- Scenario catalogue spec: `v2/SCENARIOS.md` (33 scenarios, core + stretch).

## In flight (2026-10-09)
- Harness subagent → `src/eval/**` (contract `src/eval/types.ts` by lead), `v2/EVAL.md`, `v2/reports/eval-harness.md`, 4 smoke scenarios vs frozen v1.
- Frozen v1 bot checkout for baselines: worktree `../minecraft-endeavours-v1base` (detached `c1587b0`, node_modules symlinked to v2's). Don't edit it.
If a session died mid-flight: check those report files; whatever exists is the progress. Re-brief from the report's "next" notes.

## Next steps
1. Eval contract (`src/eval/types.ts`) → harness + tier-1..3 scenarios (subagent) → `v2/EVAL.md`.
2. Implement rest of SCENARIOS.md (subagent, after harness lands).
3. Run v1 baseline → `v2/reports/baseline-v1.md`; set targets below.

## Targets
TBD after baseline.

## Benchmark scores
None yet.

## Open questions for the owner
- None yet. (Pushing the `v1` tag / `v2` branch to GitHub: will ask before doing it.)
