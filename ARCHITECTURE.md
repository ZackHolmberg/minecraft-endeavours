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
Per-bot Claude Agent SDK loop on **Claude Haiku 5.5** (`claude-haiku-5-5`). Event-driven — wakes on chat-to-bot. **Disk is the source of truth; the model keeps as little context as possible.** Two session modes (`session_mode` in `bots.yml`):

- **`per_task` (default)** — each routed player message gets a fresh `query()`, closed when its result arrives. The single user message is a deterministic **context block** (`buildAgentContext` in `src/agent/planning-context.ts`: position/status/inventory/nearby, known storage/utilities/waypoints, last death, persisted recent actions, task queue, and the last ~14 lines of `conversation.json`) followed by the chat line. The system prompt tells the model this block is ground truth and overrides anything it remembers. Messages arriving mid-task are queued and coalesced into the next fresh task. Follow-ups ("now put it in the chest") resolve from the on-disk conversation log, so restarts lose nothing.
- **`persistent`** (rollback) — the original single long-lived streaming-input `query()`; still gets the context block per message.

The system prompt interpolates only the username, so the system prompt + tool-definition prefix stays byte-stable and prompt-caches across sessions. Guardrails in `claude-backend.ts` / `skill-tools.ts`: 50-turn cap per task (then one "tell the player where things stand" follow-up), a **repeat-failure guard** (a third identical failing call is refused unrun; after 6 failures every failure carries a stop-and-report nudge), adaptive thinking at explicit `effort: "medium"` (Haiku 5.5 rejects a fixed `budgetTokens`), and refusal handling: Haiku 5.5's safety classifiers can decline a request and there is deliberately no fallback model, so the bot whispers the player a short "can't help with that" and the task outcome records the decline. See [spikes/SDK_NOTES.md](spikes/SDK_NOTES.md).

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
**Claude Haiku (currently Haiku 5.5, `claude-haiku-5-5`, released 2026-10-07) for the main NPC loop, via the plain `claude` backend** — the standing decision (Oct 2026); track new Haiku releases. Moving Haiku generations is not just an ID swap: check the migration guide for thinking/sampling changes, and keep `@anthropic-ai/claude-agent-sdk` current so its bundled CLI knows the model. Not the local model, not hybrid, not other tiers. Behavior problems are fixed with prompts, tool descriptions, and deterministic middleware, not by switching models. `model_hint` still accepts `sonnet` / `opus`, and the `local` / `hybrid` backends remain in the code but are unused.

### Orchestrator process model
**Hybrid (Option C).** Host process for development, Docker Compose service for steady-state — same code, different launcher.

Lifecycle is split across three pairs of scripts, each with a single job — no script controls anything outside its lane:

- **Server control:** `./scripts/start.sh` / `./scripts/stop.sh` (docker compose).
- **Bot control:** `./scripts/botStart.sh` is the *only* entry point for starting the orchestrator. It refuses to run if the MC server isn't reachable on `:25565` or if a previous orchestrator is still alive, then detaches `npm run start` into the background with stdout/stderr captured in `.bot-runtime/bot.log`. `./scripts/botStop.sh` sends SIGTERM and waits for graceful shutdown.
- **Viewers (read-only):** `./scripts/botLogs.sh` (tails `.bot-runtime/bot.log`) and `./scripts/dashboard.sh` (mounts the TUI). Both refuse to run if the MC server or the bot isn't already up. Quitting either viewer never stops anything.

Runtime state lives under `./.bot-runtime/` (gitignored): `bot.pid` (orchestrator writes its own to avoid npm/tsx wrapper PID issues), `bot.log` (orchestrator stdout/stderr), `snapshot.json` (500ms dump via `src/snapshot-writer.ts`, consumed by the dashboard client).

**Steady-state:** Once the loop and skills stabilize, add a Dockerfile and an `orchestrator` service to `docker-compose.yml`. `./scripts/start.sh` then brings up everything together with no script change.

## Configuration

### Bot config — `config/bots.yml`
Versioned in git. One entry per bot. Minimal shape:

```yaml
bots:
  - username: Steve_AI
    model_hint: haiku
    backend: claude
    session_mode: per_task
```

