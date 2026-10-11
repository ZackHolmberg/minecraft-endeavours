# v2 status

**Resume:** in `~/dev/minecraft-endeavours-v2` (branch `v2`), say "continue v2 per v2/STATUS.md". Never work in `~/dev/minecraft-endeavours` (live panel). Mission: [../V2_KICKOFF_PROMPT.md in the main checkout] — the most competent, comprehensive, efficient Haiku-brained Minecraft bot. Decisions: [DECISIONS.md](DECISIONS.md). Test server: [TEST_SERVER.md](TEST_SERVER.md).

## Phase
**Milestone 1 reached (2026-10-10): v2 80% vs v1 45% on core (×2 each); v2-s4 now 95%** — awaiting owner check-in. Meanwhile slice 2c (conversation/autonomy + explore/night) in progress.

## Done
- Step 0: tag `v1` (= `b184e5e`, local only, not pushed), worktree + branch `v2`, isolated test server (boots, RCON ok), `Steve_v2` config, port-aware bot scripts. Commit `c1587b0`.
- Research: `v2/reports/research-sota.md`. Top ideas: recipe-graph `achieve(item,n)` planner in middleware; per-step postconditions + typed failures; one LLM call per goal, re-enter only on events; deterministic recovery ladder; plan cache on disk; blueprint builder; pathfinder master pin (VERIFIED: npm 2.4.5 = 2023; master has Sep–Oct 2026 fixes incl. A* heap bug, corner cuts, water, goto-rejects-unreachable (semantics change!), door nodes, `createHuman` controller); item-name validation; tech-tree ladder eval.
- Eval harness `d44eb1c` ([EVAL.md](EVAL.md)). Smoke vs v1: 2/4 — chop_logs 3/10 (mineBlock counts digs not pickups), door_house dug through wall beside door. ~$0.001/task, cache hit 99%.
- Scenario catalogue spec: `v2/SCENARIOS.md` (33 scenarios, core + stretch).

## LIVE TEST (owner request, 2026-10-10) — session ended
- `Steve_v2` ran on the real server from worktree `../mcv2-live` (`.env` MC_PORT=25565, docker disabled there); owner: "really impressive… nearly flawless, lightning fast". Owner stopped the live server afterwards; lead stopped the bot and moved `../mcv2-live` to `4147b21` (follow job + quick shelter + live fixes). Backup before the test: `backups/world_2026-10-10_17-05-14.tar.gz` (main checkout). `Steve_v2` is still on the live whitelist.
- Next live session: start the live server (main checkout `scripts/start.sh`), then `cd ../mcv2-live && ./scripts/botStart.sh`; stop with `./scripts/botStop.sh`.
- Live findings, all fixed: stuck after a job (claimed "placed", stopped; un-named follow-ups dropped) → `46d6ba9`; missed message while following → follow job `e12f41b`.

## In flight (2026-10-10 night) — promotion work (D17)
- Reviewer (read-only) → `v2/reports/promotion-review.md` (2c-A, 2c-B, quick shelter, live fixes, follow job + panel security verdict).
- Fix agent in `../mcv2-build` (v2-build): build placement retry + remembered chests → `v2/reports/s4-fixes.md`.
- Docs agent in `../mcv2-dev` (v2-fixes, docs only): ARCHITECTURE/SKILLS/ROADMAP/README (+ JOBS.md?) and `v2/CLAUDE.md.next` → `v2/reports/docs-update.md`.
- Then: merge all, review fixes, final full core run, cutover.

## Next steps — toward promotion (D17)
1. Full core run on the current `v2` HEAD → `v2-s5` (incl. `conv.chat_while_following`).
2. v2-s4 small fixes: build placement retry on server refusal; remember seen chests beyond 16 blocks.
3. Independent review of 2c-A, 2c-B, quick shelter, follow job → fixes.
4. Panel security review of v2 `src/web/**` diff (Events.tsx display-only so far).
5. Docs for a cold-start Claude: fold v2 into ARCHITECTURE/SKILLS/ROADMAP + CLAUDE.md (gitignored; update the main checkout's copy at cutover).
6. Cutover per D17. Done so far: security fix on main (`bd32483`), `v2` + `v1` tag pushed.

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
| **v2-s4 (`6d5af8b`, ×2)** | **57/60 (95%)** | 16/16 | 16/16 | 8/10 | 5/6 | 4/4 | 4/4 | 4/4 | 146/pass | 0 broken, 0 pillar, 1 death (survive_night r2, pre quick-shelter); p50 first reply 2.2s; fails: build_house r1 80/82 (server refused 1 placement, no retry), followup_chest r2 (chest >16 blocks away after chopping), survive_night r2 |
| v2-s3 (`110e060`, ×2) | **48/60 (80%)** | 16/16 | 13/16 | 7/10 | 1/6 | 3/4 | 4/4 | 4/4 | 136/pass | [milestone-1](reports/milestone-1.md); 0 broken; deaths 5 |
| v2-r1 targeted (`3480223`, 8 regressed scenarios) | 6/8 | | | | | | | | | doors ✓ (0 broken), no_grief ✓, wooden/stone pickaxe ✓, not_stop ✓; chop_logs ✗ (jungle drops), coal ✗ (drowned/suffocated) |
| v2-s2b (`ff27f8d`) | 14/30 | 7/8 | 3/8 | 1/5 | 2/3 | 0/2 | 1/2 | 0/2 | 152 | iron_pickaxe ✓ 5 turns; regressions R1–R4 (pathing timeouts w/o digging, filler eats materials, doors don't open, log hut chopped: 9 broken); builds waited for confirm (D13) |

## Open questions for the owner
- Push local `main` (security fix `bd32483`)? (Not requested yet.)
- At cutover: confirm the panel UI rebuild + launchd restart (internet-facing) — plan in D17.
