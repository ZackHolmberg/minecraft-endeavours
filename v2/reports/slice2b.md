# Slice 2b report: job runner, step executors, `achieve`

Status: built, unit-tested (97 tests, `npm run typecheck` clean, eval `--dry --suite all`: 0 BROKEN/SUSPECT) and 3/3 on the live target scenarios.

## Design as built
- `src/jobs/runner.ts` `JobRunner`: state machine over injected deps (`RunnerDeps`), so it is tested with fake executors (`runner.test.ts`, 14 cases). `start()` (:~110) builds a view, plans, refuses empty/unresolved plans (returns `AchieveResult{ok:false}`), persists `job.json`, runs async. Plan exhausted => verification re-plan against a fresh view (empty plan = done). `cancel()` flips status at once, aborts, requests stop and awaits the in-flight step (<=35s). `notifyStop()` = the bot's CancellationFlag callback; runner's own stops are ignored via `internalStop`. Step timeout per op (`stepTimeoutMs`), job cap 30 min. Boot: leftover `running` => `interrupted` (+ `job_end`).
- `src/jobs/recovery.ts` (pure ladder, `decideRecovery`): retry once (unreachable/timeout/internal/hostile/station) -> re-plan (<=5/job, once per step episode) -> `no_source`: widen scan 64->96->160 -> explore (<=2 runs) -> fail with failure + remaining plan. Episodes keyed by op|item|count|blocks; the postcondition baseline is captured once per episode (retries after partial progress don't overshoot).
- `src/jobs/steps/{gather,craft,smelt,withdraw,place-station}.ts`: each calls the v1 skill through `runSkill` (telemetry, cancellation reset, current-tool, action log), verifies by inventory delta / placed block, and maps the skill message to a `FailureKind` in `steps/classify.ts` (regexes over real v1 messages; tested). gather = slice-1 `mineBlocks` with natural blocks first (`stone` before `cobblestone`), loops until delta met. smelt chunks to 64.
- `src/jobs/world-view.ts`: inventory incl. armor/offhand (slots 5-8, 9-44, 45), gameMode, per-type `findBlocks` (count 8) over logs/stone family/ores/sand/gravel/etc + the blocks of a pass-1 plan, radius 48 (96/160 on widen), stations <=32, containers from `world.json`, position, dimension.
- `src/jobs/explore.ts`: surface = square-spiral legs 40,40,80,80,120,120 in 20-block hops with re-scan (<=6 legs, 6 min). underground = staircase (3 cells/step, never straight down) to the hint window's mid Y, then a rake of 2-high tunnels (24 long, 3 apart), re-scan every 3 cells within 10 blocks, <=140 cells/10 min. Hand-rolled digging (not `withDiggingMovements`) so each cell is checked first: natural-diggable whitelist, no water/lava in any of the 6 neighbours, structure guard, solid non-magma floor, no pits. No torches.
- `src/jobs/tools.ts`: `achieve` (names validated via `resolveItem` with did-you-mean, duplicates merged, requester = conversation partner) and `cancelJob`, registered in `skills/registry.ts` (end of `SKILL_SPECS`). `shouldCancelJobFor` + `JOB_EXEMPT_TOOLS` (pure, tested).
- Auto-cancel: `agent/skill-tools.ts` `withJobAutoCancel` wraps every tool; non-exempt call while a job runs => `runner.cancel()` (awaited) then the tool, result prefixed "your running job ... was cancelled".
- Stop paths: `state/cancellation.ts` gained `onRequest(listener)`; `jobs/wire.ts` subscribes `runner.notifyStop`, so the stop skill, chat preempt, death and watchdog all end the job as `cancelled`. `npc-agent.ts maybeInterrupt` also cancels a job on a stop chat when no Haiku event is running. `claude-backend.ts waitForToolIdle` returns at once while a job runs (otherwise a mid-job chat would spend 35s cancelling it).
- Re-entry: `NpcAgent.pushJobEvent` -> `backend.pushUserMessage`; text from `jobs/describe.ts formatJobEvent` (`[job finished] achieve iron_pickaxe x1 — done in 4m12s (requested by Alex ...)`, `[job failed] ... failure: no_source — ...; remaining plan: ...`). Cancelled/interrupted: no event. Telemetry route `job-event`.
- Context: `planning-context.ts buildAgentContext` adds `# Current job` (running: goals/progress/requester; ended <2 min: outcome). System prompt: recipe + tool-tier text replaced by a 4-bullet achieve section (prompt 10,071 -> 10,413 chars; a full rewrite is a later slice).
- Telemetry (additive): `job_start`, `job_end`, `step`, `recovery` in `telemetry-types.ts`; display cases in `web/ui/.../Events.tsx` (lead's request). `bot.log` gets one `job ...` line per milestone (`jobs/wire.ts`).
- Eval: `eval/telemetry.ts jobState`, `eval/ctx.ts waitForDone` treats an open job as busy and starts the quiet window at `job_end`. v1 emits no `job_*`, so v1 behaviour is unchanged.
- Planner fix: fuel prefers planks over logs (`plan.ts chooseFuel`; 1 log = 4 planks = 6 smelts); 3 tests in `plan.test.ts`.
- `jobs/types.ts` unchanged. Entry: `src/index.ts` attaches a runner per connection (`attachJobRunner`), disposes on shutdown.

## Live results (`v2/runs/v2-s2b-dev3-*`, fresh world, 1 rep, Haiku 5.5)
| scenario | ok | wall | turns | tokens in/out | cost | notes |
|---|---|---|---|---|---|---|
| t2.wooden_pickaxe | PASS | 25s | 5 (2 tasks) | 119k / 402 | $0.004 | v1 baseline: pass, 20s, 5 turns |
| t2.stone_pickaxe | PASS | 40s | 5 | 116k / 529 | $0.006 | v1 baseline: FAIL, 46s, 20 turns |
| t3.iron_pickaxe | PASS | 225s | 5 | 146k / 426 | $0.007 | v1 baseline: FAIL, 163s, 21 turns; 12 steps, 1 replan |
Haiku does 2 tasks x ~2 turns (achieve + say, then the `[job finished]` note). Two earlier runs (dev, dev2) failed and found the bugs below.

## Bugs found live (all fixed)
1. **3x3 table crafts silently no-op (v1 bug too).** mineflayer 4.39 fires its window clicks back to back; on 1.21 the server resyncs and rolls back (`crafted 1 wooden_pickaxe`, nothing in inventory; reproduced with a raw `bot.craft` spike, 0/3 at 0 ms, 3/3 at 60-150 ms). v1's craftMany hid it behind Haiku retries (see v1 baseline stone_pickaxe log). Fix: `skills/paced-clicks.ts` (120 ms after each click) used in `crafting.ts runCraft`. The postcondition check is what exposed it.
2. Client inventory trails craft/place/withdraw by ticks: `steps/util.ts settleCount` (<=3 s) and a block-present check for stations.
3. Planner chose bamboo for sticks/planks in jungle: +6 cost penalty (test added). Planks-as-fuel fix from the brief done (`plan.ts chooseFuel`).
4. v1 `smelt` reported "furnace ran out of fuel" while the only coal was burning (fuel slot empties on lighting): now checks `furnace.fuel > 0` (`crafting.ts`). Fixed after the last live run; not re-run live.

## Failure analysis / things to know
- t3 took 1 replan: the false out-of-fuel smelt failure (bug 4) left 3 raw_iron in the furnace, the replan re-mined them (+61 s).
- Violations in the summary: `pillar` 1 (stone) and 5 (iron) from `mineOneBlock`/nav-escape pillaring in `world.ts`/`navigation.ts` (slice-1 review code), not from jobs. Score unaffected but `pl.*`-style scenarios will count them.
- World view costs 0.7-1.4 s per build (~50 `findBlocks`); runs at start and each replan.
- Underground explore, surface explore, widen and the 160-block ladder were exercised only in unit tests (the live scenarios had ore in range); no live run of `explore.ts`.

## Known gaps
- Job steps' `skill` telemetry lands in the open Haiku task's tool counters if they overlap (first ~seconds after `achieve`).
- Haiku read-only tools (`say`, `observeSurroundings`) run `runSkill`, which resets the shared current-tool entry/cancel flag while a step runs; stop still works through the flag subscription, but the dashboard's DOING line can blank.
- Explore: no torches, no mob handling beyond v1 reflexes, ore detection ignores exposure, only digs down (never up).
- World memory sightings are not used; mob drops, farming, Nether unsupported (planner marks unresolved => `achieve` refuses).
- `withDiggingMovements`/`isNaturalTerrain` (lead note) not used by explore: it digs by hand under stricter per-cell rules.
- Registry-first import order still hits the v1 import cycle (`Cannot access 'SKILL_SPECS'`), unchanged.

## Slice 2c suggestions
Real prompt rewrite and tool-surface trim; torches + lighting underground; sightings from world memory; exposed-ore filter; mob-drop gathering (leather, string, food); keep a plan cache; per-step progress in the context from live inventory.