Fields:
- `username` — Minecraft username the bot connects as (must be on the whitelist).
- `model_hint` — `haiku` (default) / `sonnet` / `opus`. Mapped to a full model ID at the agent boundary (`src/agent/behavior.ts`).
- `backend` — `claude` (default) / `local` / `hybrid`.
- `session_mode` — `per_task` (default) / `persistent`. See *NPC Agent*.

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
| World | `mineBlock` | `type, count?` | Single-type variant. Wrapper around `mineBlocks` for one-type asks. |
| World | `mineBlocks` | `types[], maxCount?, maxDistance?` | Multi-type prospecting — "any of these ores you can find". Per-type tool-tier preflight; unmineable types skipped, not fatal. |
| World | `placeBlock` | `type, position` | Probes 6 adjacent positions for a solid reference block, derives face vector, equips, places. |
| World | `placeBlocks` | `blocks[]` | Batch placement (up to 64). One round-trip for a whole wall course. |
| Inventory | `pickUpNearby` | `maxDist?` | Collect dropped items in range. Snapshot-at-entry. |
| Inventory | `equipItem` | `item, slot?` | Hand / off-hand / armor slot. Looks across main + hotbar + already-equipped. |
| Inventory | `equipLoadout` | `head?, torso?, legs?, feet?, hand?, offHand?` | Multi-slot equip in one call. Object (not array) — slots are a closed set. |
| Inventory | `dropItem` | `item, count?` | Drop on ground. |
| Inventory | `giveItemTo` | `player, item, count?` | Single-item handoff. Wrapper around `giveItemsTo`. |
| Inventory | `giveItemsTo` | `player, items[]` | Multi-item handoff — full toolset / armor set in one walk. |
| Interaction | `activateBlock` | `position, with?` | Right-click on a block (hoe-till, bucket fill / place, flint-and-steel, plant seeds, bone meal, doors, levers). |
| Interaction | `useOnEntity` | `entity, with?` | Right-click on a mob / player (shears sheep, bucket-milk cow, name tag, dye sheep, lead, saddle). |
| Interaction | `useItem` | `with?, offhand?` | Right-click in mid-air (throw pearl, throw splash potion, charge bow). Not for food — use `eat`. |
| Crafting | `craft` | `item, count?, tablePos?` | Single-recipe variant. Wrapper around `craftMany`. |
| Crafting | `craftMany` | `items[], tablePos?` | Multi-recipe craft. Table resolved lazily (no walk if every item is 2×2). |
| Crafting | `smelt` | `input, fuel?, count?, furnacePos?` | Open furnace (caller → nearby → remembered POI), put input + fuel, take output. Auto-refuels mid-batch from inventory; folds leftover same-type input into the goal. Closes the iron-armor production loop. |
| Combat | `attack` | `entity` | Tick-loop melee with weapon auto-equip. Cancellable. |
| Combat | `flee` | `from, dist?` | Path away from threat until `dist` separation. Cancellable; re-paths every ~1.5s. |
| Storage | `depositToChest` | `item, count?, pos?` | Single-item stash. Wrapper around `depositManyToChest`. |
| Storage | `depositManyToChest` | `items[], pos?` | Multi-item stash. Open + close once; auto-capture snapshots once per batch. |
| Storage | `withdrawFromChest` | `item, count?, pos?` | Single-item pull. Wrapper around `withdrawManyFromChest`. |
| Storage | `withdrawManyFromChest` | `items[], pos?` | Multi-item pull. `pos`-less default resolves via the first item. |
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
- **Batch siblings for every unary skill with a real multi-target use case.** `mineBlocks` / `giveItemsTo` / `equipLoadout` / `craftMany` / `depositManyToChest` / `withdrawManyFromChest`. Each unary skill is a one-line wrapper around its batch sibling — guarantees parity for size-1 calls and halves the maintenance surface. Common failure shape: stop at first per-item failure, return `state.<thing-done>[]` + `state.failedIndex` so the agent re-plans from that index without replaying what landed.

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
Chat arriving during a task is **queued** and handled as the next task. A stop command (`isStopCommand` in `chat-router.ts` — strict: "stop/cancel/nvm…" must lead a ≤5-word message; "wait"/"hold on" only count alone, so "wait, also grab coal" is not a stop) does two things:
1. **Side-channel preempt** in `event-hooks.ts` flips the cancellation flag immediately for the cancellable skills (`goTo`, `followPlayer`, `mineBlock(s)`, `placeBlocks`, `pillarUp`, `attack`, `flee`, `fish`, `smelt`) — they exit within a tick or between blocks.
2. `npc-agent.ts` runs the `stop` skill and ends the in-flight task (`Query.close()` in per_task mode, `interrupt()` in persistent). The next task waits up to 35s for the abandoned skill to wind down (re-asserting the stop flag meanwhile) so two skills never drive the bot at once.

