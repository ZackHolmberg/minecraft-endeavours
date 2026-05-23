# Skills

Reference for the v0.2 skill layer. Every skill is a plain async function:

```ts
(bot: Bot, params: P) => Promise<SkillResult>
```

and returns the same shape regardless of success:

```ts
{ ok: boolean, message: string, state?: object }
```

**Failure messages are written for Claude's consumption** — they must be specific enough that the model can adapt (`"no oak_log within 64 blocks"`, not `"failed"`). Wrap every call site in `runSkill(bot, name, params, fn)` so unexpected exceptions become `{ ok: false, message }` results instead of taking down the bot. `runSkill` also:
- records successful, non-noisy results to the bot's [recent-actions log](../src/state/actions-log.ts),
- flips the conversation-continuity flag when `say` / `whisper` produces a `?`-terminated message,
- tracks the in-flight skill name on `BotState.currentTool` (in a `try / finally`, so it always clears) — the v0.3 dashboard reads this for its live `DOING` field.

For higher-level design (catalogue, principles, push-work-down-the-stack), see [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

| Skill | Status |
|---|---|
| `say`, `whisper`, `observeSurroundings`, `goTo`, `mineBlock` | ✅ Implemented in slice 2 |
| `remember`, `setTaskQueue`, `advanceTaskQueue` | ✅ Implemented in slice 3 (phase 2) |
| `stop`, `followPlayer`, `placeBlock`, `pickUpNearby`, `dropItem`, `giveItemTo` | ✅ Implemented in v0.3+ priority batch |
| `craft`, `attack`, `flee`, `depositToChest`, `withdrawFromChest` | ✅ Implemented in v0.3+ follow-on batch |
| `findBlock`, `findEntity`, `checkInventory`, `lookAt`, `activateBlock`, `equipItem`, `wait` | ⏳ Pending |

The slice-2 `!cmd` chat-trigger harness was removed in slice 3 (phase 5) — skills are now exercised through the Claude agent loop. See ["Exercising skills"](#exercising-skills) at the bottom of this file.

## Reference

### `say` — public chat output

```ts
say(bot, { message: string }): Promise<SkillResult>
```

Sends `message` on public chat. Trimmed; truncates silently at 256 chars (`state.truncated` is `true` when this happens).

| | |
|---|---|
| Success | `said "<message>"` |
| Failures | `empty message` |

`state` includes `sent` (the actual chat content sent) — used by `runSkill` to detect `?`-terminated questions for the conversation-continuity heuristic.

---

### `whisper` — private chat output

```ts
whisper(bot, { player: string, message: string }): Promise<SkillResult>
```

`/msg`-equivalent. Same length / trim rules as `say`. Fails fast if `player` isn't currently online (`bot.players[player]` check).

| | |
|---|---|
| Success | `whispered to <player>` |
| Failures | `empty message` · `player "<name>" is not online` |

Like `say`, includes `sent` in state for the question-continuity hook.

---

### `observeSurroundings` — perception ("look around")

```ts
observeSurroundings(bot, { radius?: number }): Promise<SkillResult>
```

Claude's primary `look around`. Pre-aggregates so Claude doesn't have to: groups blocks by name with count + nearest coords, sorts entities (player → hostile → passive) and caps at 10, rolls up dropped items, computes facing as a cardinal direction, classifies time of day, returns weather.

| Param | Default | Notes |
|---|---|---|
| `radius` | `16` | Search radius in blocks. |

**Block allowlist:** trees (`*_log`, `*_wood`), ores (`*_ore`), water/lava, crafting/furnace/smithing variants, chest family (chest, barrel, shulker, ender_chest), beds, doors/trapdoors, portals, spawner, respawn anchor, lodestone, beacon. **Never returns a raw voxel grid.**

**State fields now live (slice 3, phases 1–2):**
- `recentActions`, `recentlySeenPlayers`, `currentTask`, `remainingTasks` — sourced from the in-process state stores (`src/state/actions-log.ts`, `player-presence.ts`, `task-queue.ts`).
- `knownStorage` — sourced from `data/orchestrator/memory/<bot>/world.json` (the `containers[]` section). Stays empty until container auto-capture lands; the `remember` skill writes only to `pois[]`.

| | |
|---|---|
| Success | `<N> block group(s), <M> entit(ies) within <radius> blocks` |
| Failures | None expected — read-only. Exceptions are caught by `runSkill` and become `observeSurroundings crashed: <msg>`. |

**State shape:** `position`, `dimension`, `facing` (cardinal), `time` (`{ timeOfDay, phase }`), `weather`, `status` (`health/food/saturation/experience/isInWater/isOnFire`), `heldItem`, `nearbyBlocks`, `nearbyEntities`, `nearbyDroppedItems`, `knownStorage`, `recentActions`, `recentlySeenPlayers`, `currentTask`, `remainingTasks`. See `src/skills/perception.ts` for the full TS interface.

---

### `goTo` — pathfind to a target

```ts
goTo(bot, { target: GoToTarget, reach?: number }): Promise<SkillResult>
```

Polymorphic target via a discriminated union:

```ts
type GoToTarget =
  | { kind: "coords"; coords: { x, y, z } }
  | { kind: "entity"; entity: string }   // player username, or mob name
  | { kind: "block"; block: string };    // block ID, finds nearest within 64
```

Pre-checks reachability with `pathfinder.getPathTo()`. If the path computation reports `status === "noPath"`, fails fast without committing to a doomed walk — this is the architectural "doomed action" pre-check from the push-work-down-the-stack table.

| Param | Default | Notes |
|---|---|---|
| `reach` | `1` | Stop when within this many blocks of the target. |

| | |
|---|---|
| Success | `arrived near <label> at (x, y, z)` |
| Failures | `entity "<name>" not visible to the bot` · `unknown block type "<name>"` · `no <block> within 64 blocks` · `no path to <label> at (x, y, z)` · `pathfinding to <label> failed: <msg>` |

---

### `mineBlock` — composite mining (find → path → equip → dig → pickup)

```ts
mineBlock(bot, { type: string, count?: number }): Promise<SkillResult>
```

The canonical composite skill. Proves the skill model: one Claude tool call ≈ one meaningful task, ~5–6 mineflayer primitives hidden inside.

Workflow per iteration:
1. `bot.findBlock` for the nearest block of `type` within 64 blocks.
2. Path to it with `GoalLookAtBlock`.
3. Equip the first inventory item that satisfies `block.canHarvest(item.type)` (rough proxy for tier — picks the last match, replace with `digTime` comparison if it picks badly).
4. `bot.dig(block)`.
5. 500ms pause so the natural ~1.5-block server auto-collect can fire.

| Param | Default | Notes |
|---|---|---|
| `type` | — | Required. Block ID (e.g. `oak_log`, `stone`). |
| `count` | `1` | How many to mine. |

**Tool pre-flight:** before any movement, probes one block of the requested type and checks `block.canHarvest(null)` (no tool needed) → any inventory item via `canHarvest`. If neither holds, fails fast with the tool family pulled from `block.material` (e.g. `"no pickaxe in inventory to mine stone"`). No half-walk-then-fail.

| | |
|---|---|
| Success | `mined <N> <type>` |
| Failures | `unknown block type "<name>"` · `no <type> within 64 blocks` · `no <tool> in inventory to mine <block>` · `mined <i> of <N> <type>; no more within 64 blocks` · `no path to <block> at (x, y, z)` · `dig failed at (x, y, z): <msg>` · `count must be >= 1, got <n>` |

**Partial progress:** failure results include `state: { mined: <count> }` so the caller knows how far the skill got.

**Known limitations:**
- Tool selection picks the last `canHarvest` match in inventory rather than computing fastest dig time.

**Drop pickup:** the prior 500ms post-dig wait was unreliable for blocks like sand. Each iteration now invokes `pickUpNearby({ maxDist: 4 })` after the dig, which walks to any dropped items in range so natural ~1.5-block auto-collect fires. Standalone `pickUpNearby` remains useful for "pick up what I just dropped" or after a mob fight.

---

### `remember` — record a POI to per-bot world knowledge

```ts
remember(bot, { type: string, name?: string, pos?: Coords }): Promise<SkillResult>
```

Writes a point of interest into `data/orchestrator/memory/<bot>/world.json` under `pois[]`. `pos` defaults to the bot's current position (rounded to integer blocks) so Claude doesn't need to look up coords first. Idempotent on (`type`, `position`): a duplicate `remember` reports "already remembered" without writing a second entry. Source on every Claude-driven entry is `"claude"`; the `"auto"` source is reserved for event-hook capture (deferred).

| | |
|---|---|
| Success | `remembered: <type> "<name>" at (x, y, z)` · `already remembered: <type> "<name>" at (x, y, z)` |
| Failures | `type is required (e.g. base, portal, bed)` · `no position available — bot has no entity yet` |

---

### `setTaskQueue` — declare a multi-task plan

```ts
setTaskQueue(bot, { tasks: string[] }): Promise<SkillResult>
```

Replaces the bot's task queue with the supplied list. The first task becomes `currentTask`; the rest become `remainingTasks`. Both are surfaced in every subsequent `observeSurroundings` so Claude reads its own plan back from the world instead of from conversation memory. Empty strings in the input are trimmed.

| | |
|---|---|
| Success | `task queue set (<N> tasks); current: "<task>"` |
| Failures | `tasks must be a non-empty array of strings` · `all tasks were empty after trimming` · `no state registered for this bot` |

---

### `advanceTaskQueue` — mark the current task complete

```ts
advanceTaskQueue(bot): Promise<SkillResult>
```

Drops the current task and promotes the next one. Returns `task queue drained` when nothing is queued.

| | |
|---|---|
| Success | `advanced; current: "<task>"` · `task queue drained` |
| Failures | `no state registered for this bot` |

---

### `stop` — cancel current movement and any in-flight long-running skill

```ts
stop(bot): Promise<SkillResult>
```

Flips the per-bot cancellation flag (so tick-loop skills like `followPlayer` / `attack` / `flee` exit on their next iteration) and cancels any active pathfinder goal. Safe to call when nothing is in flight — each cancellable skill resets the flag on entry.

There is also a **side-channel** in `mineflayer-glue/event-hooks.ts`: when a cancellable skill is in flight and the current conversation partner sends a message matching `/\b(stop|halt|wait)\b/i`, the cancellation flag flips immediately so the skill exits without waiting for the message to drain through the (queued) agent loop. The message still flows through normal dispatch so Claude sees it on the next turn. This is what makes "stop" actually work despite `mineBlock` / `followPlayer` blocking the agent loop.

| | |
|---|---|
| Success | `stopped` |
| Failures | None. |

---

### `followPlayer` — sustained follow until cancelled

```ts
followPlayer(bot, { player: string, dist?: number }): Promise<SkillResult>
```

Sets a dynamic pathfinder `GoalFollow(entity, dist)` and parks in a tick loop. Returns only when the cancellation flag is set (player says "stop"/"halt"/"wait", or Claude calls the `stop` skill) or when the player leaves the server. Blocks the agent loop — chat that arrives mid-follow queues normally, the side-channel handles the preempt.

| Param | Default | Notes |
|---|---|---|
| `player` | — | Required. Player username; the player's `bot.players` entity must be visible at call time. |
| `dist` | `2` | Follow distance, 1–16 blocks. |

| | |
|---|---|
| Success | `stopped following <player>` |
| Failures | `player name required` · `dist must be between 1 and 16, got <n>` · `player "<name>" is not visible to the bot` · `lost sight of <player> (left server or moved out of range)` |

---

### `placeBlock` — place an inventory block at a target position

```ts
placeBlock(bot, { type: string, position: Coords }): Promise<SkillResult>
```

mineflayer's `bot.placeBlock` needs a reference block + face vector, not a target coordinate, so this skill probes the six adjacent positions for the first solid neighbor, derives the face vector from there, paths within range, equips the item, and clicks. Neighbor preference order: bottom → top → N → S → W → E.

| | |
|---|---|
| Success | `placed <type> at (x, y, z)` (state includes `against: <neighbor block name>`) |
| Failures | `type is required` · `position is required` · `unknown block item "<name>"` · `no <type> in inventory to place` · `(x, y, z) is already occupied by <block>` · `no solid neighbor at (x, y, z) to place <type> against` · `couldn't reach a placing position for <type> at (x, y, z): <msg>` · `failed to equip <type>: <msg>` · `place failed at (x, y, z) (against <block> <face>): <msg>` |

---

### `pickUpNearby` — sweep dropped items in range

```ts
pickUpNearby(bot, { maxDist?: number }): Promise<SkillResult>
```

Snapshots the dropped-item entities in `maxDist` blocks at entry, walks to each (sorted by distance) so natural ~1.5-block auto-collect fires, and reports how many disappeared from `bot.entities` during the sweep. Snapshot-at-entry prevents the sweep from looping forever on newly-spawned drops — Claude can call it again if more items appeared. Path failures on individual drops are tolerated; the sweep continues to the next.

Also invoked internally by `mineBlock` after each dig (`maxDist: 4`) to backstop the unreliable natural auto-collect that the slice-3 smoke test surfaced.

| Param | Default | Notes |
|---|---|---|
| `maxDist` | `8` | Search radius in blocks, 1–32. |

| | |
|---|---|
| Success | `no dropped items within <N> blocks` · `picked up <K> dropped item stack(s) within <N> blocks` |
| Failures | `maxDist must be between 1 and 32, got <n>` · `walked to <N> dropped item(s) within <M> blocks but collected none` |

---

### `dropItem` — toss items from inventory onto the ground

```ts
dropItem(bot, { item: string, count?: number }): Promise<SkillResult>
```

Drops from every matching inventory stack until `count` is satisfied. If `count` is omitted, every matching stack is dropped. Reports partial progress in `state.dropped` on failure (e.g. inventory had fewer than requested).

| | |
|---|---|
| Success | `dropped <K> <item>` |
| Failures | `item is required` · `count must be >= 1, got <n>` · `unknown item "<name>"` · `no <item> in inventory to drop` · `dropped <K> of <N> <item>; toss failed: <msg>` · `dropped <K> of <N> <item>; only <M> were available` |

---

### `craft` — composite craft (with auto table search + known-utility fallback)

```ts
craft(bot, { item: string, count?: number, tablePos?: Coords }): Promise<SkillResult>
```

Resolves a recipe via `bot.recipesFor` and crafts. Inventory-only recipes (2×2) skip any walking. 3×3 recipes need a crafting table; resolution order:

1. caller-supplied `tablePos`,
2. nearest `crafting_table` within 32 blocks (live `findBlock` search),
3. nearest remembered `crafting_table` from `world.json` POIs.

(3) is what makes the multi-step production loop (mine → smelt → craft) actually work — Claude sees the remembered table in `observeSurroundings.knownUtilities` and `craft` walks the bot back to it from deep in a cave automatically.

Shortfall reporting: when a recipe exists but ingredients are missing, the message names the first missing ingredient and its shortfall — `cannot craft 1 iron_pickaxe: need 3 iron_ingot; have 1` — so Claude can spawn a sub-task with no extra perception calls.

| | |
|---|---|
| Success | `crafted <N> <item>` · `crafted <N> <item> at crafting_table (x, y, z)` |
| Failures | `item is required` · `count must be >= 1, got <n>` · `unknown item "<name>"` · `no known recipe for "<item>"` · `cannot craft <N> <item>: need <K> <ingredient>; have <H>` · `no crafting_table within 32 blocks and none remembered in world memory` · `nearest remembered crafting_table is at (x, y, z) (~D blocks away) but the chunk isn't loaded — walk closer first` · `couldn't reach crafting_table at (x, y, z) (<source>): <msg>` · `craft failed for <item>: <msg>` |

---

### `attack` — tick-loop melee until cancelled / target dead

```ts
attack(bot, { entity: string }): Promise<SkillResult>
```

Equips the best available weapon (sword > axe, tiered netherite > diamond > iron > golden > stone > wooden), sets a dynamic pathfinder `GoalFollow` at `ATTACK_REACH - 1` blocks, and swings on cooldown. Exits when the target dies, leaves the bot's entity view, or cancellation is requested.

Cancellation: the side-channel preempt in `event-hooks.ts` flips the flag when the current conversation partner says "stop" / "halt" / "wait" while `attack` is in flight. Always clears the pathfinder goal in a `finally`.

| | |
|---|---|
| Success | `killed <entity> after <N> swing(s)` · `stopped attacking <entity> after <N> swing(s)` |
| Failures | `entity is required` · `entity "<name>" not visible to the bot` |

---

### `flee` — path away from a threat until `dist` blocks separation

```ts
flee(bot, { from: string, dist?: number }): Promise<SkillResult>
```

Computes an away-vector from the threat's current position, sets a `GoalNear` to a point that distance further along the vector, then re-paths every ~1.5s so a chasing threat doesn't end up running alongside the bot toward the same destination. Exits when separation ≥ `dist`, the threat disappears, or cancellation fires.

| Param | Default | Notes |
|---|---|---|
| `from` | — | Required. Player username or mob name. |
| `dist` | `16` | Target separation in blocks, 1–64. |

| | |
|---|---|
| Success | `fled from <name> to <D> blocks separation` · `<name> is no longer visible — fleeing complete` · `stopped fleeing from <name> (<D> blocks separation)` |
| Failures | `from is required` · `dist must be between 1 and 64, got <n>` · `entity "<name>" not visible to the bot` |

---

### `depositToChest` — walk to a chest and put items in

```ts
depositToChest(bot, { item: string, count?: number, pos?: Coords }): Promise<SkillResult>
```

When `pos` is omitted, picks the nearest known container from `world.json.containers[]` as a best-effort default. When `count` is omitted, deposits every matching stack. Container auto-capture (windowOpen/windowClose hook in `event-hooks.ts`) snapshots the chest's new contents on close, so `knownStorage` stays current automatically.

| | |
|---|---|
| Success | `deposited <N> <item> into <container> at (x, y, z) (<source>)` |
| Failures | `item is required` · `count must be >= 1, got <n>` · `unknown item "<name>"` · `no <item> in inventory to deposit` · `cannot deposit <N> <item>: only <M> in inventory` · `no known containers; pass an explicit pos for the chest to deposit into` · `chunk at (x, y, z) isn't loaded — walk closer first` · `block at (x, y, z) is <name>, not a container` · `nearest known container is at (x, y, z) (~D blocks) but the chunk isn't loaded — walk closer first` · `remembered <type> at (x, y, z) is now <name> — chest may have been broken; refresh memory by passing an explicit pos` · `couldn't reach <container> at (x, y, z): <msg>` · `failed to open <container> at (x, y, z): <msg>` · `deposit of <N> <item> into <container> at (x, y, z) failed: <msg>` |

---

### `withdrawFromChest` — walk to a chest and take items out

```ts
withdrawFromChest(bot, { item: string, count?: number, pos?: Coords }): Promise<SkillResult>
```

When `pos` is omitted, picks the nearest known container whose remembered contents include the requested item. Re-checks the chest's actual contents on open and adjusts the take count if memory was stale (e.g. another player emptied the chest between snapshots).

| | |
|---|---|
| Success | `withdrew <K> <item> from <container> at (x, y, z) (<source>)` · `withdrew <K> <item> from <container> at (x, y, z) (<source>); chest only had <N>` |
| Failures | `item is required` · `count must be >= 1, got <n>` · `unknown item "<name>"` · `no known containers; open a chest at least once so I can remember its contents, or pass an explicit pos` · `no remembered container holds <item>; pass an explicit pos or gather fresh` · `<container> at (x, y, z) has no <item> (stored memory was stale)` · (plus the same chest-reach / open / chunk-loaded failures as `depositToChest`) · `withdraw of <K> <item> from <container> at (x, y, z) failed: <msg>` |

---

### `giveItemTo` — composite hand-off (walk to player → face → drop)

```ts
giveItemTo(bot, { player: string, item: string, count?: number }): Promise<SkillResult>
```

Composite: `goTo(player)` via pathfinder `GoalNear(reach=2)`, then `lookAt` the player's head, then `dropItem`. The natural ~1.5-block item-attraction radius pulls the stack into the player. Refreshes the player's entity reference post-walk in case they moved.

| | |
|---|---|
| Success | `gave <K> <item> to <player>` |
| Failures | `player name required` · `item is required` · `player "<name>" is not visible to the bot` · `unknown item "<name>"` · `no <item> in inventory to give to <player>` · `couldn't reach <player> to hand off <item>: <msg>` · `reached <player> but: <dropItem failure message>` |

## Exercising skills

The bot is driven by Claude through natural in-game chat — no `!cmd` shortcuts. To exercise a skill, address the bot and ask:

- **Public chat** with the bot's name (e.g. `Steve_AI, look around`) wakes the bot. Reply lands in public chat via the `say` tool.
- **`/msg <bot> <message>`** wakes the bot privately. Reply lands as a whisper via the `whisper` tool.
- **`@all <message>`** wakes every configured bot.
- **Follow-up without name-mention** (within 30s of the bot ending a reply with `?`) is routed via the conversation-continuity heuristic.

What to watch in the orchestrator console:

- `ROUTE chat→<bot> reason=...` — the chat router picked this bot.
- `→ mcp__minecraft-skills__<skill>({...})` — the model called a skill.
- `thinking: ...` — the model's plain assistant text (logged but never sent in-game).
- `turn complete (cache_read=NNNN, out=NN)` — turn finished; usage stats.

If the bot whispers *"I'm rate-limited, try again in ~N min"* the Pro 5-hour window is exhausted; the agent drops further chats until reset. See [ARCHITECTURE.md "Resilience"](ARCHITECTURE.md).
