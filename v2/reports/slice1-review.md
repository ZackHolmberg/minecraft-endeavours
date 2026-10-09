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