Every skill also has a 10-minute watchdog in `runSkill` (`followPlayer` exempt).

### Conversation continuity
- **Name aliases:** the bot answers to its username or its base name with an `_AI` / `_Bot` / `_NPC` suffix stripped (`Steve_AI` → "steve").
- **Question window:** when the bot's last message to a player contained `?`, that player's next un-named chat within **45s** routes back as `reason=continuation`.
- **Follow-up window:** for **20s** after any bot reply, the player's un-named chat routes back as `reason=follow-up` (so "thanks" / "now make planks" work). The routing note tells the model silence is fine if the line clearly wasn't meant for it.

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
- Bot death event → record position and cause (parsed from the server death message within 3s) into `deaths[]` (newest 20), plus an actions-log line. Shipped.

Writes to `world.json` are serialized per bot (the 5s POI scan, container snapshots and `remember` used to race).

**Claude-driven capture (`remember` skill):**
- Player names a location (*"this is our base"*, *"call this spot the wheat farm"*) → Claude calls `remember(type, name, pos)`.
- Anything requiring judgment about what's worth recording.

### Conversation memory — on disk
`src/memory/conversation-log.ts` → `data/orchestrator/memory/<bot>/conversation.json`: the last 60 entries (player lines, bot lines, one outcome line per finished task). The context block renders the last ~14 from the past hour. In `per_task` mode this is the *only* conversation memory; the SDK session is discarded after each task.

All per-bot durable files live in `data/orchestrator/memory/<bot>/`: `world.json`, `conversation.json`, `tasks.json`, `actions.json`. Writes are temp-then-rename; a malformed file starts fresh.

## Bot state

Per-bot in-memory state that middleware maintains so Claude doesn't have to track it from conversation history. Distinct from memory: these are short-lived or always-current, not durable facts about the world. Most fields are surfaced to Claude through `observeSurroundings`; the in-flight tool name is observability-only (consumed by the dashboard).

### Recent actions log
Rolling 5-minute log of bot activity, summarized to short phrases (`"mined 7 oak_log"`, `"walked 200 blocks"`, `"killed 2 zombies"`). `runSkill` appends successful (non-noisy) skill messages; oldest entries drop off. When a player asks *"what have you been doing?"*, Claude reads the log rather than reconstructing from chat history. Persisted to `actions.json` (last 50, timestamped, via `ActionsLog.history()`); `recent()` still returns the 5-minute view.

### Player presence
Per-player table: online/offline, last-seen position, last-seen timestamp. Captured from mineflayer `playerJoin` / `playerLeave` / movement events. Currently-online nearby players appear in `nearbyEntities`; offline-but-recently-seen players appear in `recentlySeenPlayers`. Useful for answering "has Zack been on today?" without Claude guessing.

### Task queue
When a player chains requests (*"get wood, then iron, then come back"*), Claude calls `setTaskQueue(["get wood", "get iron", "return"])` to declare the plan, then `advanceTaskQueue()` between items. The orchestrator persists the queue to `tasks.json` (survives restarts) and surfaces `currentTask` + `remainingTasks` in every `observeSurroundings` call. Claude doesn't have to remember the chain from conversation memory — the queue is always in the bot's view of the world.

### Current tool (observability-only)
Name + start timestamp of the skill currently executing for this bot. Set/cleared by `runSkill` (`src/skills/harness.ts`) inside a `try/finally` so it's always reset even on exception. Read by the dashboard via `getBotSnapshot` to render the live `DOING` field; **not surfaced through `observeSurroundings`** — Claude doesn't need to see its own in-flight tool (it called it).

### Cancellation flag
Per-bot cooperative cancellation flag (`src/state/cancellation.ts`) checked by the cancellable skills (see *Interruption while a skill runs*) and by `navigate()`. Flipped by the `stop` skill, the chat side-channel preempt, and bot death. `runSkill` resets it at the start of every skill except `stop`, so a stale stop never kills the next skill.

