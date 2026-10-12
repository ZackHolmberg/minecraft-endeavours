# Eval harness report

Status: DONE. Harness, 4 smoke scenarios, scout, world snapshot/restore, compare. Typecheck clean. Docs: `v2/EVAL.md`.

## What was built (all under `src/eval/`)
- `rcon.ts` (own RCON client), `snbt.ts` (tolerant SNBT parser; tested on real 1.21.9 output: inventory entries are `{Slot, id, count}`; armor/offhand live under `equipment`, which `ctx.inventory()` merges in).
- `tester.ts` (mineflayer Tester: chat capture, blockUpdate stream, surface scan, human-like item pickup), `ctx.ts` (ScenarioCtx impl, protected-box watcher), `bot-process.ts` (spawn/stop bot in its own process group, state wipe, refuses the live checkout/port 25565), `telemetry.ts` (events -> metrics, task-running detection), `env.ts`.
- `world.ts` (`snapshotPristine/restorePristine`, CLI `tsx src/eval/world.ts snapshot|restore`), `scout.ts` + committed `sites.json`.
- `runner.ts` (`npm run eval`), `report.ts` (summary.md), `compare.ts` (`npm run eval:compare`).
- `helpers.ts` (`hasItems, containerHas, playerNear, buildHouse, box, inBox, blockOf, dist`), `scenarios/{index,tier1,tier2}.ts` (4 smoke scenarios).
- `package.json` scripts `eval`, `eval:compare`; `.gitignore` += `v2/world-pristine/`.

