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
| `findBlock`, `findEntity`, `checkInventory`, `followPlayer`, `stop`, `lookAt`, `placeBlock`, `activateBlock`, `pickUpNearby`, `equipItem`, `dropItem`, `giveItemTo`, `craft`, `attack`, `flee`, `wait` | ⏳ Pending |

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
- **Drop pickup is unreliable.** Field-confirmed in the slice-3 smoke test for sand — the 500ms post-dig wait misses natural auto-collect often enough that the bot finishes "mining" with items still on the ground. Fix planned via an explicit pickup sweep after each dig (or land `pickUpNearby` and call it from the composite). Tracked in [ROADMAP.md → Slice-3 smoke-test follow-ups](ROADMAP.md).
- Tool selection picks the last `canHarvest` match in inventory rather than computing fastest dig time.

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

### `stopMovement` — cancel pathfinding (helper, not a registered skill)

```ts
stopMovement(bot): SkillResult
```

Synchronous helper that calls `pathfinder.stop()`. Currently orphaned — the slice-2 `!stop` harness command that called it is gone, and the agent doesn't have access to it yet. The architectural `stop` skill from the catalogue (Movement section) will revive it as a registered tool in a later slice with the ability to cancel any in-flight skill, not just pathfinding.

| | |
|---|---|
| Success | `stopped` |
| Failures | None. |

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