### Reflexes (`src/skills/auto-behaviors.ts`)
Player-like behavior that never costs an LLM call: face the nearest player / conversation partner when idle, auto-eat (food ≤14, or low health), wear better armor after pickup, and swing back at a hostile mob that just hurt the bot (never players, never paths). All reflexes share a per-bot lock that `runSkill` waits on (≤4s), so reflex and skill inventory clicks never interleave.

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
    world.ts                # mineBlock, mineBlocks, placeBlock, placeBlocks
    inventory.ts            # pickUpNearby, dropItem, giveItemTo, giveItemsTo, checkInventory, equipItem, equipLoadout
    interaction.ts          # activateBlock, useOnEntity, useItem — right-click semantics for tool use
    crafting.ts             # craft, craftMany, smelt (both with knownUtilities fallback for remembered tables/furnaces)
    combat.ts               # attack, flee
    storage.ts              # depositToChest, depositManyToChest, withdrawFromChest, withdrawManyFromChest
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
    snapshot.ts             # getBotSnapshot(username) → plain JSON-serializable struct; used by snapshot-writer + future HTTP/WS
  dashboard/
    index.ts                # standalone blessed-contrib TUI; polls .bot-runtime/snapshot.json; Tab cycles bots
    blessed-contrib.d.ts    # ambient shim (no @types/blessed-contrib on DefinitelyTyped)
  snapshot-writer.ts        # orchestrator-side: dumps getAllBotSnapshots() + recent logs to .bot-runtime/snapshot.json every 500ms
  runtime-paths.ts          # shared on-disk paths (.bot-runtime/{bot.pid,bot.log,snapshot.json})
  config.ts                 # loads config/bots.yml, validates shape, MC_VERSION pin
  types.ts                  # cross-cutting types (BotConfig, ModelHint, …)
config/
  bots.yml                  # versioned
data/orchestrator/memory/<bot-username>/world.json   # per-bot world knowledge (gitignored via data/)
scripts/
  botStart.sh                # only entry point for starting the bot — refuses if MC down or bot already up; detaches orchestrator
  botStop.sh                # SIGTERM the running orchestrator; waits for clean shutdown
  botLogs.sh                # tail -F .bot-runtime/bot.log (read-only viewer)
  dashboard.sh              # mount TUI dashboard against the running bot (read-only viewer)
  start.sh, stop.sh, backup.sh, console.sh           # server control (docker compose) + existing
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
| Default model | Claude Haiku (5.5) for the main loop; other tiers unused | Owner decision (Oct 2026): Haiku only; fix behavior via prompts and middleware |
| Orchestrator process | Hybrid: host `botStart.sh` (detached) for v0, compose service later | Fastest iteration now; clean deploy story later, same code |
| Launcher scripts | Three lanes: server (`start.sh`/`stop.sh`), bot (`botStart.sh`/`botStop.sh`), viewers (`botLogs.sh`/`dashboard.sh`) | Each script does one thing; viewers can't accidentally start the server or the bot |
| Dashboard ↔ orchestrator coupling | Out-of-process via `.bot-runtime/snapshot.json` (500ms dump) | Quitting the dashboard never disturbs the bot; future HTTP/WS API has the same shape |
| Skill scope | 34 registered skills across perception / chat / movement / world / inventory / interaction / crafting / combat / storage / survival / meta (28 in v0.3 + 6 batch siblings in v0.4); 4 pending (`findBlock`, `findEntity`, `lookAt`, `wait` — all low-value). See [SKILLS.md](SKILLS.md) status table. | Capable from day one |
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

## Telemetry & insight

Observe-only instrumentation; it never changes behavior and never throws into gameplay.

- **Contract:** `src/observability/telemetry-types.ts`. Event kinds:
  - **Tasks:** `task_start` / `task_end`, which carry queue wait, context-build time, first-reply latency, turns, tokens, cache use, cost and outcome. Also `guard_refusal`.
  - **Skills:** `skill`.
  - **Movement:** `nav`, `door`, `pillar`, `structure_skip`.
  - **Survival:** `reflex`, `hurt`, `death`.
  - **Chat:** `chat_in` / `chat_out`.
  - **Health:** `connection`, `loop_lag`, `rate_limit`.
- **Writer:** `telemetry.ts`.
  - Buffered async JSONL to `data/orchestrator/telemetry/<bot>/events.jsonl`, flushed every 1s or every 50 events, and on shutdown.
  - Rotates at 5MB to `events.1.jsonl`.
  - Keeps an in-memory ring of 20k events per bot for live aggregates.
  - Events inside a task carry its `taskId`; every event carries the process `runId`.
  - Routed-chat metadata is handed from `event-hooks` to the backend via `noteRoutedChat` / `takeRoutedChat`.
