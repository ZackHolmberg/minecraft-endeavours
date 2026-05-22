# Claude Agent SDK — pinned answers for slice 3

Findings from `spikes/sdk-spike.ts` against `@anthropic-ai/claude-agent-sdk@0.3.148`. ARCHITECTURE.md flagged these as "pin down when we start coding"; this file is the source of truth for slice 3+. Re-run the spike if the SDK version changes.

## TL;DR

| Question | Answer |
|---|---|
| Tool definition shape | `tool(name, desc, zodSchema, handler)` → bundle via `createSdkMcpServer({ name, tools })` → pass in `options.mcpServers`. Names get auto-namespaced to `mcp__<server>__<tool>`. |
| Model selection | `options.model: "claude-sonnet-4-6"`. Mid-session swap via `Query.setModel()` (streaming-input mode only). Map our `model_hint` → full model ID at the orchestrator boundary. |
| Session state | One `query()` returns an `AsyncGenerator<SDKMessage>`. **Plan: streaming-input mode** — one long-lived `query({ prompt: asyncIterable, ... })` per bot, fed by an async queue of `SDKUserMessage`. Conversation lives in SDK process memory. No disk persistence — orchestrator restart = conversation reset, which is what we want (durable knowledge lives in world.json, not in chat history). |
| Caching | Automatic. System prompt + tool defs land in the prompt cache; `SDKResultSuccess.usage.cache_read_input_tokens` proves it. Spike showed ~2280 cached tokens read on every turn, with only 271 new tokens cached per cold turn. **No code changes needed for caching to work.** |
| Rate-limit signal | Two channels: (a) `SDKRateLimitEvent` messages in the stream — `type: "rate_limit_event"`, carries `rate_limit_info.status: "allowed" \| "allowed_warning" \| "rejected"` plus `resetsAt` (unix seconds) and `rateLimitType: "five_hour" \| …`. (b) `SDKAssistantMessage.error === "rate_limit"` when a turn is rejected mid-stream. Watch both. |

## Detail

### Tool definition

```ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const observeSurroundings = tool(
  "observeSurroundings",
  "Look at the bot's immediate surroundings…",
  { radius: z.number().int().min(1).max(64).optional() },
  async ({ radius = 16 }) => ({
    content: [{ type: "text" as const, text: JSON.stringify(state) }],
  }),
);

const skillsServer = createSdkMcpServer({
  name: "minecraft-skills",
  tools: [observeSurroundings, /* … */],
});

// Reference by namespaced name in `allowedTools`:
const OBSERVE = "mcp__minecraft-skills__observeSurroundings";
```

The handler must return `CallToolResult` from `@modelcontextprotocol/sdk` — i.e. `{ content: [{ type: "text", text: string }], isError?: boolean }`. We'll stringify our `SkillResult` into the text block; Claude reads it back as part of the tool result and continues reasoning.

Zod schemas accept both v3 (`zod`) and v4 (`zod/v4`) shape types. We use v4 (`zod@^4`).

### Wiring into `query()`

```ts
const stream = query({
  prompt,                                  // string OR AsyncIterable<SDKUserMessage>
  options: {
    model: "claude-sonnet-4-6",
    systemPrompt: SYSTEM_PROMPT,           // string | string[] | { preset: "claude_code", append? }
    mcpServers: { "minecraft-skills": skillsServer },
    tools: [],                             // disable Claude Code built-ins entirely
    allowedTools: [OBSERVE, …],            // namespaced MCP names
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    sessionId: BOT_SESSION_UUID,           // stable per-bot UUID for multi-turn
    maxTurns: 8,                           // safety cap per chat event
  },
});

for await (const message of stream) { /* … */ }
```

Critical: pass `tools: []` to strip Claude Code's built-in tool surface (Bash, Read, Edit, etc.). Without this the NPC could try to call them. Combined with `allowedTools` listing only our MCP skills, this gives us a clean, locked-down tool surface.

`permissionMode: "bypassPermissions"` + `allowedTools` = unattended execution of our skills. We could swap to `canUseTool` later if we ever need finer-grained gating (e.g. owner-confirm for destructive skills — see ROADMAP.md).

### Message stream you actually have to handle

`SDKMessage` is a giant discriminated union but only a few variants matter for the agent loop:

| `message.type` | What it is | What the agent does |
|---|---|---|
| `assistant` | A turn from the model. `message.message.content[]` has `text` and `tool_use` blocks. May carry `error: SDKAssistantMessageError`. | Stream `text` blocks back to the player as they arrive (or buffer until `result`). On `error === "rate_limit"`, flip into rate-limit cooldown. |
| `user` | The tool-result mirror that the SDK emits after every tool call. `content[]` has `tool_result` blocks. | Log for tracing. The handler already returned the data — this is just the SDK echoing it into the transcript. |
| `result` | Terminal message for a turn. Carries `usage` (tokens, cache), `total_cost_usd`, `is_error`, `stop_reason`. Subtype `success` or `error_during_execution` / `error_max_turns` / `error_max_budget_usd`. | Use as the "turn complete" signal. Surface errors. Log cache stats. |
| `rate_limit_event` | Pro-window state change. | Update bot's rate-limit state machine. See below. |
| `system` | Init / config-change boundaries. | Skip. |
| `partial` | Streaming chunks if `includePartialMessages: true`. | Not enabled in v0.2; skip. |

