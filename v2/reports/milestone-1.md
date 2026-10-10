# Milestone 1 — v2 vs v1 (2026-10-10)

**v2 @ `110e060`** (frozen bench), core suite (30 scenarios) × 2 repeats → `v2/runs/v2-s3`. **v1** frozen (`c1587b0`) × 2 repeats → `v2/runs/v1-baseline` + `v2/runs/v1-baseline-r2`. Same harness, seed, pristine world, Haiku 5.5.

| | v1 (×2) | v2 (×2) | target |
|---|---|---|---|
| **Core success** | 27/60 (45%) | **48/60 (80%)** | ≥ 80% ✅ |
| Tier 1 / 2 / 3 | 88% / 44% / 10% | **100% / 81% / 70%** | ≥95 ✅ / ≥85 ❌ / ≥60 ✅ |
| conv / int / pl / cr | 0/6 · 1/4 · 2/4 · 2/4 | 1/6 · 3/4 · 4/4 · 4/4 | |
| Player-build blocks broken | 8 | **0** | 0 ✅ |
| Pillar-to-travel | 0 | 0 | 0 ✅ |
| Deaths | 2 | 5 (survive_night 3, coal 2) | 0 outside combat ❌ |
| Haiku turns per full pass | ~200 | **136** (−32%) | |
| Iron pickaxe from empty | fail (21 turns) | **2/2, 5 turns, 130 s** | < 5 min, ≤ 6 turns ✅ |
| Stone pickaxe | fail (20 turns) | 1/2, 5 turns | |
| Portal / house (survival) / house (creative) | 0/0/0 | 2/2 · 1/2 · 2/2 | |
| p50 first reply | 2.8 s | 2.7 s | ≤ 3 s ✅ |
| Cost per full pass | $0.12 | $0.08 | |

## What made the difference
1. **Honest primitives (slice 1 + R1–R6):** v1's pathfinder config was never applied (it dug through walls); gathering counted digs not pickups; table crafts were silently rolled back by the server (unpaced clicks). Now: natural-terrain-only digging, doors open (door-node repair), tree detection (log huts are safe), bottom-up felling, drowning reflex.
2. **Goal planner + background jobs (slice 2, D10):** `achieve(goals)` resolves the recipe graph deterministically and runs it with postconditions and a recovery ladder; Haiku spends ~5 turns on an iron pickaxe instead of 20+ failing ones.
3. **Blueprint builder (slice 3, D14):** house / portal / farm as jobs with scaffolding; `deliverTo` hands items over.

## Remaining failures (12 of 60) → slice 2c (in progress)
- `t2.coal` 0/2: all coal behind a lake; recovery falls back to deep ores → explore-elsewhere rung.
- `t3.survive_night` 0/2 (score .5): passive, dies → shelter blueprint + survive-night job.
- `conv.followup_chest` 0/2: unopened nearby chest not in context. `conv.status_midtask` 0/2: mid-task question waits for a blocking skill; gather stops short and asks. `conv.two_part` 1/2.
- `t2.stone_pickaxe`, `t3.build_house` rep 2: "Digging aborted" mid-dig (reflex interference?); build site wandered outside the checked area.
- `int.stop` rep 2 (.9).

Caveats: single runs are noisy (v1 `cr.build_house` flipped PASS→FAIL between identical runs). Slice-3 review fixes (`c490b54`) landed after this run.

## Update — v2-s4 (`6d5af8b`, after slice 2c + slice-3 review fixes)
**57/60 (95%)**: t1 16/16 · t2 16/16 · t3 8/10 · conv 5/6 · int 4/4 · pl 4/4 · cr 4/4; 0 player-build blocks broken, 0 pillar violations, 1 death; p50 first reply 2.2 s; 146 turns/pass. Since then (`61a70b8`): quick-shelter night survival (live 2/2, 0 deaths). Owner live test on the real server: "nearly flawless, lightning fast"; one stuck moment (fixed `46d6ba9`) and a missed message while following (follow-as-job in progress).
