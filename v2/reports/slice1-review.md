# Slice 1 review (commit 5bc85c2)
Static review only; nothing run. Findings ranked by severity. Line numbers are in the 5bc85c2 tree.
## HIGH
### 1. The scoped digging retry almost never fires, so buried targets come back "unreachable" (a regression against v1)
`src/skills/world.ts:870-872` (`pathToBlock`) gates the dig retry on `getPathTo(...).status === "noPath"`.
- `getPathTo` only runs the first A* slice. `index.js:63-66` takes one `generator.next()`, and `astar.js compute()` returns `'partial'` after `tickTimeout` (40ms).
- `noPath` therefore means "the whole reachable region was exhausted in 40ms", which holds for sealed rooms and small pockets only. `movement.ts:50-53` says the same in a comment.
- The check script uses a sealed room, so it passes. The real world differs.
Scenario: `mineBlock iron_ore` on a hillside. `findBlocks` returns ore buried 8 blocks into stone, with no cave contact. The surface region is large, so the probe returns `partial` and `pathToBlock` calls `navigate` with the NO-dig Movements. After up to 5s `goto` rejects with "No path"/"Timeout". `mineOneBlock` flags it `unreachable` and no dig is ever tried.
- Six of those cost ~30s or more.
- The result is "could not reach any iron_ore".
- v1's intended behavior (tunnel to buried ore) is lost.
- The slice report's "ore under dirt / stone shelf" case works only in tiny enclosed spaces.
Fix, either of:
- (a) In `pathToBlock`, if `navigate` fails with no_path, timeout or "ended early" (not cancelled), and the target is natural, retry once inside `withDiggingMovements`.
- (b) Drain the probe generator, `for (r of bot.pathfinder.getPathFromTo(...))` until `status !== 'partial'`, under a ~1.5s budget, before deciding.
Do (a). It is cheap and also covers `timeout`. Add a check with a large open region plus a buried target.
## MEDIUM
### 2. Self-trapping after a scoped dig, or in any pit deeper than 3; no automatic escape
`world.ts:879` and `pathfinder-config.ts:94-113`. Once fix 1 makes digging fire, the dig variant can dig down (`getMoveDown`) and leave a vertical shaft.
- The base Movements has no dig, no place, and `maxDropDown=3`. A shaft deeper than 1 block, or any natural pit/ravine/old mineshaft drop deeper than 3, has no path out. v1 dug or towered out.
- The only recovery is the LLM choosing `pillarUp`. That needs filler blocks, which a bot that just fell into a pit may not have.
- Haiku has to improvise a stair-mine on its own.
- The report flags this itself ("watch that Haiku doesn't loop on no-path").
Fix, either of:
- A bounded escape fallback in `goTo`/`navigate`. If the probe says noPath/partial AND the bot is enclosed (walls on >=3 horizontal sides, or `y` more than 3 below the highest reachable surface), retry under `withDiggingMovements` with the structure guard on.
- Have `withDiggingMovements` reject descents deeper than N, or auto-`pillarUp` back out after a dig-down tunnel.
### 3. The "natural blocks only" guard is much weaker than the tool description claims
`pathfinder-config.ts:104` uses `builtStructureReason`. It only protects crafted-pattern blocks with a crafted neighbour, plus doors/gates/glass. The Movements `blocksCantBreak` only adds chest and undiggable blocks.
- The registry text says "never through player-built ones" (`registry.ts:212`).
- Unprotected cases for A* tunnelling:
  - a player's cobblestone/stone/dirt/log walls
  - furnace, crafting_table, barrel, trapped_chest
  - sign, farmland and crops, hay bale, torches, redstone parts
  - a dirt hut or cobble shed (the header comment confirms cobblestone is a "deliberate gap")