### Multi-turn session strategy: streaming-input mode

Each bot owns **one long-lived `query()` call** for its lifetime on the server. The call's `prompt` is an `AsyncIterable<SDKUserMessage>` backed by a per-bot async queue; the chat router pushes onto the queue, the agent loop iterates the returned `Query`. Conversation lives in SDK process memory. Nothing touches disk.

```ts
const queue = new SDKUserMessageQueue();
const session = query({
  prompt: queue,
  options: { model, systemPrompt, mcpServers, tools: [], allowedTools, ... },
});

// chat event arrives → queue.push({ type: "user", message: { role: "user", content: "…" }, ... })
// agent loop:
for await (const msg of session) { /* dispatch tool calls, route text to chat */ }
```

**Why this over fire-and-forget-with-sessionId-and-disk:**

- **Latency.** Each fire-and-forget `query()` spawns a fresh Claude Code subprocess, adding startup ms per chat event. Streaming-input keeps one subprocess hot.
- **"No persistence" is free.** Process dies → conversation gone, no `deleteSession()` cleanup loop needed.
- **Interruption available.** `Query.interrupt()` exists if v0.3+ ever needs mid-skill preempt.

**Tradeoffs accepted:**

- One unrecoverable SDK failure kills the conversation for that bot. Recovery = restart the Query, log the reset; same handling we already have for bot-disconnect.
- Long-lived async loop per bot is slightly more lifecycle code than per-event queries. ~20–30 lines.
- Transcript grows unboundedly within a session. If the SDK auto-compacts (it can emit `SDKCompactBoundaryMessage`) it's free; otherwise revisit when token counts start mattering.

**Lifecycle wiring (slice 4):**

- `bot-factory.onConnect` → create queue, start `query()`, kick off the for-await loop in the background.
- Chat router → `queue.push(userMessage)`.
- `bot.on("end")` (disconnect) → close queue. The `for await` drains naturally, the `Query` ends, the loop exits.
- Reconnect (supervisor builds a new Bot) → new queue, new `query()`. Conversation resets along with the bot. This is the intended behavior.

We pass `persistSession: false` defensively to make sure nothing accidentally lands on disk.

### Rate-limit handling

The spike's normal-state event:

```json
{
  "status": "allowed",
  "resetsAt": 1779442800,
  "rateLimitType": "five_hour",
  "overageStatus": "rejected",
  "overageDisabledReason": "org_level_disabled",
  "isUsingOverage": false
}
```

Agent layer logic (per ARCHITECTURE.md "Resilience" table):

- On `status === "rejected"`: whisper to last-addressed player `"I'm rate-limited, try again in ~N minutes"` (compute N from `resetsAt`), set a per-bot "muted-until" flag, drop subsequent chats until the flag clears.
- On `status === "allowed_warning"`: ignore for v0.2 (no preemptive throttling).
- On `SDKAssistantMessage.error === "rate_limit"`: same as `rejected` (the stream-level event might not have fired yet).

### Caching — what we observed

Spike's turn-1 usage (cold):

```
input_tokens: 1
cache_creation_input_tokens: 271
cache_read_input_tokens: 2282
output_tokens: 41
```

Turn-2 usage (warm):

```
input_tokens: 4
cache_creation_input_tokens: 2539      (← second turn re-cached after new content)
cache_read_input_tokens: 2281          (← system prompt + tool defs hit)
output_tokens: 98
```

Cache reads are happening on every turn — system prompt + tool defs survive. Cache is `ephemeral_1h_input_tokens`, so 1-hour TTL. Fine for our event-driven model: a bot in active conversation stays warm; an idle bot drops out of cache and re-warms on the next chat.

**No code action required for caching.** If we ever want to split static vs dynamic context for cross-session sharing, the SDK exports `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` for that — out of scope for v0.2.

### Auth

Works because Claude Code is installed and logged in on this machine. The SDK shells out to the local Claude Code binary; no `ANTHROPIC_API_KEY` needed. ARCHITECTURE.md's "auth is host-bound" note holds — moving the orchestrator to a remote box would require Claude Code installed and logged-in there too.

## Open notes for the agent layer

- `maxTurns` is a per-call cap on assistant↔tool ping-pong, not on conversation length. Set ~8 for safety against runaway loops.
- The model called `observeSurroundings({})` with no `radius` in the spike — fine since it's optional, but a hint that the system prompt should be explicit when a non-default radius is wanted.
- Spike turn 2: the canned data was identical to turn 1, but the model still said "things have changed". Real concern for slice 4: the system prompt must instruct the model to read observations literally, not narrate them.
- Spike emits an *empty `user` message-stream* entry for each tool result — these are not real user turns; ignore them when logging chat for players.
