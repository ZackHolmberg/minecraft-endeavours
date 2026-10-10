# v2 status

**Resume:** in `~/dev/minecraft-endeavours-v2` (branch `v2`), say "continue v2 per v2/STATUS.md". Never work in `~/dev/minecraft-endeavours` (live panel). Mission: [../V2_KICKOFF_PROMPT.md in the main checkout] — the most competent, comprehensive, efficient Haiku-brained Minecraft bot. Decisions: [DECISIONS.md](DECISIONS.md). Test server: [TEST_SERVER.md](TEST_SERVER.md).

## Phase
**Milestone 1 reached (2026-10-10): v2 80% vs v1 45% on core (×2 each)** — awaiting owner check-in. Meanwhile slice 2c (conversation/autonomy + explore/night) in progress.

## Done
- Step 0: tag `v1` (= `b184e5e`, local only, not pushed), worktree + branch `v2`, isolated test server (boots, RCON ok), `Steve_v2` config, port-aware bot scripts. Commit `c1587b0`.
- Research: `v2/reports/research-sota.md`. Top ideas: recipe-graph `achieve(item,n)` planner in middleware; per-step postconditions + typed failures; one LLM call per goal, re-enter only on events; deterministic recovery ladder; plan cache on disk; blueprint builder; pathfinder master pin (VERIFIED: npm 2.4.5 = 2023; master has Sep–Oct 2026 fixes incl. A* heap bug, corner cuts, water, goto-rejects-unreachable (semantics change!), door nodes, `createHuman` controller); item-name validation; tech-tree ladder eval.
- Eval harness `d44eb1c` ([EVAL.md](EVAL.md)). Smoke vs v1: 2/4 — chop_logs 3/10 (mineBlock counts digs not pickups), door_house dug through wall beside door. ~$0.001/task, cache hit 99%.
- Scenario catalogue spec: `v2/SCENARIOS.md` (33 scenarios, core + stretch).

## LIVE TEST (owner request, 2026-10-10 17:05)
- `Steve_v2` (v2 @ `6d5af8b`) is running on the **real server** from worktree `../mcv2-live` (`.env` MC_PORT=25565, docker disabled there). Started live MC via main checkout `scripts/start.sh`; backup `backups/world_2026-10-10_17-05-14.tar.gz` (main checkout) taken first; `whitelist add Steve_v2` on live. Stop: `cd ../mcv2-live && ./scripts/botStop.sh`. Logs: `../mcv2-live/.bot-runtime/bot.log` (+ `data/orchestrator/telemetry/Steve_v2/` there). Panel doesn't show it. Afterwards: `./scripts/botReport.sh` in mcv2-live; consider `whitelist remove Steve_v2`.

## In flight (2026-10-10 ~16:00)
- Merged into `v2` @ `6d5af8b`: slice-3 review fixes, 2c-A (`f183dde`: nearby containers, gather continuation, generic `#tag` goals, side replies, strictMcpConfig), 2c-B (`8463bb8`: explore-elsewhere recovery — coal live 2/3; shelter + survive_night job — still failing live), deliverTo prompt fix. 319 tests.
- **Run `v2/runs/v2-s4`** (core ×2, bench `../mcv2-bench` @ `6d5af8b`), log ends CHAIN_DONE.
- Worktrees `../mcv2-dev`, `../mcv2-build` synced to `6d5af8b`, idle.

## Next steps
1. Read `v2-s4` vs `v2-s3` and v1 ×2; update Benchmark scores + milestone report.
2. survive_night: shelter is too slow (mobs arrive ~2 min after dusk, build ~2.5 min) → player-like quick shelter (dig 2-deep into ground/hillside and seal, seconds), start at dusk; verify hold phase live.
3. Owner decisions pending (see Open questions): D16 hotfix on main, push, continue.
4. Then: pathfinder master pin (D9 #3), prompt/tool-surface trim (prefix ~17–19k tokens/call), stretch suite (iron kit, diamonds), breadth (combat, trading, Nether).

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
| v1 ×2 (baseline + r2) | 27/60 (45%) | 14/16 | 7/16 | 1/10 | 0/6 | 1/4 | 2/4 | 2/4 | 198/pass | 8 broken, 2 deaths |
| v1-baseline (rep 1) | 12/30 | 7/8 | 4/8 | 0/5 | 0/3 | 0/2 | 1/2 | 0/2 | ~230 | [report](reports/baseline-v1.md); t1.eat + 4 confirm-policy scenarios re-run (D13); cr.build_house flipped PASS→FAIL on re-run (plan only in thinking, never said) — single-repeat noise is real, use repeats for milestone numbers |
| **v2-s3 (`110e060`, ×2)** | **48/60 (80%)** | 16/16 | 13/16 | 7/10 | 1/6 | 3/4 | 4/4 | 4/4 | 136/pass | [milestone-1](reports/milestone-1.md); 0 broken; deaths 5 |
| v2-r1 targeted (`3480223`, 8 regressed scenarios) | 6/8 | | | | | | | | | doors ✓ (0 broken), no_grief ✓, wooden/stone pickaxe ✓, not_stop ✓; chop_logs ✗ (jungle drops), coal ✗ (drowned/suffocated) |
| v2-s2b (`ff27f8d`) | 14/30 | 7/8 | 3/8 | 1/5 | 2/3 | 0/2 | 1/2 | 0/2 | 152 | iron_pickaxe ✓ 5 turns; regressions R1–R4 (pathing timeouts w/o digging, filler eats materials, doors don't open, log hut chopped: 9 broken); builds waited for confirm (D13) |

## Open questions for the owner
- **SECURITY (D16):** live `Steve_AI` on `main` loads the account's claude.ai connectors (no `strictMcpConfig`); one-line hotfix needs owner approval.
- Push `v2` branch + `v1` tag to GitHub? Targets OK? Continue climbing?
- None yet. (Pushing the `v1` tag / `v2` branch to GitHub: will ask before doing it.)
