# Slice 3 + R5/R6 review (c80abf4, 1d12eba)

Read-only review; nothing run. Paths are relative to the v2 worktree. Ranked by severity.

## HIGH

**H1. `freeStuckDrops` breaks leaf/log blocks under ANY dropped item, on every `pickUpNearby`, with no player-build guard for leaves.** `src/skills/inventory.ts:173,202-244` (line 210 is the gate).
- `isLeafName(support.name)` short-circuits before `builtStructureReason`. Leaves are "cheap break", so the guard would never protect them anyway.
- It runs inside every `pickUpNearby`: the Haiku tool, mining sweeps, `Builder.collect` (`build.ts:483`), and the tree-felling sweep.
- Scenario: a player's treehouse floor or leaf hedge or roof has an item lying on it (a dropped stack, a death pile). The bot is asked to "pick up my stuff" and breaks the leaf block under it, then walks onto the hole. Same for a player's unstripped log post that has any leaf within `TREE_LEAF_RADIUS`: `isTreeLog` says "tree", and `crafted`-neighbour protection only applies at 2+ crafted neighbours.
- Fix: do this only from the mining sweep, never from the generic `pickUpNearby`. Require the support block to be in a cluster the bot just felled (or `isTreeLog` plus no crafted neighbour within 2). Never break leaves that touch a crafted block. Skip items dropped by players.

**H2. Scaffolds are orphaned on cancel, stop, death, timeout, a thrown error and failed cleanup, and the next attempt adopts them as terrain.** `src/jobs/steps/build.ts:205-209,233-236,465-474,533-543`; `runner.ts:615-640`.
- `removeScaffolds()` runs while the stop flag is still set. `dig()` (:428) calls `navigate`, which refuses when the scaffold is more than 4.5 blocks away, so those blocks stay.
- `:541` does `this.scaffolds.length = 0` even when `ok === false`, so failed removals are forgotten. There is no `try/finally` in `run()`: any exception or an abandoned step (`timed`) leaves them.
- The list is in memory only, so a crash or restart loses it.
- A `place` that is not `settled` within 1.5 s returns false (:324,336) and is never pushed, so a late-appearing scaffold is untracked.
- Retry attempts 2 and 3 call `prepare(existing)`: leftover dirt now counts as solid world (`solidName`), is never removed, and may be used as support.
- Scenario: the player says "stop" or the bot dies mid-portal. Up to 3 dirt blocks float next to the half portal, forever.
- Fix: wrap `run()` in `try/finally` and clean up with the stop flag temporarily ignored (walk back if needed). Persist `scaffolds[]` in `job.build` so the next attempt, boot or `cancelJob` can reclaim them. Do not clear the list on failure. Put the leftovers in the failure detail ("left 2 dirt at ...").

## MEDIUM

**M1. The surfacing roof-dig has no player-build guard.** `src/skills/surfacing.ts:128`; `auto-behaviors.ts:~452,493` (`digWithTool`, `digOut`).
- `isNaturalTerrain || isCheapBreak` only checks block names. `stone`, `dirt`, `sandstone`, `terracotta`, `moss_block`, `ice` and leaves are all "natural", and they are what players build with.
- Glass, planks and cobblestone are safe. Plain stone, dirt or sandstone are not.
- Scenario: the bot falls into a flooded cellar or pool under a 1-3 thick `stone` or `sandstone` floor or roof. The cell above the roof is free space, i.e. the player's room. The reflex digs the player's floor.
- Fix: run `builtStructureReason` per candidate dig cell, and also skip when a crafted block is within 2 of the cell or the free cell above it. Prefer the longer swim over that roof.

**M2. Build materials are not reserved, so the pillar filler can eat them.** `runner.ts:283,578,726`; `reserve.ts`.
- `planReservations(job.plan)` covers only `prep.missing` and its plan. Items the bot already holds are never reserved: wall cobblestone/dirt, scaffold dirt, glass, seeds, hoe, water bucket, flint.
- With `missing = []` (stocked or creative) nothing is reserved at all. `pickFiller` prefers cobblestone and dirt.
- Scenario: a cobblestone house with 90 cobble held and only a door missing. The gather phase triggers a water-escape pillar that spends the walls.
- Fix: in `launch` and `runBuildJob`, merge `prep.payload.needs.consumed` keys + `scaffoldItem` + tools + door/seeds/bucket/flint into `setReservations` for the whole job.