### Changes to `types.ts` (additive only)
- `ScenarioCtx.surface(x, z): Promise<number>` (standing y from the Tester's loaded world). Nothing else changed.

### Behaviours worth knowing (decisions I made)
- `ctx.say()` rewrites the word "steve" to the bot's real username: the router's alias logic only strips `_ai|_bot|_npc`, so "steve, ..." does NOT route to `Steve_v2` (found in the first run: bot saw the chat, `routed:false`). v2 may want a `_v2`-style alias or config-defined aliases; until then the harness handles it.
- Any `brokenProtected > 0` forces `ok=false` and caps score at 0.5 (the "AND 0 broken blocks" rule is generic, not door_house-specific).
- Success is latched on any passing poll/final check; score = best seen. Wall time has up to 5s poll granularity.
- Paper's 4s same-IP login throttle rejected the bot's first connects; the runner waits 5.5s after the Tester connects before starting the bot.
- Tester walks to dropped items within 6 blocks (otherwise v1's tossed bread never registered).
- Extra flag `--timeout-scale` for debugging the timeout path (verified: timedOut + in-flight task_end wait work).

## World / sites (seed -4172144997902289642)
Seed is fine (no ocean problem) but flat plains are rare; the nearest flat 25x25 grass window is ~760 blocks out. `plains2` is "mild slope (range 3)" so builders must flatten (`buildHouse` does). Village is a savanna village at ~360 blocks (nothing plains-type within 1600).

| site | x,y,z | note |
|---|---|---|
| forest | 442,63,-446 | 16 trunks within 10 (jungle logs; "chop logs" = jungle_log) |
| plains | 760,64,-12 | flat grass 25x25, range 1 |
| plains2 | 280,67,-308 | grass 25x25, range 3 |
| hills | 238,123,354 | relief 25 |
| cave | -320,52,-608 | 39 cave-exposed ores in 22 blocks; `underground` pocket hint at -342,26,-615 |
| village | -304,63,-192 | village_savanna origin |
| spawn | 0,63,0 | nearest land to origin |
Min pairwise distance 213 blocks. Pristine snapshot: `v2/world-pristine/` (130 MB, gitignored, player data stripped, taken after pregeneration). Restore takes ~15s.

## Validation
Typecheck clean. Two full passes of the 4 smoke scenarios against frozen v1 (+ ~5 single-scenario debug runs; debug dirs deleted). Results were identical across the two passes. Pass 2 (`v2/runs/v1-smoke-20261009-1246/`):

| scenario | ok | score | wall s | reply s | tasks | turns | tok in | tok out | cache | cost | viol |
|---|---|---|---|---|---|---|---|---|---|---|---|
| t1.chop_logs | FAIL | 0.30 | 46.1 | 2.6 | 1 | 4 | 71k | 326 | 99% | $0.001 | - |
| t1.come_here | PASS | 1.00 | 10.0 | 2.6 | 1 | 4 | 71k | 290 | 93% | $0.002 | - |
| t1.give_bread | PASS | 1.00 | 10.0 | 4.1 | 1 | 3 | 71k | 263 | 99% | $0.001 | - |
| t2.door_house | FAIL | 0.50 | 15.0 | 3.1 | 1 | 4 | 71k | 426 | 99% | $0.001 | broke2 |

Tier 1: 67% success, T2: 0%, overall 50%, mean score 0.70, total cost ~$0.005.

All failures verified as the bot's, not the harness's (bot logs + live RCON polling):
- `t1.chop_logs`: v1 digs 10 jungle logs with bare hands, reports "mined 10" and tells the player "done, 10 jungle logs", but only 3-6 logs end up in the inventory (the rest are left on the ground, not collected; `mineBlock` counts digs, not pickups). Verified by polling the bot's inventory over RCON during the run.
- `t2.door_house`: the bot ends up inside but gets there by digging two oak_planks next to the door ((279,67..68,-305)) instead of opening the door (`oak_planks->air`); the pathfinder digs through player builds. `structure_skip`/structure-guard evidently doesn't cover pathfinding.
- `t1.give_bread` (initially failing): v1's `giveItemsTo` toss lands out of pickup reach of a stationary player; passes only because the Tester walks to nearby items.

## Known limitations
- Check polling is 5s; wall times quantized. Telemetry flush ~1s.
- Task still running after the 60s post-run wait is missing from metrics.
- Only `data/orchestrator/memory` and `.bot-runtime` are wiped per scenario (documented in EVAL.md).
- Scenarios in one repeat share the world; builds persist (far apart by design); `--no-reset` additionally keeps previous repeats' changes and stray item entities.
- Mobs: difficulty normal, no mob-spawn control beyond the pre-scenario local `kill`; hostile spawns at the site are possible at dusk (time is set to 1000 and daylight cycle left running, so 6+ min scenarios stay in daytime).
- Scout's cave/hills picks are heuristic (exposed ores / relief), not hand-verified for walkability; tier-3 authors should eyeball them via the Tester.
- Dev cost: a full pass of the 4 smoke scenarios takes ~5 min and a fraction of a cent to a cent of Haiku.

## Update 2 (scenario catalogue + baseline run) - IN PROGRESS
- Added: ctx `placedBlocks/foodLevel/health/timeOfDay/gameTime/eventCount/scratch/succeeded`, `Scenario.suite` + `dryWin`, runner `--suite core|stretch|all` (default core; `--only` alone implies all), `--dry`, per-group table in summary.
- All 34 catalogue scenarios implemented (`scenarios/{tier1,tier2,tier3,tier4,groups}.ts`); `--dry --suite all` verifies every setup, an empty-setup check that fails, and a simulated win (`dryWin`) that passes: all OK.
- Harness bug found+fixed by dry run: `data get` truncates long lists ("...") in command feedback, silently dropping items. `ctx.inventory/containerItems` now read `Inventory[i]` / `Items[i]` / `equipment.<slot>` one entry at a time. (Smoke-run inventories were simple enough that results stood, but treat the old smoke numbers as superseded.)
- Feasibility aids built in setup: stone outcrop (mine_stone, stone_pickaxe, int.stop when site lacks stone), coal vein (t2.coal), stone+iron+coal outcrop (t3.iron_pickaxe), water + leveled pad (wheat farm), leveled pads for builds.
- BLOCKER hit (2026-10-09 ~13:10 EDT): the shared Claude subscription's 5-hour window was exhausted (`rate_limit status=rejected`, resets 15:30 EDT), so the first baseline attempt produced 6 zero-token failures (discarded). Added: rate-limit detection (any rejected `rate_limit` event => scenario gets `harnessError=RATE_LIMITED ...`, not counted as a bot failure), runner aborts with the reset time, or `--wait-limit` sleeps until reset+60s and retries that scenario. Baseline relaunched with `--wait-limit` into `v2/runs/v1-baseline`.
