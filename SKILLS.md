# Skills

Reference for the v0.2 skill layer. Every skill is a plain async function:

```ts
(bot: Bot, params: P) => Promise<SkillResult>
```

and returns the same shape regardless of success:

```ts
{ ok: boolean, message: string, state?: object }
```

**Failure messages are written for Claude's consumption** (slice 3+) — they must be specific enough that the model can adapt (`"no oak_log within 64 blocks"`, not `"failed"`). Wrap every call site in `runSkill(name, params, fn)` so unexpected exceptions become `{ ok: false, message }` results instead of taking down the bot.

For higher-level design (catalogue, principles, push-work-down-the-stack), see [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

| Skill | Status |
|---|---|
| `say`, `whisper`, `observeSurroundings`, `goTo`, `mineBlock` | ✅ Implemented in slice 2 |
| `remember`, `setTaskQueue`, `advanceTaskQueue` | ✅ Implemented in slice 3 (phase 2) |
| `findBlock`, `findEntity`, `checkInventory`, `followPlayer`, `stop`, `lookAt`, `placeBlock`, `activateBlock`, `pickUpNearby`, `equipItem`, `dropItem`, `giveItemTo`, `craft`, `attack`, `flee`, `wait` | ⏳ Pending |

The manual chat-trigger harness (`!cmd args` in-game) is the slice-2 testing interface. It will be removed once the Claude orchestrator lands in slice 3 — anything inside `src/skills/chat-trigger.ts` is scaffolding, not production code.

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

**Smoke test:** `!say hello world` — bot echoes the message in chat.

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

**Smoke test:** no `!whisper` command in the harness yet — drive it from the chat-trigger source if you need to exercise it.

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

**State shape:** `position`, `dimension`, `facing` (cardinal), `time` (`{ timeOfDay, phase }`), `weather`, `status` (`health/food/saturation/experience/isInWater/isOnFire`), `heldItem`, `nearbyBlocks`, `nearbyEntities`, `nearbyDroppedItems`, plus the stubbed memory/state fields above. See `src/skills/perception.ts` for the full TS interface.

**Smoke test:** `!observe` — bot replies in chat with a compact summary (`blocks: 7× oak_log@4.5, ... | entities: Zack(player)@2.1, ...`). Full state object is logged to the orchestrator console.

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

**Smoke tests:**
- `!goto Zack` — bot pathfinds to player Zack (or any nearby mob with that name).
- `!goto 100 64 -200` — three numeric args resolve to coords.
- `!goto block oak_log` — finds the nearest oak_log within 64 blocks and pathfinds to it.

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
- **Drop pickup is unreliable.** Field-confirmed in the slice-3 smoke test for sand — the 500ms post-dig wait misses natural auto-collect often enough that the bot finishes "mining" with items still on the ground. Fix planned via an explicit pickup sweep after each dig (or land `pickUpNearby` and call it from the composite). Tracked in [ROADMAP.md → Slice-3 smoke-test follow-ups](ROADMAP.md).
- Tool selection picks the last `canHarvest` match in inventory rather than computing fastest dig time.

**Smoke tests:**
- `!mine oak_log 3` (bare-handed) — should mine 3 nearby logs.
- `!mine stone 1` (no pickaxe) — should fail with `no pickaxe in inventory to mine stone` *before any movement*.

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

**Smoke test:** `!remember base main_base` — adds a POI at the bot's current position. Inspect `data/orchestrator/memory/<bot>/world.json` to see the entry; re-run the same command to verify idempotency.

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

**Smoke test:** `!queue get wood; get iron; return` — bot reports the queue; subsequent `!observe` shows `currentTask: "get wood"`, `remainingTasks: ["get iron", "return"]`.

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

**Smoke test:** With a queue set, `!advance` shifts to the next item; repeat until drained.

---

### `stopMovement` — cancel pathfinding (helper, not a registered skill)

```ts
stopMovement(bot): SkillResult
```

Synchronous helper used by the manual harness's `!stop` to interrupt a running `goTo` / `mineBlock`. The architectural `stop` skill from the catalogue (Movement section) will subsume this in slice 3+ and gain the ability to cancel any in-flight skill, not just pathfinding.

| | |
|---|---|
| Success | `stopped` |
| Failures | None. |

**Smoke test:** `!stop` while a `goto`/`mine` is in flight — bot halts where it stands.

## Manual testing via the chat-trigger harness

Slice 2 mounts `attachChatTriggerHarness(bot, username)` from `src/index.ts` alongside the stub event hooks. It listens for `!cmd args` from any player on public chat and `/msg` whispers, dispatches the matching skill through `runSkill`, and replies on the same channel.

| Command | Dispatches |
|---|---|
| `!say <msg>` | `say({ message })` |
| `!observe [radius]` | `observeSurroundings({ radius })` |
| `!goto <name>` · `!goto <x> <y> <z>` · `!goto block <name>` | `goTo({ target })` |
| `!mine <block> [count]` | `mineBlock({ type, count })` |
| `!stop` | `stopMovement()` |
| `!queue <task1>; <task2>; ...` | `setTaskQueue({ tasks })` |
| `!advance` | `advanceTaskQueue()` |
| `!remember <type> [name]` | `remember({ type, name })` (uses bot's current pos) |

Only one skill runs at a time; subsequent commands are rejected with `busy — say !stop to cancel`. `!stop` always preempts. Result is summarised back in chat (`[ok] mine: mined 3 oak_log` etc.); for `!observe` the chat reply is a digest and the full state object goes to the orchestrator console.

### Smoke-test sequence

Prereq: Steve_AI must be on the server whitelist. Then `./scripts/dev.sh` to bring up MC + orchestrator, join the server as a player, and run the commands above in order. Recommended path:

1. `!say hello` — proves the bot is connected, listening, and the harness is wired.
2. `!observe` — proves perception aggregation works; check the console JSON.
3. `!goto <yourname>` — proves pathfinding + entity resolution.
4. `!goto block oak_log` — proves the block-target branch.
5. `!mine oak_log 3` — proves the canonical composite. Bare hands work for logs.
6. `!mine stone 1` (no pickaxe) — proves fail-fast tool check.