**M3. A failed build is not in the failure ledger; re-calling `build` makes a second house.** `wire.ts` onEnd (build skipped); `runner.ts:690-700`.
- `build_incomplete` leaves planks/dirt in the footprint. A fresh `build` call runs `findSite`, which rejects the old spot (`bad: oak_planks`, "next to a player build") and picks a new site beside it.
- The only loop guard is the 3 events per 10 min cap. That is a duplicate-structure spiral plus quota burn until a player chats.
- Fix: ledger keyed on blueprint + anchor + wall (2 failures per 30 min, `ok:false`). Better, let `build` resume the last failed job's origin (job.json).

**M4. The surfacing reflex can restart every 400 ms and spam events, cancelling other controllers.** `auto-behaviors.ts:339-418,448`.
- When `swimToAir` returns early ("no air and no diggable roof", or the dig failed), `finally` clears `active`. The next tick re-triggers (oxygen is still <= 8 and the head is wet).
- Each restart logs, records a `reflex` telemetry event, and calls `setGoal(null)` and `stopDigging()`. Any pathfinder route the A* did have is killed every 0.4 s.
- Also, `bot.stopDigging()` makes the mining skill's dig reject. `mineBlocksInner` then counts it as fruitless or unreachable and may mark good logs unreachable.
- Fix: after a failed routine, back off about 3 s and emit at most 1 event per 10 s. If no route exists, do not clear the pathfinder goal.

**M5. Deliver: abuse and size limits.** `tools.ts:~50-70`; `deliver.ts:46-60`; `creative.ts` `creativeGive`.
- `count` is unbounded. Survival: "give me 100000 cobblestone" runs a 30-minute gather. Creative: `getItems` fills all 36 slots, then returns `inventory_full` and leaves the bot's inventory full of junk.
- Any creative-only item can be handed to a survival player: `command_block`, `structure_block`, `barrier`, `bedrock`, `debug_stick`, spawn eggs, `tnt`, `lava_bucket`. Owner gating is deferred. `giveItemsTo` already allowed this, but `deliverTo` makes it one tool call.
- Fix: cap at 2 stacks per goal (and 8 goals). Add a creative denylist (`command_block*`, `structure_*`, `jigsaw`, `barrier`, `bedrock`, `light`, `debug_stick`, `*_spawn_egg`, `tnt*`, `*lava*`, `knowledge_book`). Do not `getItems` when the player is not in sight.

**M6. Deliver verification is unreliable both ways.** `deliver.ts:34-44,72-80`.
- `groundItems` counts any item entity of that name within 12 blocks of the bot, including the bot's own leftovers. Gather 10 logs, one lies on the ground, give 10: after 8 s it reports "not picked up", although the player has them (false failure).
- `e.getDroppedItem?.()` is null until the metadata packet arrives. A just-dropped item then counts as 0, the loop is skipped, and the job reports success with the stack still on the ground (false success).
- Fix: diff entity ids before and after `dropItem` and track only the new ids. Treat an item entity with unknown stack as "present".

**M7. Retry/timeout lifecycle: a stale Builder can run beside a new one.** `runner.ts:693-760` (`timed`, attempts).
- If a step is abandoned after `STEP_GRACE_MS`, the old `Builder.run()` keeps going. Its `stopped()` reads the shared flag, which the next attempt's `tracked("build")` → `begin()` clears. Two builders then place and strip scaffolds on the same site.
- `BUILD_TIMEOUT_MS` (14 min) × 3 attempts = 42 min, past `JOB_MAX_MS` (checked only in `runGoals`).
- `resite` re-calls `prepare` with the old `spec.avoid` and anchor. A player who walked into the area after minutes of gathering is not avoided, and gets walled in around.
- Fix: a per-attempt `AbortController` aborted on abandon. Deadline = min(attempt budget, job deadline). Refresh `avoid` from `bot.players` before every `prepare`.

