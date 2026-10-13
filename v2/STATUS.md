# v2 status

**Resume:** in `~/dev/minecraft-endeavours-v2` (branch `v2`), say "continue v2 per v2/STATUS.md". Never work in `~/dev/minecraft-endeavours` (live panel). Mission: [../V2_KICKOFF_PROMPT.md in the main checkout] — the most competent, comprehensive, efficient Haiku-brained Minecraft bot. Decisions: [DECISIONS.md](DECISIONS.md). Test server: [TEST_SERVER.md](TEST_SERVER.md).

## Phase
**LIVE (2026-10-11): v2 is the production bot** (`Steve_AI`, `main` @ `7448dac`, D19). Final pre-cutover benchmark `v2-s5`: 58/62 (94%) vs v1 45%; 0 player-build blocks broken, 0 deaths. Next: post-cutover verification + backlog (ROADMAP.md).

## Done
- Step 0: tag `v1` (= `b184e5e`, local only, not pushed), worktree + branch `v2`, isolated test server (boots, RCON ok), `Steve_v2` config, port-aware bot scripts. Commit `c1587b0`.
- Research: `v2/reports/research-sota.md`. Top ideas: recipe-graph `achieve(item,n)` planner in middleware; per-step postconditions + typed failures; one LLM call per goal, re-enter only on events; deterministic recovery ladder; plan cache on disk; blueprint builder; pathfinder master pin (VERIFIED: npm 2.4.5 = 2023; master has Sep–Oct 2026 fixes incl. A* heap bug, corner cuts, water, goto-rejects-unreachable (semantics change!), door nodes, `createHuman` controller); item-name validation; tech-tree ladder eval.
- Eval harness `d44eb1c` ([EVAL.md](EVAL.md)). Smoke vs v1: 2/4 — chop_logs 3/10 (mineBlock counts digs not pickups), door_house dug through wall beside door. ~$0.001/task, cache hit 99%.
- Scenario catalogue spec: `v2/SCENARIOS.md` (33 scenarios, core + stretch).

## Live state
- Live bot runs from the main checkout (`./scripts/botStart.sh` / `botStop.sh` there). Panel restarted on the v2 UI (launchd). Verify on first chat: `grep "sdk init" .bot-runtime/bot.log` should show `foreign=0` and `mcp=[minecraft-skills]` (D16/D18 isolation).
- Worktrees: `minecraft-endeavours-v2` (branch `v2`, dev), `mcv2-dev` / `mcv2-build` (side branches), `mcv2-bench` (frozen), `minecraft-endeavours-v1base` (frozen v1).

## Next steps — live polish slice (2026-10-12)
- Merged into `v2` @ `7619083` (640 tests): polish C `55f6bb5` (find job, creative flight, gather watchdog → t2.coal pass, tree write-off, axe plan), polish B `2808e8e` (pixel art per D20: Commons Canadiens logo 554/554 live), polish A `ca70b10` (silent-turn fix, early session end, 12 tools hidden; 16 core: 62→35 API calls, tokens −59%, prefix 20.3k→14.6k).
- `v2-s6` (35 core ×2): 69/70. Review (`reports/polish-review.md`, no HIGH) fixes M1–M5 + LOWs → `v2-fixes` (D23), plus water-avoiding mine targets (`dryFirst`, after the s6 drowning).
- Then: deploy to `main` (merge in main checkout, `npm install` for sharp, bot restart) with owner OK.

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
| **v2-s6 (`7619083`, ×2, live polish, 35 core)** | **69/70 (99%)** | 16/16 | 16/16 | 9/10 | 10/10 | 4/4 | 4/4 | 10/10 | 76/pass | 0 broken, 0 pillar, 1 death; vs s5 on the 31 shared scenarios: 94%→98%, turns 294→140, tokens −52%, cost −32%; new conv.unnamed_answer, cr.pixel_art/find_diamonds/fly_follow 2/2; fail: iron_pickaxe r1 (dug stone in a flooded pit, drowned → water-avoiding mine targets) |
| **v2-s5 (`99f1610`, ×2, final pre-cutover)** | **58/62 (94%)** | 16/16 | 14/16 | 9/10 | 7/8 | 4/4 | 4/4 | 4/4 | 147/pass | 0 broken, 0 pillar, 0 deaths; fails: coal ×2 (lake site timeout), portal r1 (scaffold), chat_while_following r1 (trailed 25 blocks) |
| v2-s4 (`6d5af8b`, ×2) | **57/60 (95%)** | 16/16 | 16/16 | 8/10 | 5/6 | 4/4 | 4/4 | 4/4 | 146/pass | 0 broken, 0 pillar, 1 death (survive_night r2, pre quick-shelter); p50 first reply 2.2s; fails: build_house r1 80/82 (server refused 1 placement, no retry), followup_chest r2 (chest >16 blocks away after chopping), survive_night r2 |
| v2-s3 (`110e060`, ×2) | **48/60 (80%)** | 16/16 | 13/16 | 7/10 | 1/6 | 3/4 | 4/4 | 4/4 | 136/pass | [milestone-1](reports/milestone-1.md); 0 broken; deaths 5 |
| v2-r1 targeted (`3480223`, 8 regressed scenarios) | 6/8 | | | | | | | | | doors ✓ (0 broken), no_grief ✓, wooden/stone pickaxe ✓, not_stop ✓; chop_logs ✗ (jungle drops), coal ✗ (drowned/suffocated) |
| v2-s2b (`ff27f8d`) | 14/30 | 7/8 | 3/8 | 1/5 | 2/3 | 0/2 | 1/2 | 0/2 | 152 | iron_pickaxe ✓ 5 turns; regressions R1–R4 (pathing timeouts w/o digging, filler eats materials, doors don't open, log hut chopped: 9 broken); builds waited for confirm (D13) |

## Open questions for the owner
- None.
