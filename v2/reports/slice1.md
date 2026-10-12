# Slice 1 report: honest primitives

All validated offline (typecheck clean; 3 stub scripts pass). No bot/eval/docker started, no commits.

## Changes
1. **Movements lifecycle** - `src/skills/pathfinder-config.ts:60-92`. State is a `WeakMap<Bot, {base, digging?}>`, so each Bot object (incl. post-reconnect) gets `buildMovements()` once, installed via `setMovements`. `ensureMovements` also heals if anything installs a foreign instance (nothing else calls `setMovements`; grep clean: only `setGoal`/`getPathTo` elsewhere). `maxDropDown` (3 / creative 8) is still re-read every call. Now actually applied: canDig=false, allow1by1towers=false, liquidCost=3, door patch.
   - **Placing policy (`:138`)**: `allow1by1towers=false` alone does NOT stop A*; `getMoveForward`/`getMoveJumpUp` still place dirt/cobblestone to bridge gaps and step up (`scafoldingBlocks` defaults to dirt+cobblestone, upstream spelling). Policy: **A* never places** (`scafoldingBlocks=[]`). Building/climbing is explicit (`placeBlocks`, `pillarUp`). Proven: trench with 64 cobble in inventory -> no `toPlace` in any path node.
   - **Scoped digging**: `withDiggingMovements()` (`:94`) installs a digging variant (same door patch, no placing, `exclusionAreasBreak` = `builtStructureReason` unless `allowStructures`) and restores base in `finally`. Used ONLY by `pathToBlock` (`world.ts:866`): if a natural mine target has no walkable approach, one retry with digging (ore under dirt, stone shelf). Never global.
   - Skills that "need digging": mineBlock approach (covered by scoped retry), target dig (`bot.dig`, unaffected), pillar-out-of-water (own `pillar.ts`, unaffected). There is no separate "escape hole" skill; a hole deeper than 1 now gives no-path and the model must use `pillarUp` (before, A* towered out silently).
2. **Gathering = inventory delta** - `world.ts:130-379`, `inventory.ts:33-170`.
   - `waitForDropNear` (`inventory.ts:76`): entitySpawn listener + 120ms re-scan, max 600ms; called after each dig (`world.ts:515`), then `pickUpNearby` r=4.
   - Progress = sum of gains of expected drops (minecraft-data `drops`: stone->cobblestone, iron_ore->raw_iron, logs->self) over a pre-skill baseline; blocks with no drop data (creative/leaves) fall back to dig count. Loop runs until gained >= count or no candidates. Message: `collected 10 oak_log (mined 11)` (parenthetical only when they differ); `state.{mined,collected,gained,unreachable}`.
   - End-of-run sweep (r=8) for dug-but-uncollected drops. 3 consecutive digs that yield nothing -> stop with ok:false ("inventory is full" if so).
   - Unreachable candidates (path fail) are skipped, not fatal (max 6). All-unreachable -> "could not reach any X".
   - `pickUpNearby` now reports inventory delta (`state.gained`), does a second pass for late spawns, notes full inventory.
   - Removed the `cancellation.begin()` at old `world.ts:201` (verified: `runSkill` already begins at `harness.ts:85`, so it only ever wiped a stop that landed during preflight).
3. **Aliases** - `config/bots.yml` (`aliases: [steve]` on Steve_v2), `config.ts` (validate list, 2-16 `[A-Za-z0-9_]`, dedupe, reject collisions across bots; registers with router inside `loadConfig`, so eval/bot-process get it), `chat-router.ts:133-158` (`registerBotAliases`, `nameAliases` = username + derived suffix-stripped + configured). The "other bot named -> not for me" loop and `isStopCommand` use the same `nameAliases`, so they stay consistent.
4. **Prompt/tool wording** - `registry.ts` goTo (no digging AND no placing/bridging/towering), mineBlock (collected-count semantics, arm's reach ~4 high, skips unreachable, may tunnel through natural blocks only), mineBlocks (state fields), pickUpNearby. `system-prompt.ts` Gathering line (was "Don't climb trees; mineBlock reaches the high logs itself" - false: it never could climb) and the pathfinder line. Hybrid/local prompt copies left alone (dead).

## Validation
- `npm run typecheck` clean.
- `npx tsx src/skills/__checks__/movements-lifecycle.check.ts`: real pathfinder plugin on a fake bot. Asserts the bug precondition (default has `.bot===bot`, canDig, solid door), then canDig/towers/door patch/scaffolding after `ensureMovements`, once-only, reconnect (new Bot), healing, scoped digging + restore on throw, structure guard; real A*: default tunnels into a sealed room, ours = noPath, scoped dig = success, door = way in.
- `npx tsx src/orchestrator/__checks__/aliases.check.ts`: config + router, two-bot cross-alias, validation errors.
- `src/skills/__checks__/gather-counting.check.ts`: run from a scratch cwd (state persistence writes `./data/`): `cd $(mktemp -d) && BOT_TELEMETRY_DIR=$PWD/tele <repo>/node_modules/.bin/tsx <repo>/src/skills/__checks__/gather-counting.check.ts`. Fake bot with delayed drop spawn (200ms), lost drops, unreachable blocks, full inventory, stop mid-skill and stop-before-start. All pass. NOT covered: real server drop timing, real pickup walking.

## Watch in the live benchmark
- `t2.door_house` / `t2.door_exit` / `pl.no_grief`: should improve (door cell now passable to the planner, walls not diggable). Risk: if the door assist misses, the bot now reports no-path instead of tunnelling; the old "stuck" hint already says find the door.
- `t1.chop_logs`: counts now honest, so a prior "10/10" may show as e.g. 6-8 if pickup is flaky. Tall trees: only ~4 logs/trunk reachable, so the loop hops trees; slower, possibly more nav time. Watch the 3-fruitless-digs stop and `collected N (mined M)` gaps.
- `t1.mine_stone`: usually exposed stone works; buried stone goes through the scoped dig retry. If the surface is thick dirt it may take the dig-tunnel path (slow, check `nav` events).
- `pl.stairs_not_pillar`: A* no longer places or towers at all; any pillar now comes only from a deliberate `pillarUp`. Should pass; watch that Haiku doesn't loop on no-path with no recovery (prompt still lists pillarUp for holes).
- `int.stop`: the swallowed stop is fixed; mining returns "mining cancelled: ..." after the current block. Dig itself is still not interruptible (up to 30s).
- Latency: +<=600ms per block when a drop never spawns (e.g. wrong tool), +~0.3-0.6s per pickup walk.

## Surprises
- `scafoldingBlocks` (sic) is the real upstream property; setting it empty is what disables placement.
- Placing was a second hidden policy gap beyond digging: with the buggy default the "dirt staircases" came from `getMoveJumpUp`/`getMoveForward` placement, not only 1x1 towers.
- `block.drops` for bookshelf lists `book` once (really 3), lapis/redstone drop several: delta can exceed `count`, so the loop may stop with more than requested.
- `package.json`/`package-lock.json` show as modified in the worktree; not from me.