**M8. The silent-turn nudge can make a false claim.** `claude-backend.ts:629-638`.
- The nudge runs as a fresh task with no memory of the failed turn. It tells Haiku to say "what you're doing", so Haiku says "on it" although nothing was started (the earlier turn only planned in text).
- No loop and no double reply: `followUpQueued` blocks a second nudge, and `hasReplied` is per task. This is accuracy only.
- Fix: word it as "if you haven't started anything, say what you'll do or ask the one question; don't claim work you haven't begun".

## LOW

- `build.ts:507-531` `pickDigCell`: leaves 1-deep pits (up to ~10) in lawns and never refills them. It also digs player-placed dirt or grass blocks (top face only), which are not "crafted".
- `build.ts:301-316`, `blueprints.ts:20`: `wall`/`roof`/`floor` are only checked to be existing items. `water_bucket`, `torch` or `sand` pass and then fail 5 placements in a row. Validate "full solid placeable block" in `prepare`.
- `runner.ts:693,700`: after `resite` the stored `state.summary` and coordinates still show the old site, so the player is told the wrong location.
- `wire.ts` onEnd: a deliver failure caused by an absent player counts toward `ledgerFor(...).recordFailure` and, after 2, `achieve` refuses the same goals even though the bot holds them. Exclude `unreachable` hand-over failures.
- `blueprints.ts:163` portal `ignite`: fire is lit with grass/leaves/forest around (the margin only checks crafted blocks). A forest fire can reach a player's wooden build beyond 2 blocks. Require a non-flammable radius of 3.
- `auto-behaviors.ts:332`: until the first own air packet, `oxygenOf` falls back to `bot.oxygenLevel`, which other entities overwrite (the bug it works around). A false trigger needs a wet head, so the window is about one tick.
- `pathfinder-config.ts`: `LIQUID_COST` 8 is global. Short river crossings now prefer tunnelling or detours. Intended, but watch for chop/gather regressions near water.
- `tree-felling.ts`: `world-view` `count` is the fellable count only (<=64 scanned). It is just a `>0` check for the planner today, but it is easy to misuse later.

## Verified fine
- Footprint safety: `scanColumn` takes the first non-replaceable from `yTop` down. A player's planks/torch/sapling/chest/cobblestone/leaf in the footprint or overhead makes the column "bad", so no overlap with player builds. The crafted-neighbour ring adds a 1-2 block margin. `clearCells` only ever contains replaceables.
- The requester is excluded from the footprint ±1. The door is last and placed from outside, and the gap stays open until then, so the bot is not walled in. `door:false` leaves it open.
- Scaffold cells avoid blueprint and `clear` cells. `removeScaffold` skips cells that no longer hold `scaffoldItem`, so it will not dig an unrelated block. Scaffolds are reused, and the order prunes them.
- Watchdog opt-out: the Builder runs under `tracked(... watchdogMs: null)`. The deliver step uses `tracked` too. Its inner `navigate`/`placeBlock` are not `runSkill` calls.
- Lifecycle: cancel, `notifyStop` and the epoch race are shared with achieve. `build` is exempt from auto-cancel and the runner serializes starts. Dispose skips `onEnd`. `died` and `missing_input` break the retry loop. The `[job]` event cap and `finish` idempotence apply to build the same as to achieve.
- Creative `achieve`+`deliverTo`: `plan.ts:496` returns no steps, so `deliverOnly` is correct. Goal counts and held items are re-checked before the toss.
- Tree felling terminates: `unreachable` and `skip` sets, `LOG_SCAN_COUNT` bounded, cluster cap 200, floor scan 12. A trunk yields at most 5 logs per column. R4 `isTreeLog` still gates the actual dig in `findMineCandidate`, and ranking only reorders.
- `clearLeavesBelow` and the leaf/stump dig timers are cleared in `finally` (the H1 lesson from slice 2b is applied).
- Surfacing: creative and sleeping are skipped, and the early return avoids two reflex routines. `navigate` re-issues its goal at most 3 times and only when not aborted. The own-air read (`air_supply` / 15) is right. The suffocation test excludes leaves/glass/ice and partial shapes. `findRoofDig` refuses falling blocks.
- Nudge: one per task via `followUpQueued`, only for `success` results that are not interrupted, not follow-ups and not replied (per-task `firstReplyAt`). The nudge message itself is not "direct", so no loop.