- Scenario: ore sits behind a cobble cabin wall. A* digs through the wall (a log cabin has only 1 crafted neighbour per log, and 2 are needed).
Fix: for the dig variant, add a break allowlist of natural terrain instead of a denylist: stone family, deepslate, dirt/grass/sand/gravel/clay, netherrack, ores, logs and leaves not adjacent to crafted blocks. Return 100 for everything else, including containers and workstations by name. Keep cobblestone out of the allowlist. Soften the description wording.
### 4. The Movements swap is process-global per Bot and is not serialized or ref-counted
`pathfinder-config.ts:107-111`. `withDiggingMovements` installs `st.digging`, then in `finally` restores `st.base` unconditionally. Nothing serializes skills per bot (no mutex in `harness.ts`/`skill-tools.ts`). Two ways to break it:
- (a) Parallel tool calls in one Haiku turn. Skill A is mid-`navigate` under the dig variant. Skill B (`goTo`, `mineBlock`) calls `setMovements(base)` in its `finally`, or enters its own scope. A's path is reset mid-tunnel and replans with canDig=false ("no path", marked unreachable). Conversely, B's `goTo` run during A's scope plans with digging ON, through walls the structure guard misses (finding 3).
- (b) The 10-min `runSkill` watchdog abandons the promise but not the work. The zombie `mineBlocks` keeps running and later restores base underneath the next skill. The next skill's `begin()` also clears the cancel flag the watchdog set, so the zombie resumes.
Fix: a per-bot skill mutex in `runSkill` (except `stop`). Failing that, a depth counter in `states` so the swap is restored only by the outermost scope, and restore to the previous instance rather than `base`. Also let the watchdog set a "generation" token that `mineBlocksInner` checks.
## LOW
### 5. `waitForDropNear` short-circuits on any existing item entity within 2.5 blocks (`inventory.ts:~76`)
A leftover drop from the previous block, or an item lying near the trunk, returns `true` immediately. The new drop spawns a few ticks later, after `pickUpNearby` has scanned.
- The end-of-run sweep (r=8) mostly hides this.
- But `collectedNow()<=before` can count the dig as fruitless, so 3 in a row falsely stops the batch.
- Fix: snapshot entity ids before `bot.dig` and wait for a NEW id. Listener and timers are cleaned in `finish()`; no leak found.
### 6. `count` is now items, and the drop mapping misfires for some blocks
`expectedDropNames` uses the first/only drop id per block.
- Multi-yield ores (lapis 4-9, redstone 4-5, raw copper 2-5, glowstone, melon): `mineBlock lapis_ore count=2` stops after 1 block. This contradicts the `mineBlocks` param doc "Total blocks to mine" (`world.ts:~84`).
- `wheat` maps to `wheat_seeds` only, so mature-crop harvests read as fruitless or short. Silk-touch tools make stone read as 3 fruitless digs and a false failure.
- Fix: for multi-yield or odd cases fall back to dig counting for the loop condition and use the delta for reporting only, or document it clearly.
### 7. Tool-less targets tunnel before the tool check
The harvest preflight (`world.ts:~170`) samples one block. If no sample is visible, the dig-tunnel (fix 1) happens before `equipBestHarvestTool` fails with "lost the tool". It stops cleanly, with no loop, but the tunnel is wasted. Run `checkHarvestability` on the candidate in `mineBlocksInner` before `mineOneBlock`.
### 8. Aliases
- `chat-router.ts mentionsName` / `isStopCommand` use `\bsteve\b`:
  - It matches "Steve's", "hey steve", and anything addressed to a human player named Steve (so "steve stop" also preempts the bot's task).
  - It does not match "steve_ai", because `_` is a word character.
  - This is inherent to the feature; consider requiring the sender != alias.
- `config.ts:~56` checks collisions only among configured aliases and usernames. It ignores derived suffix-stripped names: `Steve_AI` (derived "Steve") and `Steve_v2` (alias "steve") would both answer.
- `ALIAS_RE` allows any 2-char word ("me", "ok", "ai"). Consider a stop-list: `all`, `stop`, `bot` and similar.
- `registerBotAliases` is global module state set inside `loadConfig`. `resetChatRouter()` clears it, so a test or hot reload that resets after config load silently loses aliases.
## Looks good
- `cancellation.begin()` removal is safe. Every production caller reaches `mineBlocks` via `registry.ts withParams -> runSkill` (`harness.ts:85` begins first). `local-`/`hybrid-backend` call `begin()` themselves, and no other module calls `mineBlock(s)`. The remaining begin sites (`followPlayer`, `survival.ts:160`) are unaffected.
- Reconnect: a new Bot object is a new `WeakMap` and door-assist `WeakSet` key, so it gets a fresh base and digging pair. A stale entry belongs to a collected Bot and does no harm. `ensureMovements` heals a foreign instance, and every pathfinder entry point (`goTo`, `navigate`, `follow`, `attack`, `flee`) calls it.
- The scoped override restores in `finally` on exceptions and on stop. `navigate` itself clears the goal on cancel, and `ensureMovements` inside `navigate` recognises `st.digging` and does not "heal" it away.
- The door patch is applied to the dig variant via `buildMovements(bot, true)` with its own `strict` closure. Doors, gates and trapdoors return 100 under the guard, so A* routes through doors rather than breaking them.
- Nothing else calls `setMovements`. `scafoldingBlocks=[]` is the right switch for "A* never places".
- Inventory-delta counting:
  - It is by name and summed across stacks, so auto-stacking is fine.
  - `count` is measured against a baseline taken at skill start, so holding some already is correct.
  - stone->cobblestone, ore->raw, grass->dirt, and gravel (flint is not in this data) are all right.
  - Leaves, glass and ice have no drops, so they fall back to dig counts.
  - Creative uses dig counts.
- Tool-less hand-mining cannot loop forever. With a visible sample, the preflight skips it. Without one, `equipBestHarvestTool` fails the batch. Tracked blocks that dig fine but yield nothing hit the 3-fruitless stop (`world.ts:~365`). A full inventory ends in the same stop with an "inventory is full" message.
- `waitForDropNear`: `finish()` clears the timer, the interval and the `entitySpawn` listener, and it is idempotent.

## Fixes
Offline only (typecheck + stub checks); nothing run live.
1. **HIGH, dig retry** (`world.ts pathToBlock`): navigate first; on `no_path`/`stuck`/`timeout` (new `state.failure` on `navigate` results, `navFailureOf`) toward a natural target (`isNaturalTerrain` or log/wood, or `allowStructures`) retry ONCE under `withDiggingMovements`. A dig `getPathTo` that says definite `noPath` skips the walk. `noPath` from the first probe goes straight to the dig probe. One retry per `pathToBlock` call; a failed target is flagged unreachable and not retried. Checks: `gather-counting` 4c (partial probe + rejecting no-dig goto, gotos = [nodig, dig] per target) and 4d (dig also fails: still one retry).
2. **Natural-only digging** (`structure-guard.ts isNaturalTerrain`, `pathfinder-config.ts naturalOnlyCantBreak`): the dig variant's `blocksCantBreak` is every block NOT on the allowlist (stone family, deepslate, tuff, calcite, dripstone, dirt/grass/coarse/podzol/mycelium/mud, sand/red_sand/gravel/clay/sandstone/red_sandstone, badlands terracotta, netherrack/basalt/blackstone/soul sand/end_stone, snow/ice/moss, `*_ore`, `*_leaves`) plus non-diggable. Logs, cobblestone, planks, glass, wool, beds, containers, workstations are never dug by A*. The old structure guard stays as a second layer. `world.ts` has no wording claim to fix. **registry.ts (off-limits) mineBlock text** "may tunnel a short way through natural blocks ... never through player-built ones" is now accurate but could say "natural terrain only (stone, dirt, sand, gravel, ore; never logs, cobblestone or anything player-made)".
3. **Escape** (`navigation.ts`): `navigate()` takes `escape?: "full"|"pillar"|"none"`. After a `no_path` failure, if `isBoxedIn` (bounded flood fill: step-up 1, drop <=3, doors passable, gives up at 150 cells / 6 radius; not on ground or in liquid = false): pillar up (<=6 blocks, filler from inventory) and re-navigate; else one dig-out navigate under the natural-only dig variant (skipped if a dig scope is already open). One attempt per call; each step emits the existing `pillar`/`nav` events (labels "(after pillar escape)"/"(dig-out escape)"). `pathToBlock` uses "pillar" for its first attempt (its own dig retry covers digging) and "none" for the retry. Checks: movements-lifecycle 10/11 (real-block pits, sealed room, ramp, door; escape runs exactly once, none/pillar modes, open ground = no escape). The pillar branch is not exercised offline (needs physics).
4. **Movements race** (`pathfinder-config.ts`): per-bot `depth` + `strict` counters, so base is restored only when the outermost scope exits; the structure guard stays on while any open scope wants it. `resetMovementsToBase(bot)` (called by the harness watchdog when it abandons a skill) zeroes the counters and bumps a generation so the zombie's later `finally` is a no-op. `ensureMovements` also resets a scope older than `DIG_SCOPE_MAX_MS` (6 min) and heals a stray digging instance with no open scope. Checks: nested, overlapping, throw, zombie, timestamp, strictness. **Mutex:** still recommended (not added). Overlapping skills still share one Movements per bot, so a parallel `goTo` during another skill's dig scope plans with natural-only digging on, and `pillarUp`/dig/equip calls can interleave. The counter only stops early restoration. A per-bot skill mutex in `runSkill` (except `stop`) is the real fix.
5. **LOW**: `waitForDropNear` now ignores item entities that already existed (`snapshotItemIds` taken before the dig, passed from `mineOneBlock`; default is a snapshot at call time). Aliases: `registerOnlinePlayers(bot, () => names)` in the router, wired by one line in `mineflayer-glue/event-hooks.ts` (`Object.keys(bot.players)`); a derived or configured alias is dropped while a non-bot player with that exact name (case-insensitive) is online, which also stops "steve stop" from preempting; the full username is never dropped. Derived suffix-stripped names are now collision-checked in `config.ts` against other bots' usernames/aliases (`Steve_AI` + alias `steve` throws). Checks added in `aliases.check.ts`.
Not done: findings 6, 7 and the `ALIAS_RE` stop-list/`resetChatRouter` notes (out of scope for this pass).
Run the checks from a scratch cwd with `BOT_TELEMETRY_DIR` set (gather-counting and movements-lifecycle both touch telemetry/state).
