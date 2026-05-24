# Architecture

Design + as-shipped reference for the **AI NPC system**: Minecraft players backed by Claude that you can chat with and assign tasks.

Current scope: **v0.3+** (single bot per username, chat interaction, 28-skill catalogue including the full iron-armor production loop, in-terminal dashboard). Deferred features and their technical sketches live in [ROADMAP.md](ROADMAP.md).

## Goals

- Multiple NPCs join the existing Paper server as regular players (via [mineflayer](https://github.com/PrismarineJS/mineflayer)).
- Each NPC is driven by a Claude conversation that decides what to do via tool use.
- Players interact with NPCs through in-game chat; NPCs can carry out multi-step tasks (gather, build, follow, mine, craft).

## Layer stack

```
Orchestrator              spawns / supervises NPCs, routes chat
  └─ NPC Agent            Claude Agent SDK loop, event-driven, per-bot memory
       └─ Skills          high-level capabilities exposed as Claude tools
            └─ mineflayer + pathfinder (raw bot API)
                 └─ Paper server (existing docker-compose service)
```

## Why a skill layer (and not MCP, not raw mineflayer)

- **Raw mineflayer is too low-level for Claude.** Most useful actions chain 3–6 primitives (find → path → face → dig → pick up). Driving those directly burns tokens, adds latency per tool round-trip, and produces brittle plans.
- **Skills wrap multi-step mineflayer sequences into single task-level tools** like `gatherWood(amount)`, `mineNearest(blockType)`, `followPlayer(name)`, `craft(item, count)`, `placeBlock(type, pos)`, `observeSurroundings()`. Claude reasons at the task level, one tool call ≈ one meaningful action.
- **MCP would add a process boundary without payoff.** Its value is sharing a tool surface across distinct AI clients; here one orchestrator owns each bot, both ends under our control. The skill layer can be re-exposed as MCP later if we ever want to drive a bot interactively from Claude Code.
- **Per-NPC state (memory, current goal, inventory beliefs) lives in-process** alongside the skills, simpler than serializing across an IPC boundary.

## Push work down the stack

**Core architectural principle.** Anything that can be done deterministically in the orchestrator or skill layer is done there — never sent through Claude. Claude is the most expensive and slowest part of the system; using it for things that don't require judgment burns tokens, adds latency, and reduces reliability.

**Claude handles:** interpreting vague intent, planning multi-step tasks, conversational replies, ambiguous prioritization, recovery decisions when the structured options aren't enough.

**Middleware handles everything else:** facts, counts, filters, aggregations, lookups, routing decisions by name or regex, deterministic failure handling, pathing checks, capture of observable events, queue management.

Concrete applications shipped:

| Pre-processing | Saves Claude from |
|---|---|
| Skill composites (`mineBlock` hides find→path→dig→pickup) | Orchestrating 5–6 primitives per task |
| World knowledge captured by event hooks (`world.json`) | Summarizing chest contents and POI locations |
| `observeSurroundings` filters + groups blocks/entities | Reading hundreds of coords and counting them |
| Chat routing by regex (name-mention filter) | Reading every chat just to decide "is this for me?" |
| `checkInventory` aggregation | Counting items and grouping by type |
| Skill failure messages include adjacent options | Calling extra perception skills to recover |
| `goTo` path feasibility pre-check | Committing to a doomed action and then guessing why it failed |
| Recent actions log, player presence, task queue | Reconstructing recent history from conversation memory |

**Test for new skills and features:** if it can be done in TypeScript with deterministic logic, do it there. Only invoke Claude when the answer genuinely depends on judgment.

## Components

### Orchestrator
Single Node.js process that spawns one NPC agent per configured bot account, supervises reconnects, and routes in-game chat events to the right NPC.

### NPC Agent
Per-bot Claude Agent SDK loop. Event-driven (not a tight tick loop) — wakes on chat-to-bot. One long-lived `query()` per bot in streaming-input mode; an async queue of `SDKUserMessage` is its `prompt`. Conversation lives in SDK process memory and does not persist across restarts (see [ROADMAP.md](ROADMAP.md)). System prompt + tool definitions are prompt-cached by the SDK (~2280 cached tokens per warm turn — see [spikes/SDK_NOTES.md](spikes/SDK_NOTES.md)).

### Skills
A library of high-level capabilities exposed to Claude as tools. Each skill is a JS function that orchestrates mineflayer primitives and returns a structured result. Skills are unit-testable independently of Claude.

### mineflayer layer
The raw bot client plus `mineflayer-pathfinder` for movement. Not exposed to Claude directly.

## Runtime & deployment

### Claude runtime & auth
The orchestrator drives Claude through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) rather than the raw Anthropic SDK. It authenticates via the **Pro subscription** Claude Code already holds on this Mac — no separate API billing. Tradeoffs:

- **Pro rate limits apply.** 5-hour rolling windows are shared across all NPCs on this account. Heavy multi-hour play could hit them and silence the bots until reset. Acceptable for current scope (1–2 bots, name-mention only — see *Interaction modes*).
- **Less granular control** than the raw SDK over per-call model selection and prompt caching — these are managed by the Agent SDK runtime. We can still hint (Sonnet for main loop, Haiku for summarization) but not as freely.
- **Auth is host-bound.** Works seamlessly here because Claude Code is installed and authed. Moving the orchestrator to a remote VPS later would require Claude Code installed and authed there too.
- **The skill layer doesn't change.** If we ever swap to direct Anthropic API + pay-per-token, only the agent runtime layer changes; skills, orchestrator, and bot wiring are identical.

### Default model selection
| Use | Model | Why |
|---|---|---|
| Main NPC reasoning loop | **Sonnet 4.6** | Sweet spot for tool use, planning, conversational behavior |
| Memory summarization (background) | **Haiku 4.5** | Cheap, fine for compressing old turns |
| Complex multi-step plans (opt-in escalation) | **Opus 4.7** | Reserved for when the task genuinely needs it |

### Orchestrator process model
**Hybrid (Option C).** Host process for development, Docker Compose service for steady-state — same code, different launcher.

- **Dev:** `./scripts/dev.sh` brings up the MC server (`docker compose up -d`, idempotent), then runs the orchestrator with `npm run dev` in the foreground for live logs and quick restart. MC server stays up across orchestrator restarts.
- **Steady-state:** Once the loop and skills stabilize, add a Dockerfile and an `orchestrator` service to `docker-compose.yml`. `./scripts/start.sh` then brings up everything together with no script change.

A `package.json` at the repo root will define `dev` (nodemon-based hot reload) and `start` (plain `node`) scripts.

## Configuration

### Bot config — `config/bots.yml`
Versioned in git. One entry per bot. Minimal shape:

```yaml
bots:
  - username: Steve_AI
    model_hint: sonnet
```

Fields:
- `username` — Minecraft username the bot connects as (must be on the whitelist).
- `model_hint` — `sonnet` / `haiku` / `opus`. Mapped to a full model ID at the agent boundary (`src/agent/behavior.ts`).

`persona`, `owner`, and richer permission fields are deferred (see [ROADMAP.md](ROADMAP.md)).

### Environment variables — `.env`
No new secrets — Agent SDK auth via Pro subscription is handled by Claude Code's existing on-disk credentials. Additions over the bare minecraft / duckdns setup:

- `MC_HOST` (optional, default `localhost`) — where the orchestrator connects to the MC server. `localhost` for host-process dev; switches to `minecraft` (the compose service name) when the orchestrator becomes a compose service.

`DUCKDNS_TOKEN` remains the only real secret.

## Skill catalogue

Each skill is a JS function exposed to Claude as a tool. Skills take **specific, machine-friendly parameters** (block IDs, item IDs, entity types); Claude translates vague player intent into specific calls. All skills block until done or fail and return a structured result:

```ts
{ ok: boolean, message: string, state?: object }
```

Pending skills are marked ⏳; everything else is shipped. Per-skill reference (signatures, success / failure messages, caveats) lives in [SKILLS.md](SKILLS.md).

| Category | Skill | Params | Notes |
|---|---|---|---|
| Perception | `observeSurroundings` | `radius?` | Nearby blocks (with counts / distances), entities, players, time, weather, status, plus middleware state (recent actions, recently-seen players, current task queue, `knownStorage`, `knownUtilities`). Claude's primary "look around". |
| Perception | `checkInventory` | — | Pre-aggregated grouped inventory (main + hotbar + armor + off-hand) with durabilities and equipped-slot annotations. |
| Perception | `findBlock` ⏳ | `type, maxDist?` | Nearest block of a type. Mostly redundant with `observeSurroundings.nearbyBlocks`. |
| Perception | `findEntity` ⏳ | `filter, maxDist?` | Nearest entity (mob type or player name). |
| Chat | `say` | `message` | Public chat. |
| Chat | `whisper` | `player, message` | Private reply. |
| Movement | `goTo` | `target, reach?` | Coords / entity / block (discriminated union). Pre-checks reachability; fails fast if no path. |
| Movement | `followPlayer` | `player, dist?` | Sustained follow until cancelled. |
| Movement | `stop` | — | Flips the per-bot cancellation flag and cancels active pathfinder goals. |
| Movement | `lookAt` ⏳ | `target` | Face a target. |
| World | `mineBlock` | `type, count?` | Composite: find → path → equip → dig → `pickUpNearby` sweep. |
| World | `placeBlock` | `type, position` | Probes 6 adjacent positions for a solid reference block, derives face vector, equips, places. |
| Inventory | `pickUpNearby` | `maxDist?` | Collect dropped items in range. Snapshot-at-entry. |
| Inventory | `equipItem` | `item, slot?` | Hand / off-hand / armor slot. Looks across main + hotbar + already-equipped. |
| Inventory | `dropItem` | `item, count?` | Drop on ground. |
| Inventory | `giveItemTo` | `player, item, count?` | Walk to player and hand off (composite: `goTo` → `lookAt` → `dropItem`). |
| Interaction | `activateBlock` | `position, with?` | Right-click on a block (hoe-till, bucket fill / place, flint-and-steel, plant seeds, bone meal, doors, levers). |
| Interaction | `useOnEntity` | `entity, with?` | Right-click on a mob / player (shears sheep, bucket-milk cow, name tag, dye sheep, lead, saddle). |
| Interaction | `useItem` | `with?, offhand?` | Right-click in mid-air (throw pearl, throw splash potion, charge bow). Not for food — use `eat`. |
| Crafting | `craft` | `item, count?, tablePos?` | 2×2 inventory recipes or 3×3 table; table resolution falls back to `knownUtilities` remembered crafting_table. |
| Crafting | `smelt` | `input, fuel?, count?, furnacePos?` | Open furnace (caller → nearby → remembered POI), put input + fuel, take output. Closes the iron-armor production loop. |
| Combat | `attack` | `entity` | Tick-loop melee with weapon auto-equip. Cancellable. |
| Combat | `flee` | `from, dist?` | Path away from threat until `dist` separation. Cancellable; re-paths every ~1.5s. |
| Storage | `depositToChest` | `item, count?, pos?` | Walk to chest, deposit. `pos`-less default: nearest known container. Auto-capture hook snapshots contents on close. |
| Storage | `withdrawFromChest` | `item, count?, pos?` | Walk to chest, withdraw. `pos`-less default: nearest known container whose remembered contents include the item. |
| Survival | `eat` | `item?` | Equip food, `bot.consume()`. Auto-picks best food when `item` omitted. |
| Survival | `fish` | — | Wraps `bot.fish()`; cancellable; 5-minute timeout. Requires `fishing_rod` in hand. |
| Survival | `sleepIn` | `pos?` | Wraps `bot.sleep`; same fallback ladder (caller → nearby `*_bed` 32 blocks → remembered bed POI). |
| Meta | `remember` | `type, name?, pos?` | Record a POI to world knowledge ("this is the base"). `pos` defaults to bot's current position. Idempotent on (type, position). |
| Meta | `setTaskQueue` | `tasks` | Declare a multi-task plan. Current + remaining tasks surface in every `observeSurroundings`. |
| Meta | `advanceTaskQueue` | — | Mark current task done; promote the next. |
| Meta | `wait` ⏳ | `seconds` | Stand still for a duration. Marginal — model can express "do nothing" by not calling tools. |

### Skill design principles
- **Specific params, not vague descriptors.** Skills take concrete IDs. Vagueness is resolved in the model (helped by `observeSurroundings`), not in the skill layer.
- **Structured result.** Every skill returns `{ ok, message, state? }`. Failure messages must be specific enough for Claude to adapt: `"no oak_log within 64 blocks"`, `"inventory full"`, `"path blocked by water"`.
- **Sync / blocking.** Skills run to completion or failure; no progress streaming. Long-running tick-loop skills (`followPlayer`, `attack`, `flee`, `fish`) are cancellable via the per-bot cancellation flag (see *Bot state*).
- **Composite skills accepted.** `mineBlock(oak_log, 10)` hides 5–6 primitives — saves tokens but Claude can't intervene mid-skill on non-cancellable skills. Acceptable tradeoff; revisit if it bites.

### `observeSurroundings()` output shape
The bot's primary "look around". Load-bearing because Claude's defaults for vague requests depend on it.

```ts
{
  position, dimension, facing, time, weather,
  status: { health, food, saturation, experience, isInWater, isOnFire },
  heldItem: { name, count } | null,
  nearbyBlocks: [ { type, count, nearest: { x, y, z, dist } }, … ],   // grouped, top ~15
  nearbyEntities: [ { type, name?, pos, dist, lookingAt? }, … ],      // players → hostiles → passive, ~10 cap
  nearbyDroppedItems: [ { item, count, dist }, … ],
  knownStorage: [ { type, pos, dist, contents?, lastOpened?, lastOpenedBy? }, … ],   // from world.json containers[], proximity-sorted
  knownUtilities: [ { type, pos, dist, name? }, … ],                                  // from world.json pois[] filtered to utility blocks, proximity-sorted

  // Pre-computed middleware state (see Bot state below)
  recentActions: [ "mined 7 oak_log", "walked 200 blocks", "killed 2 zombies" ],   // rolling 5-min summary
  recentlySeenPlayers: [ { name, lastSeen, lastPos } ],                            // offline-but-recent
  currentTask: string | null,                                                       // from task queue
  remainingTasks: [ string ]                                                        // queued after current
}
```

Defaults: **16-block radius**, configurable per call. Block list is filtered to a noteworthy allowlist (trees, ores, water / lava, crafting tables, chests, beds, doors, portals) — never returns a raw voxel grid. `knownStorage` is sourced from the bot's `world.json`, joined with current proximity. The state fields (`recentActions`, `recentlySeenPlayers`, `currentTask`, `remainingTasks`) come from in-process bot state — see *Bot state* below.

## NPC behavior

### Handling vague requests
Real player chat is conversational and underspecified. Claude is taught (via system prompt) to pick one of three responses based on the cost-of-being-wrong:

- **Default and proceed** when the action is cheap, reversible, and the player can easily redirect. *"collect some wood"* → grab ~16 of the nearest tree type and narrate what's happening.
- **Ask one clarifying question** when the action is expensive, hard to reverse, or subjective. *"build a shelter"* → "Where, what size, what material?"
- **Propose a plan and wait for confirmation** for large multi-step tasks. *"I'll build a 5×5 wood hut next to that oak — sound good?"*

### Interruption while a skill runs
Chat arriving during a skill is **queued** until the skill finishes; Claude then handles it on the next turn. For the cancellable tick-loop skills (`followPlayer`, `attack`, `flee`, `fish`), a **side-channel preempt** in `mineflayer-glue/event-hooks.ts` flips the cancellation flag immediately when the current conversation partner says "stop" / "halt" / "wait" — the skill exits within its next tick (~100–250ms) without waiting for the chat to drain through the agent queue. Non-cancellable skills (`mineBlock`, `craft`, `smelt`, etc.) finish to completion; the player's chat is processed when they end.

### Conversation continuity
When Claude's last message to a player contained `?`, the orchestrator flags the (bot, player) pair for 30s; the player's next chat without a name-mention routes to that bot as `reason=continuation`. Detection is `sent.includes("?")` (`runSkill` → `noteBotQuestionedPlayer`) — relaxed from the original strict `endsWith` in commit `026836e` because the model often appends an acknowledgment after the question. Avoids the awkward *"Steve, small"* requirement.

## Memory model

Two distinct memory types, deliberately separated:

### World knowledge — structured, programmatically captured
Per-bot JSON file at `data/orchestrator/memory/<bot-username>/world.json` storing durable facts about the world. Written mostly by mineflayer event hooks (no Claude call); read by `observeSurroundings()` and related skills.

**Contents:**
- `pois[]` — points of interest (base, portals, beds, crafting tables, named locations) with type, optional name, position, timestamp, and source (`auto` or `claude`).
- `containers[]` — chest / barrel / shulker contents indexed by position, with `last_opened` timestamp and `last_opened_by`.
- `deaths[]` — death locations and causes for "where did I drop my stuff" recovery.

**Automatic capture (mineflayer events → direct write):**
- Container `windowOpen` / `windowClose` → snapshot contents into `containers[]`. Shipped in v0.3+: hook in `mineflayer-glue/event-hooks.ts` correlates the window to a block via a per-bot hint (set by the chest skills before they call `openChest`) with a `blockAtCursor(6)` fallback for chests opened via `activateBlock` or any other path.
- Bot enters ~8-block proximity of a crafting table / furnace / smithing table / etc. → upsert as POI in `pois[]`. Shipped in v0.3+: periodic 5s scan in `event-hooks.ts` walks `findBlocks` for the utility-block ID set and calls the idempotent `addPoi`. Cleared on `bot.on("end")`.
- Bot death event → record position and cause. (Pending.)

**Claude-driven capture (`remember` skill):**
- Player names a location (*"this is our base"*, *"call this spot the wheat farm"*) → Claude calls `remember(type, name, pos)`.
- Anything requiring judgment about what's worth recording.

### Conversation memory — free-form, Claude-managed
Per-bot running dialog state held by the Claude Agent SDK. Short-term: verbatim turns. Long-term: periodic summarization (Haiku 4.5) when history grows. Persistence across orchestrator restart is still deferred (see [ROADMAP.md](ROADMAP.md)).

## Bot state

Per-bot in-memory state that middleware maintains so Claude doesn't have to track it from conversation history. Distinct from memory: these are short-lived or always-current, not durable facts about the world. Most fields are surfaced to Claude through `observeSurroundings`; the in-flight tool name is observability-only (consumed by the dashboard).

### Recent actions log
Rolling 5-minute log of bot activity, summarized to short phrases (`"mined 7 oak_log"`, `"walked 200 blocks"`, `"killed 2 zombies"`). `runSkill` appends successful (non-noisy) skill messages; oldest entries drop off. When a player asks *"what have you been doing?"*, Claude reads the log rather than reconstructing from chat history. Not persisted across restarts.

### Player presence
Per-player table: online/offline, last-seen position, last-seen timestamp. Captured from mineflayer `playerJoin` / `playerLeave` / movement events. Currently-online nearby players appear in `nearbyEntities`; offline-but-recently-seen players appear in `recentlySeenPlayers`. Useful for answering "has Zack been on today?" without Claude guessing.

### Task queue
When a player chains requests (*"get wood, then iron, then come back"*), Claude calls `setTaskQueue(["get wood", "get iron", "return"])` to declare the plan, then `advanceTaskQueue()` between items. The orchestrator persists the queue across turns and surfaces `currentTask` + `remainingTasks` in every `observeSurroundings` call. Claude doesn't have to remember the chain from conversation memory — the queue is always in the bot's view of the world.

### Current tool (observability-only)
Name + start timestamp of the skill currently executing for this bot. Set/cleared by `runSkill` (`src/skills/harness.ts`) inside a `try/finally` so it's always reset even on exception. Read by the dashboard via `getBotSnapshot` to render the live `DOING` field; **not surfaced through `observeSurroundings`** — Claude doesn't need to see its own in-flight tool (it called it).

### Cancellation flag
Per-bot cooperative cancellation flag (`src/state/cancellation.ts`) checked by the long-running tick-loop skills (`followPlayer`, `attack`, `flee`, `fish`). Flipped two ways:
1. Claude calls the `stop` skill explicitly.
2. **Side-channel preempt** in `mineflayer-glue/event-hooks.ts` — when a cancellable skill is in flight and the current conversation partner sends a message matching `/\b(stop|halt|wait)\b/i`, the flag flips immediately, before the chat queues through the agent loop. This is what makes player-side "stop" actually preempt despite chat being queued.

Each cancellable skill calls `cancellation.begin()` on entry to clear any stale request from the previous run.

### Why the split
- **World knowledge is exact** — programmatic capture beats Claude summarization for facts (*"7 oak_log in the chest"* vs. *"a few logs I think"*).
- **World knowledge is cheap** — written without API calls; read as small JSON snippets, not as summarized tokens.
- **World knowledge is composable** — external scripts can query / inspect / repair it without going through Claude.
- **Conversation memory stays for what Claude is actually good at** — intent, tone, recent context, player preferences, in-flight clarification.

## Resilience

| Failure | Policy |
|---|---|
| Bot loses TCP to MC server | Exponential backoff, retry indefinitely (1s → 60s cap). Log each attempt. |
| Bot dies in-game | Auto-respawn. Drop the current skill (world state changed — bot is back at spawn with empty inventory). Announce in chat. |
| Agent SDK transient (5xx, network) | SDK handles its own retries. Orchestrator catches escapes and surfaces them as tool failures to Claude or as an in-chat apology to the player. |
| Agent SDK rate-limit (Pro window hit) | Whisper *"I'm rate-limited, try again in ~N minutes"* to the player. Drop subsequent chats until window resets. No retry loop — would burn more quota. |
| Skill throws unexpected exception | Catch in the skill harness, return `{ ok: false, message: "<exception text>" }` so Claude sees and adapts. Log stack separately. Never let an exception kill the bot. |

**Per-bot supervision:** if one bot's connection drops, only that bot reconnects; others stay running. Standard for in-process multi-bot orchestrators.

## Project layout

TypeScript project at the repo root. The actual tree is below. The only design-level file still deferred is `memory/conversation.ts` for cross-restart conversation persistence — see ROADMAP.md.

```
package.json
tsconfig.json
src/
  index.ts                  # entry — installs log buffer, loads config, starts supervisors + agents, optional dashboard
  mineflayer-glue/
    bot-factory.ts          # supervisor + reconnect + per-bot registry + state/connectedSince/bot getters
    event-hooks.ts          # wires bot chat/player events → state stores + chat router
  orchestrator/
    chat-router.ts          # filters chat events, routes to addressed bot (name-mention / @all / whisper / continuation)
  agent/
    npc-agent.ts            # per-bot Claude Agent SDK loop, async user-message queue, rate-limit cooldown, usage retention
    skill-tools.ts          # MCP-wrapped skill registration for the SDK (Zod schemas + namespaced tool names)
    system-prompt.ts        # prompt template
    behavior.ts             # model-id mapping, RateLimitCooldown
  skills/
    index.ts                # re-exports
    types.ts                # SkillResult, GoToTarget, shared param types
    harness.ts              # runSkill — exception trap, actions log, currentTool tracking, ?-question continuity
    chat.ts                 # say, whisper
    perception.ts           # observeSurroundings (surfaces knownStorage + knownUtilities from world.json)
    movement.ts             # goTo, stop, followPlayer
    world.ts                # mineBlock, placeBlock
    inventory.ts            # pickUpNearby, dropItem, giveItemTo, checkInventory, equipItem
    interaction.ts          # activateBlock, useOnEntity, useItem — right-click semantics for tool use
    crafting.ts             # craft, smelt (both with knownUtilities fallback for remembered tables/furnaces)
    combat.ts               # attack, flee
    storage.ts              # depositToChest, withdrawFromChest
    survival.ts             # eat, fish, sleepIn
    item-naming.ts          # normalize + did-you-mean lookup for item/block IDs (shared helper)
    meta.ts                 # remember, setTaskQueue, advanceTaskQueue
  state/
    index.ts                # BotState bundle + per-bot registry
    actions-log.ts          # rolling 5-min recent actions per bot
    player-presence.ts      # online/offline + last-seen tracking
    task-queue.ts           # per-bot multi-task queue
    current-tool.ts         # in-flight skill name + start timestamp (set by runSkill; read by snapshot/dashboard)
    cancellation.ts         # per-bot cooperative cancellation flag; flipped by stop skill + chat-event side-channel
  memory/
    world-knowledge.ts      # read/write per-bot world.json (pois[] auto-captured on utility-block proximity; containers[] auto-captured via windowOpen/windowClose hook)
  observability/
    log-buffer.ts           # ring buffer wrapping console.log/info/warn/error; subscribe + forwarding toggle
    snapshot.ts             # getBotSnapshot(username) → plain JSON-serializable struct; used by dashboard + future HTTP/WS
  dashboard/
    index.ts                # multi-bot blessed-contrib TUI; Tab cycles bots; mounted when DASHBOARD=1
    blessed-contrib.d.ts    # ambient shim (no @types/blessed-contrib on DefinitelyTyped)
  config.ts                 # loads config/bots.yml, validates shape, MC_VERSION pin
  types.ts                  # cross-cutting types (BotConfig, ModelHint, …)
config/
  bots.yml                  # versioned
data/orchestrator/memory/<bot-username>/world.json   # per-bot world knowledge (gitignored via data/)
scripts/
  dev.sh                    # MC up + orchestrator (host, foreground, tsx watch)
  dashboard.sh              # MC up + orchestrator with dashboard mounted (no watch — blessed and hot reload don't mix)
  start.sh, stop.sh, backup.sh, console.sh           # existing
spikes/
  sdk-spike.ts              # pinned SDK answers — see SDK_NOTES.md
  dashboard-spike.ts        # v0.3 phase 0 — confirmed blessed-contrib renders before wiring real data
```

Layer-named directories match the architecture's layer stack. `mineflayer-glue/` isolates the raw mineflayer surface — if we ever swap bot clients, only this directory changes. `observability/` and `dashboard/` are pure consumers — they read from the registries set up by lower layers and never write back into agent / skill / orchestrator state.

**Language:** TypeScript. Type-checked skill params, `observeSurroundings` output, and `world.json` schema catch a lot of bugs at compile time. Dev iteration is fast via `tsx`; Docker prod compiles to JS.

## Player ↔ NPC interaction

### Identity & server auth
Each NPC is a mineflayer client and therefore a real player from the server's perspective. The server runs in **offline-mode with a whitelist**:

- Friends connect with their normal Mojang usernames; the whitelist enforces who's allowed in.
- NPCs use chosen usernames (e.g. `Steve_AI`) with no Mojang account required.
- Residual risk: a stranger who knows both the server address and a whitelisted username could impersonate that friend. Acceptable for a small private server behind a non-public DNS name.

Switch is safe to make now because no one has played on the world yet — once players join in online-mode, their UUIDs would diverge from offline-mode UUIDs and migration would be required.

### Alternative considered: server-side NPCs via Paper plugin (e.g. Citizens)
Rejected. NPCs would be fake entities spawned by a Java plugin rather than real mineflayer clients — they wouldn't need accounts or whitelist slots, and wouldn't appear in the player list. The cost: drops the entire mineflayer ecosystem (pathfinder, inventory handling, world parsing, mature event surface), requires writing a Paper plugin in Java (build cycle, server restart to deploy), and the orchestrator-to-plugin bridge becomes its own IPC surface. Much bigger lift than offline-mode + whitelist, and many interactions (PvP, scoreboards, vanilla mechanics) behave differently for "fake" NPCs. Revisit only if (a) accountless NPCs become a hard requirement (e.g., opening to a wider server where impersonation matters more) or (b) bot count gets large enough that managing usernames is awkward.

### Interaction modes
- **Name mention in public chat** (primary). Orchestrator regex-filters every chat event for each bot's name and wakes only the addressed bot. Reply in public chat.
- **`/msg <bot>` whispers**. Private 1:1 tasking. Bot whispers back. Surfaced as a separate event by mineflayer.
- **`@all` group address**. Trivial extension of the filter layer; wakes every bot at once.
- **Conversation continuation** (no name mention). 30s window after a `?`-message; routes the same player's next chat to the bot that asked. Includes a side-channel "stop" preempt for cancellable skills (see *Cancellation flag* under *Bot state*).

### Response channel
Bots reply on the channel they were addressed on: public ↔ public, whisper ↔ whisper.

### Deferred
See [ROADMAP.md](ROADMAP.md) for technical sketches. Briefly: ambient overhearing (cut for token budget), right-click / trade GUI / sign interactions (needs Paper plugin), multi-NPC coordination, personas, owner-based safety limits.

## Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Tool surface | In-process skill layer | Right abstraction for Claude; no IPC overhead |
| Event model | Event-driven (chat / skill done / heartbeat) | Avoid per-tick API costs and latency |
| Process model | One orchestrator, N bots in-process | Simple; can split later if scale demands |
| Prompt caching | System prompt + tool defs cached | Cuts cost on repeated turns |
| Server auth | Offline-mode + whitelist | No Mojang account per bot; whitelist gates impersonation |
| Interaction routing | Name-mention + `/msg` + `@all` (ambient deferred) | Covers explicit tasking; ambient cut to fit Pro token budget |
| Claude runtime | Claude Agent SDK + Pro subscription auth | No new billing; built-in agent loop; tradeoff is 5-hour rolling rate limits |
| Default model | Sonnet 4.6 main / Haiku 4.5 background / Opus 4.7 opt-in | Cost/quality balance; reserved escalation for hard tasks |
| Orchestrator process | Hybrid: host `npm run dev` for v0, compose service later | Fastest iteration now; clean deploy story later, same code |
| Launcher scripts | `dev.sh` (host, foreground) + existing `start.sh` (compose, unchanged) | One command per mode; no double-edit of `start.sh` |
| Skill scope | 28 registered skills across perception / chat / movement / world / inventory / interaction / crafting / combat / storage / survival / meta; 4 pending (`findBlock`, `findEntity`, `lookAt`, `wait` — all low-value). See [SKILLS.md](SKILLS.md) status table. | Capable from day one |
| Architecture principle | "Push work down the stack" — middleware does anything deterministic; Claude only handles judgment | Lower latency, lower token spend, more reliable behavior |
| Bot state | Recent-actions log (rolling 5-min), player-presence tracking, task queue — all surfaced in `observeSurroundings` | Claude reads pre-computed state instead of reconstructing from chat history |
| Memory architecture | Two-tier: structured world knowledge (per-bot JSON, mostly auto-captured) + conversation memory (Claude-managed) | Cheap, exact, composable facts; Claude does only what Claude is good at |
| Resilience | Indefinite reconnect; auto-respawn on death; SDK retries + chat-surfaced rate-limit handling; skill exceptions become `{ok: false}` results | Bots survive transient failures; players see meaningful feedback when something durable breaks |
| Bot config | `config/bots.yml` (versioned), minimal fields (`username`, `model_hint`) | No new secrets; persona/owner still deferred |
| MC connection | `MC_HOST` env var, defaults to `localhost`; switches to `minecraft` when orchestrator becomes a compose service | Same code for dev and steady-state |
| Language | TypeScript | Type-checked skill params, `observeSurroundings` output, world.json schema |
| Project layout | Layer-named directories (`orchestrator/`, `agent/`, `skills/`, `memory/`, `mineflayer-glue/`) | Matches architecture stack; isolation point for bot-client swap |
| Skill params | Specific machine-friendly IDs | Predictable and testable; vagueness resolved in the model |
| Tool result shape | `{ ok, message, state? }` | Consistent format; specific failure messages let Claude adapt |
| Execution model | Sync / blocking; cancellable tick-loop skills check a per-bot cancellation flag; non-cancellable skills run to completion | Simpler than full mid-skill preemption; matches the "queue chat during skills" interruption policy |
| Vagueness handling | Default / clarify / propose-and-confirm, taught via system prompt | Right tradeoff per request cost |
| Interruption | Queue chat during skills; player says "stop" to preempt | Avoids mid-skill races |

## Open questions

- Conversation memory specifics: summarization threshold, where (if anywhere) to persist conversation state across restarts. (World knowledge already persists by design.) Sketched in [ROADMAP.md](ROADMAP.md).
- Multi-NPC coordination: do NPCs share `world.json` (or a merged view), or is each one fully independent? Currently independent — `world.json` is per-bot.
- Safety / griefing limits: which actions need allowlists or owner confirmation (e.g. breaking player-placed blocks, `attack({ entity: "<player_name>" })`). Closer to relevant than originally scoped — `attack` will hit a player username today. Sketched in [ROADMAP.md](ROADMAP.md) under "Owner-based safety / griefing limits".
- Heuristic tuning: conversation-continuity window (~30s; `?`-detection relaxed from `endsWith` to `includes` in `026836e`), "stop" regex (`/\b(stop|halt|wait)\b/i`), recent-actions log window (5 min). All judgment calls; tune when something feels wrong in live play.

Agent SDK specifics are now pinned in [spikes/SDK_NOTES.md](spikes/SDK_NOTES.md) — no longer open.