- **Aggregation:** `aggregate.ts` is pure, with no I/O. It uses nearest-rank percentiles and normalizes failure messages (coordinates and numbers stripped) for top-failure grouping.
- **Consumers:**
  - `snapshot.json` gets `telemetry` (last 30 min plus the whole run) and `memory` (an on-disk view, refreshed every ≤5s).
  - The dashboard has pages 2–4.
  - `scripts/botReport.sh` reads the JSONL directly, so it works with the bot down, and prints automatic flags. Thresholds live in `src/report/flags.ts`:
    - cache hit below 50%: the prefix isn't stable;
    - p50 first reply above 5s: consider `persistent`;
    - tasks at or near the turn cap;
    - context-build timeouts;
    - skills under 60% success;
    - harness watchdog hits;
    - repeated stuck spots within 3 blocks;
    - disconnects, deaths, loop lag.
- **Turn counting:** the SDK streams one assistant message per content block, sharing a `message.id`. The backend counts unique ids, or uses the result's `num_turns`. The pre-v0.5 counter included thinking-only blocks and over-reported.
- **Known gaps:**
  - The `local` and `hybrid` backends emit partial or no task events.
  - `nav: no_path` covers both a pathfinder "no path" and a path that ended early.
  - The report has its own synchronous JSONL reader (`src/report/read-events.ts`) alongside `readAllEvents`. Keep the two in sync if the layout changes.

## Web control panel

A standalone, always-on host process for remote management. It runs separately from the orchestrator, so it works when the server or the bot is down. **It is publicly exposed** over HTTPS at the DuckDNS hostname and includes a raw RCON console. That was a deliberate owner decision over Tailscale-only access, so the design is security-first.

- **Code:**
  - Contract: `src/web/shared/api.ts`.
  - Server: `src/web/server/`, using Node `https` and `ws` with no framework.
  - UI: `src/web/ui/`, Vite + Preact, built to the gitignored `src/web/ui/dist/`.
  - Runtime data: `data/panel/`, mode 700. It holds `secrets.json`, `audit.jsonl`, `tls/`, `panel.pid` and `panel.log`.
- **Lifecycle:**
  - `scripts/panelSetup.sh` sets the password and enrolls TOTP. With `--install-launchd` / `--uninstall-launchd` it manages a LaunchAgent, which starts the panel at login and restarts it if it crashes.
  - `scripts/panelStart.sh` / `panelStop.sh`. Pass `--dev` for a self-signed, loopback-only instance.
- **Access:** router TCP 443 → Mac 8443 (`PANEL_PORT`). Only HTTPS is served, with no HTTP listener.
- **TLS:** a Let's Encrypt certificate via ACME DNS-01 through the DuckDNS TXT API, using `DUCKDNS_TOKEN`. It is checked every 12h and renewed under 30 days, with a hot swap. The panel also updates the DuckDNS A record itself, because `stop.sh` stops the duckdns container.
- **Auth:**
  - A single admin with a scrypt password and **mandatory TOTP**. TOTP codes can't be replayed.
  - Sessions are server-side, with 256-bit IDs, rotated on login. The cookie is `__Host-`, HttpOnly, Secure, SameSite=Strict. Idle timeout is 12h, with a 7-day absolute cap.
  - CSRF: a per-session `X-CSRF-Token` plus Origin and Host allowlists, which also block DNS rebinding.
  - Login lockout: per IP, exponential, from 1 min up to 24h. Plus a **global slowdown**, not a lockout: while ≥20 failures (any IP) sit in a 15-min window, IPs that have never logged in successfully share one attempt per 10s. IPs with a prior successful login (last 30 days, in memory) skip it, so a distributed attacker can't starve the owner. This replaced a hard global lockout (15 min → 6h) that let anyone lock the owner out.
- **Command safety:**
  - Actions are a fixed allowlist of 8 (server/bot start/stop/restart, save, backup), mapped to fixed script argv and spawned without a shell. Only one job per group runs at a time.
  - The console runs `docker compose exec -T minecraft rcon-cli <cmd>` as a single argv. Commands are at most 256 chars, with no control chars and no leading `-`.
- **Hardening:**
  - Strict CSP: `default-src 'self'`, no inline script or style, `frame-ancestors 'none'`.
  - 16KB body cap, request and connection limits, and WebSocket frame, connection and subscription caps.
  - No stack traces or paths in responses. Static serving is realpath-confined.
- **Audit:** every login attempt, action, console command and player change goes to `audit.jsonl` with the client IP. It is viewable in the UI.
- **Known limits:**
  - Rate-limit, lockout and replay state is in memory, so it resets on restart.
  - It's a LaunchAgent, not a daemon, so it needs a logged-in user. Unattended reboot needs auto-login, which is incompatible with FileVault.
  - The itzg `WHITELIST` env may re-apply the whitelist when the container restarts.
