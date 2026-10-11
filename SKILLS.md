# Skills

Reference for the v2 skill layer (41 registered tools; `src/skills/registry.ts` is the source of truth for schemas and the descriptions Haiku sees). Every skill is a plain async function:

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

For higher-level design see [ARCHITECTURE.md](ARCHITECTURE.md); the planner, job kinds, blueprints, recovery ladder and follow/night jobs are in [JOBS.md](JOBS.md). Haiku mostly calls the job tools (`achieve`, `build`, `followPlayer`, `surviveNight`); the primitives below remain for one-offs and are what the job step executors call.

## Status

All 41 registered tools are shipped. Pending (low value, see [ROADMAP.md](ROADMAP.md)): `findBlock`, `findEntity`, `lookAt`, `wait`.

| Group | Tools | Notes |
|---|---|---|
| **Jobs (v2)** | `achieve`, `build`, `surviveNight`, `cancelJob`, `followPlayer` | Start/stop background jobs and return at once. See [Job tools](#job-tools-v2). |
| Perception / chat | `observeSurroundings`, `checkInventory`, `say`, `whisper` | |
| Movement | `goTo`, `stop`, `pillarUp` | `goTo`: natural-terrain-only pathing, no placing. |
| World | `mineBlock`, `mineBlocks`, `placeBlock`, `placeBlocks` | v2: counts what lands in the inventory. |
| Inventory | `pickUpNearby`, `equipItem`, `equipLoadout`, `dropItem`, `giveItemTo`, `giveItemsTo`, `getItems` | `getItems` creative only; operator-item denylist. |
| Interaction / crafting / combat | `activateBlock`, `useOnEntity`, `useItem`, `craft`, `craftMany`, `smelt`, `attack`, `flee` | Crafting clicks are paced (120 ms). |
| Storage / survival / meta | `depositToChest`, `depositManyToChest`, `withdrawFromChest`, `withdrawManyFromChest`, `eat`, `fish`, `sleepIn`, `remember`, `setTaskQueue`, `advanceTaskQueue` | |

Skills are exercised through the Claude agent loop (see ["Exercising skills"](#exercising-skills)) and the eval harness (`npm run eval`).

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

Pre-checks reachability with `pathfinder.getPathTo()` and fails fast on `noPath`.

All movement (every skill, not just `goTo`) goes through `navigate()` in `src/skills/navigation.ts`. It verifies real arrival (`goal.isEnd`), detects being stuck (<1.5 blocks moved in 12s), applies a hard timeout (20s + 1s/block, capped at 5min), and honors the stop flag. Failures include `state.position` and a re-plan hint ("look for its door…").

**Pathfinder policy** (`pathfinder-config.ts`, shared by every skill; full rationale in ARCHITECTURE.md *Movement policy*): digging is on only for an **allowlist of natural terrain** (never logs, planks, cobblestone, glass, doors, containers, crops, beds; player-built structures are guarded) at `digCost` 4, so walking and doors win; it **never places** blocks (no bridging, stairs or towers: building/climbing is explicit via `placeBlocks`/`pillarUp`); `liquidCost` 8, `maxDropDown` 3 (creative 8). `navigate()` gives each path decision a 10 s think timeout and a swim/suffocation reflex can interrupt and resume it (<=3 times). **Doors:** `doors.ts` repairs door path nodes, opens wooden/copper doors and gates ahead (polling for the state flip) and closes them behind; iron doors/trapdoors are walls.

| Param | Default | Notes |
|---|---|---|
| `reach` | `1` | Stop when within this many blocks of the target. |

| | |
|---|---|
| Success | `arrived near <label> at (x, y, z)` |
| Failures | `entity "<name>" not visible to the bot` · `unknown block type "<name>"` · `no <block> within 64 blocks` · `no path to <label> at (x, y, z)` · `pathfinding to <label> failed: <msg>` |

---

### `mineBlock` / `mineBlocks` — gather natural blocks (find → path → equip → dig → pickup)

```ts
mineBlock(bot,  { type: string, count?: number /* 1..64, default 1 */, allowStructures?: boolean }): Promise<SkillResult>
mineBlocks(bot, { types: string[], maxCount?: number /* 1..128, default 32 */, maxDistance?: number /* default 64 */, allowStructures?: boolean }): Promise<SkillResult>
```

`mineBlock` is a one-type wrapper over `mineBlocks`. In v2, **`count`/`maxCount` count items that actually land in the inventory** (the blocks' expected drops from minecraft-data `drops`, measured as a delta against the pre-skill baseline), not digs: `stone` -> `cobblestone`, `iron_ore` -> `raw_iron`, logs -> themselves. v1 counted digs and reported "mined 10" with 3 logs in the inventory. Blocks with no tracked drop (creative, leaves) fall back to dig counting. Consequences: multi-yield blocks (lapis, redstone, copper) can overshoot the count; silk-touch or odd drop tables may read as fruitless.

Per iteration: pick the nearest candidate, path to it, equip the best harvest tool, `bot.dig`, wait for the drop entity (up to 600 ms), `pickUpNearby` r=4. A final sweep (r=8) collects dug-but-uncollected drops (and, after felling, leaf litter).

- **Reach rules:** stands on the ground and takes only blocks within arm's reach; **logs** are picked by felling rank (`tree-felling.ts`): a log is a candidate only if no log is directly below it and it is <=4 above the floor, so a tall/jungle tree yields its bottom logs, never the canopy. It never climbs or towers.
- **Unreachable** candidates are skipped (up to 12), not fatal; a tree whose drops can't be collected is abandoned after a wider sweep and the batch moves to the next tree (<=6). 3 consecutive digs that yield nothing with a **full inventory** stop the call. All-unreachable -> `could not reach any X`.
- **Tunnelling:** a buried natural target may be approached through natural blocks only; dig is skipped under a falling block (`fallsOnBot`). A dig aborted by the drowning reflex is retried once.
- **Structure guard** (`structure-guard.ts`): player-built blocks are left alone and reported (doors, gates, trapdoors, glass always; crafted blocks touching crafted blocks; any block touching >=2 crafted blocks; log clusters that aren't trees (`isTreeLog`: huts, beams, stripped logs)). `allowStructures:true` bypasses it, for explicit demolition only.
- **Tool preflight:** probes one block; no usable tool -> `no <tool> in inventory to mine <block>` (mineBlocks skips such types and lists them in `state.skipped`). Cancellable between blocks.
- **Exclusion (jobs):** `mineBlocks` also takes an internal `exclude(x,y,z)` predicate and returns `state.unreachablePositions`/`unreachableTypes` for the job runner's exhausted-area memory; not part of the Haiku schema.
- **Creative:** instant, no tool check/pickup; `cleared N <type> (creative mode: broken blocks drop nothing)`.
- Prefer `achieve` (`#log`, `cobblestone`, ...) for anything but a single block or ~3 items: it keeps going across trees/veins and leaves Haiku free to chat.

| | |
|---|---|
| Success | `collected 10 oak_log (mined 11)` (the parenthetical only when they differ) · multi-type: `collected 3 raw_iron, 5 coal` · `mined N <type>` (creative-style/untracked) |
| Partial/soft | `…; some drops could not be picked up` · `…; inventory is full` · `…; no more within <R> blocks` · `…; gave up after N unreachable <type> blocks (<why>)` · `the rest of the logs here are too high to reach from the ground…` · `left N block(s) alone because they look player-built (e.g. <reason> at (x,y,z))…` · `mining cancelled: <summary>` |
| Failures | `unknown block type "<name>"` · `no <type> within <R> blocks` · `no <tool> in inventory to mine <block>` · `cannot mine any requested type — <reasons>` · `could not reach any <type> (N tried; <last failure>)…` · `no path to <block> at (x, y, z) (out of reach without climbing or breaking player-built blocks)` · `dig failed at (x, y, z) after Nms: <msg>` · `not digging <block>…: a falling block is right above it` · `stopped after N blocks dropped nothing I could pick up` · `stuck retargeting same block at (x, y, z)` · `types must be a non-empty array` · `maxCount must be between 1 and 128, got <n>` |

`state`: `mined` (blocks dug), `collected`, `gained` (by item), `byType`, `skipped[]`, `protectedSkipped`, `unreachable` (+ `unreachableTypes`, `unreachablePositions`), `position` on failure. Batch failure shape: see [Batch variants](#batch-variants).

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

### `followPlayer` — follow a player (background job)

```ts
followPlayer(bot, { player: string, dist?: number /* 1..16, default 3 */ }): Promise<SkillResult>
```

**v2: starts a `follow` job and returns at once** (the Haiku session ends; chat during the follow gets its own fresh task). Behaviour, lost-sight search, failure timings and caveats: [JOBS.md](JOBS.md) *Follow job*. Ends on stop / `cancelJob` / a new job / any non-exempt tool call / the 30-min cap; `say`/`whisper` don't end it. Use only when asked to follow; for "come here" use `goTo` with the player as target. Without a job runner (legacy backends) the original blocking skill runs (returns `stopped following <player>` when cancelled).

| | |
|---|---|
| Success | `now following <player> (~<dist> blocks) as a background job. It keeps running while you chat: reply briefly with say and end your turn. …` |
| Failures | `player name required` · `dist must be between 1 and 16, got <n>` · `player "<name>" is not visible to the bot` · `I can't follow myself` · `the job runner isn't available right now` · later, as `[job failed]` events: `following <player> ended after <dur> — <detail>` (kind `unreachable`: lost them for 45 s, they left the server, or no path for 40 s) |

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

### `checkInventory` — grouped inventory report

```ts
checkInventory(bot, {}): Promise<SkillResult>
```

Read-only. Aggregates main inventory + hotbar + armor + off-hand into a grouped list: per-item name, total count, stack count, durability percent for damageable items, and the equipped-slot annotation when worn/held. `observeSurroundings` only returns `heldItem` — call this before any tool-use chain to know what's actually available.

| | |
|---|---|
| Success | `inventory empty` · `<summary>; <occupied>/<capacity> slots used` (e.g. `64 cobblestone, iron_pickaxe (65%), 24 oak_log; 14/36 slots used`) |
| Failures | None expected — read-only. Exceptions become `checkInventory crashed: <msg>` via the harness. |

**State shape:** `{ groups: InventoryGroup[], heldItem, occupiedSlots, mainCapacity }`. Each group: `{ name, count, stacks, durabilityPct?, equippedAt? }`.

---

### `equipItem` — explicit equip to hand / armor / off-hand

```ts
equipItem(bot, { item: string, slot?: "hand" | "off-hand" | "head" | "torso" | "legs" | "feet" }): Promise<SkillResult>
```

Defaults `slot` to `hand`. Lookup is by item name across main + hotbar + already-equipped slots. No-ops when the requested item is already in the requested slot.

The natural one-shot pattern for tool use is `activateBlock({ ..., with })` or `useOnEntity({ ..., with })`, which call this internally. Reach for `equipItem` directly when:
- equipping armor (`{ item: "iron_helmet", slot: "head" }`),
- equipping off-hand (`{ item: "shield", slot: "off-hand" }`),
- holding a tool for many subsequent calls without re-equipping each time.

| | |
|---|---|
| Success | `equipped <item> (<slot>)` · `already holding <item>` |
| Failures | `item is required` · `slot must be one of hand / off-hand / head / torso / legs / feet; got "<x>"` · `unknown item "<name>"` · `no <item> in inventory to equip` · `equip <item> → <slot> failed: <msg>` |

---

### `activateBlock` — right-click on a block

```ts
activateBlock(bot, { position: Coords, with?: string }): Promise<SkillResult>
```

Wraps `bot.activateBlock`. Walks within 3 blocks of the target, optionally equips `with` first, then right-clicks. Validates that the chunk is loaded and the target isn't air.

Coverage (the common item / block combinations the model is expected to reach for):
- Doors / trapdoors / levers / buttons → toggle (no `with` needed).
- Hoe → till dirt to farmland.
- Flint and steel → ignite the target face.
- Empty bucket on a water/lava source → fills the bucket.
- Water/lava bucket → place the liquid at the target.
- Bone meal on a crop → instant growth tick.
- Seeds on farmland → plant.
- Jukebox, composter, brewing stand-style passive opens.

| | |
|---|---|
| Success | `activated <block> at (x, y, z)` · `activated <block> at (x, y, z) with <held>` |
| Failures | `position is required` · `chunk at (x, y, z) isn't loaded — walk closer first` · `block at (x, y, z) is air — nothing to activate` · `couldn't reach <block> at (x, y, z): <msg>` · `cannot activate with "<item>": <equip failure>` · `activate <block> at (x, y, z) [with <item>] failed: <msg>` |

---

### `useOnEntity` — right-click on an entity

```ts
useOnEntity(bot, { entity: string, with?: string }): Promise<SkillResult>
```

Wraps `bot.useOn`. Walks within 3 blocks of the entity's last-known position, optionally equips `with`, faces the entity, then right-clicks. Re-resolves the entity post-walk in case it moved or despawned.

Coverage: shears → sheep (wool), bucket → cow (milk), name tag → entity (rename), dye → sheep (color), lead → animal, saddle → horse, armor → horse, glass bottle → cow / other.

| | |
|---|---|
| Success | `used <held> on <entity>` · `used empty hand on <entity>` |
| Failures | `entity is required` · `entity "<name>" not visible to the bot` · `couldn't reach <entity>: <msg>` · `cannot use on <entity> with "<item>": <equip failure>` · `lost sight of <entity> after walking` · `useOn <entity> [with <item>] failed: <msg>` |

---

### `smelt` — composite smelting (closes the iron-armor loop)

```ts
smelt(bot, { input: string, fuel?: string, count?: number, furnacePos?: Coords }): Promise<SkillResult>
```

Furnace resolution mirrors `craft`'s table resolution: caller-supplied → nearest within 32 blocks → nearest remembered furnace POI from world memory. This is what lets the bot return from a cave to a remembered furnace at base, smelt, then walk to a remembered crafting table.

Fuel resolution: caller-supplied wins; otherwise auto-picks the highest-preference fuel actually in inventory, walking `coal → charcoal → coal_block → blaze_rod → dried_kelp_block`. Fuel-per-unit assumed: coal/charcoal = 8 items, coal_block = 80, blaze_rod = 12, dried_kelp_block = 20, lava_bucket = 100; anything else falls back to 1 item per unit (conservative).

Polls `furnace.outputItem()` every 500ms with a 12s budget per smelted item.

| | |
|---|---|
| Success | `smelted <N> <input> at furnace (x, y, z) (<source>)` |
| Failures | `input is required` · `count must be >= 1, got <n>` · `unknown input item "<name>"` · `cannot smelt <N> <input>: only <K> in inventory` · `unknown fuel "<name>"` · `not enough fuel: need <K> <fuel> (smelts <per>/unit), have <H>` · `no fuel in inventory; tried coal, charcoal, coal_block, blaze_rod, dried_kelp_block` · `block at (x, y, z) is <name>, not a furnace` · `no furnace within 32 blocks and none remembered in world memory` · `nearest remembered <type> is at (x, y, z) (~D blocks away) but the chunk isn't loaded — walk closer first` · `couldn't reach <furnace> at (x, y, z) (<source>): <msg>` · `failed to open furnace at (x, y, z): <msg>` · `putInput <N> <input> failed: <msg>` · `putFuel <K> <fuel> failed: <msg>` · `smelt timeout: collected <K> of <N> <input> from furnace at (x, y, z)` · `takeOutput from furnace at (x, y, z) failed: <msg>` |

---

### `useItem` — right-click in mid-air with held item

```ts
useItem(bot, { with?: string, offhand?: boolean }): Promise<SkillResult>
```

Wraps `bot.activateItem`. Fire-and-forget — does not wait for any animation. Use for: ender pearl throw, splash / lingering potion throw, charge bow / crossbow, manual fishing rod cast (prefer `fish` skill). DO NOT use for food / drink potions — `eat` handles the full cycle.

| | |
|---|---|
| Success | `used <item>` · `used <item> (off-hand)` |
| Failures | `cannot use "<item>": <equip failure>` · `hand is empty — equip something first or pass \`with\`` · `off-hand is empty` · `activateItem <item> failed: <msg>` |

---

### `eat` — composite eat (auto-pick best food + activate + consume)

```ts
eat(bot, { item?: string }): Promise<SkillResult>
```

Composite: equip the food → `bot.consume()` (which handles the full activate-then-finish cycle). When `item` is omitted, picks the best available food from a preference list (cooked > raw, higher saturation first): `cooked_beef, cooked_porkchop, cooked_mutton, cooked_salmon, cooked_chicken, cooked_rabbit, cooked_cod, baked_potato, bread, …` falling through to raw meats and rotten_flesh as last resort.

Won't eat when `bot.food >= 20` unless an explicit `item` is passed (so the model doesn't waste cooked food on a full bot, but explicit player intent like "drink a golden apple" is honored).

| | |
|---|---|
| Success | `ate <item> (food: <before> → <after>, +<delta>)` |
| Failures | `item is required` (when explicit `item` is empty) · `no <item> in inventory to eat` · `food is full (20/20) — pass an explicit item if you want to eat anyway` · `no food in inventory; tried cooked_beef, cooked_porkchop, …` · `cannot eat <item>: <equip failure>` · `eating <item> failed: <msg>` |

---

### `fish` — cast a fishing rod and wait for a bite

```ts
fish(bot, {}): Promise<SkillResult>
```

Wraps `bot.fish()`. Requires `fishing_rod` in main-hand (call `equipItem` first if needed) and water within casting range of the bot's current view direction. Cancellable: races the fish promise against the per-bot cancellation flag, so `stop` / chat side-channel reels in early. Times out after 5 minutes with no bite.

| | |
|---|---|
| Success | `caught a fish` · `stopped fishing` |
| Failures | `must be holding a fishing_rod to fish; equip one first` · `fishing timed out after 5 minutes with no bite` · `fishing failed: <msg>` |

---

### `sleepIn` — sleep in a bed (with bed-POI fallback)

```ts
sleepIn(bot, { pos?: Coords }): Promise<SkillResult>
```

Bed resolution: caller-supplied → nearest `*_bed` within 32 blocks → nearest remembered bed POI from world memory. Walks within 2 blocks, then `bot.sleep(bedBlock)`. Vanilla preconditions apply: must be night (or thunderstorm), bed not obstructed; mineflayer surfaces those errors as-is. Beds are added to `UTILITY_BLOCK_TYPES` so the proximity scan in `event-hooks.ts` auto-captures their positions to `pois[]`.

| | |
|---|---|
| Success | `sleeping in <bed_color>_bed at (x, y, z) (<source>)` |
| Failures | `chunk at (x, y, z) isn't loaded — walk closer first` · `block at (x, y, z) is <name>, not a bed` · `no bed within 32 blocks and none remembered in world memory` · `nearest remembered <name> is at (x, y, z) (~D blocks) but the chunk isn't loaded — walk closer first` · `couldn't reach <bed> at (x, y, z) (<source>): <msg>` · `sleep in <bed> at (x, y, z) failed: <msg>` (mineflayer message — common cases: not night, bed obstructed, monsters nearby) |

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

**`count` = items wanted, not crafts.** `bot.craft(recipe, n)` runs the recipe n times, so the skill runs `ceil(count / recipe.result.count)` crafts and reports items actually produced (fixed in v0.5 — previously "4 sticks" made 16).

**No table nearby:** before falling back to a remembered table, it places a `crafting_table` from inventory, or crafts one from 4 planks and places it (`src/skills/place-helper.ts`).

Shortfall reporting picks the recipe variant closest to completion and lists every missing ingredient, adding "(craft X first)" when it's craftable from inventory — so Claude can spawn a sub-task with no extra perception calls.

| | |
|---|---|
| Success | `crafted <N> <item>` · `crafted <N> <item> at crafting_table (x, y, z)` |
| Failures | `item is required` · `count must be >= 1, got <n>` · `unknown item "<name>"` · `no known recipe for "<item>"` · `cannot craft <N> <item>: need <K> <ingredient>; have <H>` · `no crafting_table within 32 blocks and none remembered in world memory` · `nearest remembered crafting_table is at (x, y, z) (~D blocks away) but the chunk isn't loaded — walk closer first` · `couldn't reach crafting_table at (x, y, z) (<source>): <msg>` · `craft failed for <item>: <msg>` |

---

### `pillarUp` — climb straight up by jump-placing filler

```ts
pillarUp(bot, { height: number /* 1..32 */ }): Promise<SkillResult>
```

For genuinely stuck situations (a hole, a ledge, a tree top) — never as travel. Filler (`pickFiller`): never items **reserved** by a running job; prefers dirt, netherrack, cobbled_deepslate, andesite, diorite, granite, tuff, then cobblestone, stone, blackstone (no sand/gravel). The bot also uses this internally as an escape from pits/water (`purpose: escape`). Pre-checks an empty feet cell, solid full block below, and headroom. Per level: look straight down, hold jump, poll each physics tick until feet ≥ cell + 1.1, release jump, place on the block below, verify it appeared and the bot landed on it; ≤3 attempts per level. Cancellable; returns `state.placed` and final position. Implementation in `src/skills/pillar.ts`.

---

### `getItems` — creative-only: give yourself items

```ts
getItems(bot, { items: Array<{ name: string; count?: number }> }): Promise<SkillResult>
```

Creative mode only. In survival it refuses with a clear message. Fills the inventory through mineflayer's creative API (`bot.creative.setInventorySlot`), in `src/skills/creative.ts`.
- **`count`:** "hold at least this many", so repeated calls are idempotent. The default is one stack.
- **Slot order:** grows existing plain stacks first, then empty hotbar slots (36–44), then main inventory (9–35). Respects stack size, and never overwrites an occupied slot.
- **Server confirmation:** on 1.21.3+ the server never confirms creative slot writes, and mineflayer's own rejection check is broken there. So writes use `waitTimeout = 0`, go strictly one slot at a time, and are spaced 60 ms apart.
- **Full inventory:** returns `ok:false` with `state.missing`.
- **Operator-item denylist** (`isOperatorItem`, `creative.ts`): refused by `getItems`, every auto-supply path (`creativeGive`) and `achieve({deliverTo})`: `command_block` (+chain/repeating/minecart), `structure_block`/`structure_void`/`jigsaw`/`test_block`, `barrier`, `light`, `bedrock`, `debug_stick`, `knowledge_book`, `end_portal_frame`, `spawner`/`trial_spawner`, `reinforced_deepslate`, `allow`/`deny`/`border_block`, griefing items `tnt`, `tnt_minecart`, `lava_bucket`, `end_crystal`, `respawn_anchor`, `wither_skeleton_skull`, and any `*_spawn_egg`. Message: `<item> is an operator/technical item; I don't hand those out`.
- Count cap: 1..2304 per item, 36 item types per call.

**Creative behavior of other skills** (every branch checks the live `bot.game.gameMode` via `src/skills/game-mode.ts`, never a cached value):
- `mineBlock(s)`: instant, no tool check, pillar or pickup sweep. Reports "cleared … drop nothing". Switches off a held sword/trident/mace, because a creative player can't break blocks with one. The structure guard still applies.
- `placeBlock(s)`: supplies a missing block type from the creative inventory. Flies to a hover spot for high or out-of-reach targets (`src/skills/flight.ts`).
- `craft` / `craftMany`: give the requested items directly. `smelt` refuses and points to `getItems`.
- `goTo`: flies to a landing spot beside the target when it is 4+ blocks up, or when walking fails.
- `giveItemsTo` tops up from the creative inventory first. `pillarUp` supplies cobblestone if no filler is held.
- Reflexes: auto-eat, armor and defend are off; idle look stays on. Pathfinder max drop is 8 in creative, 3 in survival.

**Flight:** `flight.ts` is a custom loop, not `bot.creative.flyTo`, which has no collision check, timeout or cancel.
- It flies only along body-clear straight paths, trying up / across / down if the direct line is blocked.
- It honors stop and has a timeout.
- It manages gravity and the `abilities` packet itself.
- `runSkill` lands a hovering bot before any skill except place, chat, observe, meta, `getItems` and `stop`.

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

## Job tools (v2)

These start/stop background jobs ([JOBS.md](JOBS.md)) and **return at once**; the tool result ends with "reply briefly and end your turn — you'll get a [job finished]/[job failed] message". Calling any movement/mining/crafting tool while a job runs cancels it (exempt: `say whisper observeSurroundings checkInventory remember setTaskQueue advanceTaskQueue achieve build surviveNight cancelJob`). `state` is the `AchieveResult` `{ ok, jobId, message, rawNeeds?, unresolved? }`.

### `achieve` — get items via a planned background job

```ts
achieve(bot, { goals: Array<{ item: string; count: number }>, deliverTo?: string }): Promise<SkillResult>
```

Pass **all** requested items in one call. `item` is an exact snake_case ID (validated with did-you-mean) or a tag: `#log #planks #wool #stone_tool_material #coal #sand` (any mix of matching items counts; species chosen per plan). Also THE way to collect N of something (chop 10 logs = `{ item: "#log", count: 10 }`). Duplicates are merged; counts floor at 1. `deliverTo` ("give/get/bring me"): when the goals are met the bot walks to that player and hands the items over (creative: takes them with `getItems` first; works even if the items are already held); capped at 2 stacks per stackable item, 4 for unstackables (the result says when it clamped, tell the player); operator items refused; the player must be in sight. "make/craft/get yourself X" = no `deliverTo`.

| | |
|---|---|
| Success | `job started: iron_pickaxe x1[ → give to <player>]. Plan: <summary>. It runs in the background; reply briefly and end your turn — …` |
| Failures | `the job runner isn't available right now` · `creative mode: don't gather or craft — take what you need with getItems (or pass deliverTo to hand items to a player)` · `can't hand things to "<name>": no player by that name is in sight…` · `goals item <unknown item + did-you-mean>` · `goals item "#x" is not a known item tag (known: …)` · `<item> is an operator/technical item; I don't hand those out` · `not started: this same goal already failed N times in the last 30 min (<kinds>). Running it again won't change the outcome — …` (failure ledger; cleared when a player speaks) · `nothing to do: you already have everything asked for` · planner refusal naming the unresolved leaf and reason (`not_obtainable: …`, `no_source: …`) · `not started: a stop request arrived while the job was being planned` |

Ends later with `[job finished] achieve … — done in 4m12s (requested by Alex — tell them)` or `[job failed] … failure: <kind> — <detail>; remaining plan: …`.

### `build` — house, nether portal or wheat farm

```ts
build(bot, { blueprint: "house" | "portal" | "farm", params?: { width?, depth?, height?, wall?, roof?, floor?, door?, windows?, size? }, at?: "here" | { x, y, z } }): Promise<SkillResult>
```

Picks a level site beside the requesting player (`at:"here"` default; never on top of them or any build), gets missing materials (survival: planner gathers/crafts inside the same job; creative: `getItems`), places bottom-up with temporary scaffolds and the door last, then verifies the block count. Params and geometry per blueprint: JOBS.md *Builder*. Big/permanent builds: Haiku proposes defaults first and waits for a yes (D13). The default wall is the planks the bot holds.

| | |
|---|---|
| Success | `build started: <summary>. It runs in the background; …`; ends with `[job finished] build house (…) — done in 26s, 57/57 blocks placed` |
| Failures | `the job runner isn't available right now` · `no spot for the <blueprint>: <reason>. Ask the player where, or try another area.` (`no_site`) · `not started: the <blueprint> already failed N times near here in the last 30 min (<kinds>; placed/total at x,y,z)…` · material gap unresolved (e.g. portal without obsidian/flint, farm without hoe/seeds) · later `[job failed] … failure: build_incomplete/timeout/… ` |

An earlier unfinished structure of the same blueprint near the anchor is **resumed**, not duplicated.

### `surviveNight` — get through the night safely

```ts
surviveNight(bot, { useBed?: boolean, shelter?: "dig" | "hut" }): Promise<SkillResult>
```

Sleeps in a bed within reach, else digs a sealed 1x2 pocket into the ground or a hillside in seconds, else builds a 3x3 hut beside the requester; waits inside until dawn (time 23500), then opens up. `useBed:false` skips the bed; `shelter:"hut"` skips digging in. Details/caveats: JOBS.md *Night job*.

| | |
|---|---|
| Success | `night job started: <summary>. It runs in the background (digging in or building, then waiting inside until dawn); …`; ends `[job finished] survived the night — <detail>` |
| Failures | `creative mode: mobs can't hurt you, so there is nothing to survive. Just carry on.` · `it's daytime (time <t>); there is nothing to shelter from. Night starts around 12500 (dusk ~11000).` · `the job runner isn't available right now` · hut refusals (`no_site`, ledger) · `[job failed]` kinds `died` / `timeout` / `no_site` / `build_incomplete` |

### `cancelJob` — abandon the running job

```ts
cancelJob(bot): Promise<SkillResult>
```

| | |
|---|---|
| Success | `cancelled the job (<goals or label>)` · `no job is running` (ok:true) |
| Failures | None. No `[job …]` event follows a cancel. |

## Batch variants

v0.4 added batch siblings for every unary skill that had a realistic multi-target pattern. Each batch tool walks once, opens / equips once, runs the per-item operation in sequence, and returns a partial-result payload on first failure (mirroring `placeBlocks`). The unary siblings are **thin wrappers** around the batch siblings — calling the unary form with a list of one is exactly the batch path, no performance gap.

| Unary | Batch | Use the batch form for |
|---|---|---|
| `mineBlock({ type, count? })` | `mineBlocks({ types[], maxCount?, maxDistance?, allowStructures? })` | Prospecting — *"mine any ores you can find down there"*. Per-type tool-tier preflight; types the bot can't harvest are skipped and reported, not fatal. |
| `giveItemTo({ player, item, count? })` | `giveItemsTo({ player, items[] })` | Multi-item handoffs — full toolset, full armor set, food drop. One walk, many tosses. |
| `equipItem({ item, slot? })` | `equipLoadout({ head?, torso?, legs?, feet?, hand?, offHand? })` | Multi-slot equips — armor set, weapon+shield. Object (not array) because the slots are a closed set. |
| `craft({ item, count?, tablePos? })` | `craftMany({ items[], tablePos? })` | Multi-recipe crafts. Table is resolved lazily; if every item is 2×2, no table walk happens. Order matters — earlier recipes consume ingredients later ones may need. |
| `depositToChest({ item, count?, pos? })` | `depositManyToChest({ items[], pos? })` | Multi-item stash. Auto-capture snapshots once per batch (on close), not once per item. |
| `withdrawFromChest({ item, count?, pos? })` | `withdrawManyFromChest({ items[], pos? })` | Multi-item pull. `pos`-less default resolves by the first item; split into per-chest calls when items span chests. |

**Failure shape (common across all six).** On the first per-item failure, returns `{ ok: false, message, state }` where `state` includes:
- the partial-result array (`placed[]` / `mined` total + `byType` / `given[]` / `equipped[]` / `crafted[]` / `deposited[]` / `withdrawn[]`),
- `failedIndex` (or `failedSlot` for equipLoadout),
- `failedItem` (the item name that broke the batch).

The agent's correct move on partial-failure is to slice from `failedIndex + 1` and retry — not re-run the whole batch.

---

## Exercising skills

The bot is driven by Claude through natural in-game chat — no `!cmd` shortcuts. To exercise a skill, address the bot and ask:

- **Public chat** with the bot's name (e.g. `Steve_AI, look around`) wakes the bot. Reply lands in public chat via the `say` tool.
- **`/msg <bot> <message>`** wakes the bot privately. Reply lands as a whisper via the `whisper` tool.
- **`@all <message>`** wakes every configured bot.
- **Aliases** (`aliases:` in `config/bots.yml`, plus the suffix-stripped name: `Steve_AI` answers to "steve"), a **45 s question window**, a **60 s follow-up window** after any bot reply, and the running job's requester all route un-named chat (see ARCHITECTURE.md *Routing*).

What to watch in the orchestrator console:

- `ROUTE chat→<bot> reason=...` — the chat router picked this bot (`name-mention`, `follow-up`, `continuation`, `job-requester`, ...).
- `[<bot>] job …` lines — job milestones (`grep job .bot-runtime/bot.log`): start, each step, recovery rungs, end.
- `→ mcp__minecraft-skills__<skill>({...})` — the model called a skill.
- `thinking: ...` — the model's plain assistant text (logged but never sent in-game).
- `turn complete (cache_read=NNNN, out=NN)` — turn finished; usage stats.

If the bot whispers *"I'm rate-limited, try again in ~N min"* the Pro 5-hour window is exhausted; the agent drops further chats until reset. See [ARCHITECTURE.md "Resilience"](ARCHITECTURE.md).
