# Architecture

Forward-looking design for the **AI NPC system**: Minecraft players backed by Claude that you can chat with and assign tasks.

## Goals

- Multiple NPCs join the existing Paper server as regular players (via [mineflayer](https://github.com/PrismarineJS/mineflayer)).
- Each NPC is driven by a Claude conversation that decides what to do via tool use.
- Players interact with NPCs through in-game chat; NPCs can carry out multi-step tasks (gather, build, follow, mine, craft).

## Layer stack

```
Orchestrator              spawns / supervises NPCs, routes chat
  └─ NPC Agent            Claude API loop, event-driven, per-bot memory
       └─ Skills          high-level capabilities exposed as Claude tools
            └─ mineflayer + pathfinder (raw bot API)
                 └─ Paper server (existing docker-compose service)
```

## Why a skill layer (and not MCP, not raw mineflayer)

- **Raw mineflayer is too low-level for Claude.** Most useful actions chain 3–6 primitives (find → path → face → dig → pick up). Driving those directly burns tokens, adds latency per tool round-trip, and produces brittle plans.
- **Skills wrap multi-step mineflayer sequences into single task-level tools** like `gatherWood(amount)`, `mineNearest(blockType)`, `followPlayer(name)`, `craft(item, count)`, `placeBlock(type, pos)`, `observeSurroundings()`. Claude reasons at the task level, one tool call ≈ one meaningful action.
- **MCP would add a process boundary without payoff.** Its value is sharing a tool surface across distinct AI clients; here one orchestrator owns each bot, both ends under our control. The skill layer can be re-exposed as MCP later if we ever want to drive a bot interactively from Claude Code.
- **Per-NPC state (memory, current goal, inventory beliefs) lives in-process** alongside the skills, simpler than serializing across an IPC boundary.

## Components

### Orchestrator
Single Node.js process that spawns one NPC agent per configured bot account, supervises reconnects, and routes in-game chat events to the right NPC.

### NPC Agent
Per-bot Claude API loop. Event-driven (not a tight tick loop) — wakes on chat-to-bot, skill completion, or periodic heartbeat. Maintains short-term conversation history plus summarized long-term memory. System prompt + tool definitions are prompt-cached.

### Skills
A library of high-level capabilities exposed to Claude as tools. Each skill is a JS function that orchestrates mineflayer primitives and returns a structured result. Skills are unit-testable independently of Claude.

### mineflayer layer
The raw bot client plus `mineflayer-pathfinder` for movement. Not exposed to Claude directly.

## Skill catalogue (v1)

Each skill is a JS function exposed to Claude as a tool. Skills take **specific, machine-friendly parameters** (block IDs, item IDs, entity types); Claude translates vague player intent into specific calls. All skills block until done or fail and return a structured result:

```ts
{ ok: boolean, message: string, state?: object }
```

| Category | Skill | Params | Notes |
|---|---|---|---|
| Perception | `observeSurroundings` | — | Nearby blocks (with counts/distances), entities, players, time, weather, bot health/hunger/position. Claude's primary "look around". |
| Perception | `findBlock` | `type, maxDist?` | Nearest block of a type. |
| Perception | `findEntity` | `filter, maxDist?` | Nearest entity (mob type or player name). |
| Perception | `checkInventory` | — | What the bot currently holds. |
| Movement | `goTo` | `target` | Coords / entity / block. Uses pathfinder. |
| Movement | `followPlayer` | `name, dist?` | Sustained follow until stopped. |
| Movement | `stop` | — | Cancel current movement / action. |
| Movement | `lookAt` | `target` | Face a target. |
| World | `mineBlock` | `type, count?` | Composite: find → path → dig → pick up. |
| World | `placeBlock` | `type, position` | Place from inventory. |
| World | `activateBlock` | `position` | Doors, chests, levers, buttons. |
| Inventory | `pickUpNearby` | `maxDist?` | Collect dropped items in range. |
| Inventory | `equipItem` | `item, slot?` | Hand / armor slot. |
| Inventory | `dropItem` | `item, count?` | Drop on ground. |
| Inventory | `giveItemTo` | `player, item, count?` | Walk to player and hand off. |
| Crafting | `craft` | `item, count?` | Handles crafting-table proximity. |
| Combat | `attack` | `entity` | Basic melee. |
| Combat | `flee` | `from, dist?` | Path away from threat. |
| Chat | `say` | `message` | Public chat. |
| Chat | `whisper` | `player, message` | Private reply. |
| Meta | `wait` | `seconds` | "Stand here for a bit". |

### Skill design principles
- **Specific params, not vague descriptors.** Skills take concrete IDs. Vagueness is resolved in the model (helped by `observeSurroundings`), not in the skill layer.
- **Structured result.** Every skill returns `{ ok, message, state? }`. Failure messages must be specific enough for Claude to adapt: `"no oak_log within 64 blocks"`, `"inventory full"`, `"path blocked by water"`.
- **Sync / blocking.** Skills run to completion or failure; no progress streaming in v1.
- **Composite skills accepted.** `mineBlock(oak_log, 10)` hides 5–6 primitives — saves tokens but Claude can't intervene mid-skill. Acceptable tradeoff for v1; revisit if it bites.

## NPC behavior

### Handling vague requests
Real player chat is conversational and underspecified. Claude is taught (via system prompt) to pick one of three responses based on the cost-of-being-wrong:

- **Default and proceed** when the action is cheap, reversible, and the player can easily redirect. *"collect some wood"* → grab ~16 of the nearest tree type and narrate what's happening.
- **Ask one clarifying question** when the action is expensive, hard to reverse, or subjective. *"build a shelter"* → "Where, what size, what material?"
- **Propose a plan and wait for confirmation** for large multi-step tasks. *"I'll build a 5×5 wood hut next to that oak — sound good?"*

### Interruption while a skill runs
Chat arriving during a skill is **queued** until the skill finishes; Claude then handles it. To preempt, the player says "stop" → Claude calls `stop()` → handles the new request. Simpler than mid-skill preemption; revisit if it feels laggy.

### Conversation continuity
When Claude's last message to a player was a question, the orchestrator treats that player's next chat as a likely continuation. Heuristic: if a bot recently (~30s) asked a question and the same player chats again, route to that bot regardless of name-mention. Avoids the awkward *"Steve, small"* requirement.

## Player ↔ NPC interaction

### Identity & server auth
Each NPC is a mineflayer client and therefore a real player from the server's perspective. The server runs in **offline-mode with a whitelist**:

- Friends connect with their normal Mojang usernames; the whitelist enforces who's allowed in.
- NPCs use chosen usernames (e.g. `Steve_AI`) with no Mojang account required.
- Residual risk: a stranger who knows both the server address and a whitelisted username could impersonate that friend. Acceptable for a small private server behind a non-public DNS name.

Switch is safe to make now because no one has played on the world yet — once players join in online-mode, their UUIDs would diverge from offline-mode UUIDs and migration would be required.

### Interaction modes (v1)
- **Name mention in public chat** (primary). Orchestrator regex-filters every chat event for each bot's name and wakes only the addressed bot. Reply in public chat.
- **`/msg <bot>` whispers**. Private 1:1 tasking. Bot whispers back. Surfaced as a separate event by mineflayer.
- **`@all` group address**. Trivial extension of the filter layer; wakes every bot at once.
- **Ambient overhearing**. Bots hear nearby public chat and may chime in unprompted. A cheap pre-filter (keyword / proximity / recency heuristic) gates whether to invoke Claude — most overheard chat won't pass. Reply in public chat.

### Response channel
Bots reply on the channel they were addressed on: public ↔ public, whisper ↔ whisper. Ambient responses go to public chat.

### Deferred to later
Right-click-to-talk dialogues, trade GUIs, sign/book interfaces. All require a server-side Paper plugin — much bigger lift than chat. Easy to add later if the chat interface proves limiting.

## Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Tool surface | In-process skill layer | Right abstraction for Claude; no IPC overhead |
| Event model | Event-driven (chat / skill done / heartbeat) | Avoid per-tick API costs and latency |
| Process model | One orchestrator, N bots in-process | Simple; can split later if scale demands |
| Prompt caching | System prompt + tool defs cached | Cuts cost on repeated turns |
| Server auth | Offline-mode + whitelist | No Mojang account per bot; whitelist gates impersonation |
| Interaction routing | Name-mention + `/msg` + `@all` + ambient (pre-filtered) | Covers explicit tasking and emergent behavior without per-tick costs |
| Skill scope (v1) | Full ~21-skill set across perception / movement / world / inventory / crafting / combat / chat / meta | Capable from day one |
| Skill params | Specific machine-friendly IDs | Predictable and testable; vagueness resolved in the model |
| Tool result shape | `{ ok, message, state? }` | Consistent format; specific failure messages let Claude adapt |
| Execution model | Sync / blocking; no progress streaming | Simpler v1 |
| Vagueness handling | Default / clarify / propose-and-confirm, taught via system prompt | Right tradeoff per request cost |
| Interruption | Queue chat during skills; player says "stop" to preempt | Avoids mid-skill races |

## Open questions

- Memory model: how much conversation history to keep verbatim vs. summarize, and where to persist it across restarts.
- Multi-NPC coordination: do NPCs share any world knowledge, or is each one fully independent?
- Safety / griefing limits: which actions need allowlists or owner confirmation (e.g. breaking player-placed blocks).
- Ambient pre-filter: concrete heuristics (which keywords, what proximity radius, what recency window).
- Heuristic tuning: conversation-continuity window (~30s), "stop" detection robustness.
