# Milestone 1 — v2 vs v1 (2026-10-10)

**v2 @ `110e060`** (frozen bench), core suite (30 scenarios) × 2 repeats → `v2/runs/v2-s3`. **v1** frozen (`c1587b0`) × 1 repeat → `v2/runs/v1-baseline` (2nd v1 repeat queued → `v2/runs/v1-baseline-r2`). Same harness, seed, pristine world, Haiku 5.5.

| | v1 | v2 | target |
|---|---|---|---|
| **Core success** | 12/30 (40%) | **48/60 (80%)** | ≥ 80% ✅ |
| Tier 1 / 2 / 3 | 88% / 50% / 0% | **100% / 81% / 70%** | ≥95 ✅ / ≥85 ❌ / ≥60 ✅ |
| conv / int / pl / cr | 0/3 · 0/2 · 1/2 · 0/2 | 1/6 · 3/4 · 4/4 · 4/4 | |
| Player-build blocks broken | 4 | **0** | 0 ✅ |
| Pillar-to-travel | 0 | 0 | 0 ✅ |
| Deaths | 1 | 5 (survive_night 3, coal 2) | 0 outside combat ❌ |
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

Caveats: v1 has one repeat (a second is running); single runs are noisy (v1 `cr.build_house` flipped PASS→FAIL between identical runs). Slice-3 review fixes (`c490b54`) landed after this run.
