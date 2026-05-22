# Roadmap

Where the project is going. Items we've intentionally deferred from current work, with enough technical context to pick them up later without re-deriving the reasoning.

## Versioning

- **v0.1** — Plain Paper server in Docker with DuckDNS dynamic DNS. ✅ Shipped.
- **v0.2** — First AI NPC: one bot, chat-driven (name-mention / `/msg` / `@all`), full skill catalogue, offline-mode + whitelist. 🚧 In progress — design phase. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **v0.3+** — Backlog below. Version tags are tentative; assigned only where there's a clear next step.

---

## Backlog

### Slice-3 smoke-test follow-ups

**Why deferred:** Surfaced by the first live end-to-end run of the agent loop. None block shipping slice 3; each is small enough to stand on its own.

**`mineBlock` doesn't always pick up dropped items** (confirmed bug). Field-tested with sand: bot finishes the composite with items still on the ground. The 500ms post-dig wait relies on natural auto-collect which isn't reliable across block types. Fix: either sweep for dropped items in a small radius after each dig, or land `pickUpNearby` (below) and call it from `mineBlock`. Pulling in `mineflayer-collectblock` is the alternative. See [SKILLS.md → mineBlock → Known limitations](SKILLS.md).

**Next skill batch (priority from smoke-test demand).** Four pending skills surfaced repeatedly in real play within minutes of going live:
- `pickUpNearby` — also resolves the `mineBlock` pickup issue without rewriting it.
- `dropItem` and `giveItemTo` — players naturally ask the bot to hand off what it just gathered.
- `followPlayer` — "follow me until I say stop" was an immediate request the bot had to decline.

These four together would cover the most-frequent gaps observed. Bundle as one slice rather than landing piecemeal.

**Field-untested code paths from slice 3.** Implementations exist; smoke testing didn't exercise them. Each needs a deliberate live test before being trusted.
- **Chat router's 30s conversation-continuity heuristic.** Routing logs confirmed it fires correctly in isolation, but it's never been triggered by a real bot question followed by an addressee-less reply. Live test plan: post-phase-5 cutover, ask the bot something vague enough to provoke a clarifying question (`?`-terminated), then reply without using its name; expect `reason=continuation` in the dispatch.
- **Rate-limit cooldown.** `SDKRateLimitEvent` with `status: "rejected"` triggers the whisper-and-drop path. Pro quota was healthy during smoke testing — the rejected branch hasn't actually run. Will exercise itself the first time we burn a 5-hour window.
- **Reconnect of an active agent session.** The supervisor's reconnect logic existed before slice 3, but slice 3 added the per-bot agent lifecycle (`registerAgent` replaces the existing one and `stop()`s it). Tearing down a live SDK session mid-conversation and rebuilding it on the new bot connection isn't field-tested. Force a disconnect (kill the MC server briefly) during an active turn to verify the agent rebuilds cleanly.

### Personas / multi-bot differentiation — v0.3

**Why deferred:** v0.2 ships with a single bot. Username alone is sufficient identity for one bot; persona is overkill. Earns its keep when bot count > 1.

**Approach:** Add `persona` (one-sentence character description) to `config/bots.yml`. Injected into the per-bot system prompt to bias voice and default preferences (*"friendly and chatty, loves mining"* vs. *"terse, prefers building"*). Doesn't change capability — only tone and how vague requests get defaulted. Trivial to add: a string field in config, one interpolation point in the system-prompt builder.

### Ambient overhearing

**Why deferred:** Highest-cost interaction mode (every nearby chat is a potential Claude call). Cut from v0.2 to fit Pro subscription rate limits.

**Reconsider when:** (a) we move to direct Anthropic API + pay-per-token, or (b) measured Pro usage is consistently well under the 5-hour window cap with room to spare.

**Approach:** Bots subscribe to nearby public chat within a configurable proximity radius. A cheap pre-filter — keyword/proximity/recency heuristic, possibly run through Haiku 4.5 — gates whether to invoke the main loop. Most overheard chat won't pass. Open questions on filter heuristics (which keywords, what radius, what recency window) noted in ARCHITECTURE.md.

### Owner-based safety / griefing limits

**Why deferred:** Friends server + whitelist already encodes trust. Per-bot ownership adds complexity without clear v0.2 benefit.

**Reconsider when:** opening the server to wider play, or when bots gain meaningfully destructive capabilities (breaking player-placed blocks, attacking players).

**Approach:** Add `owner` (Minecraft username) to `config/bots.yml`. Some skills become owner-gated — e.g., breaking blocks placed by non-owners requires confirmation, or attacking players is owner-only. Other players can still task the bot for non-destructive actions. Sits in the orchestrator as a permission check around skill dispatch, before the call reaches mineflayer.

### Right-click / trade GUI / sign-and-book interactions

**Why deferred:** Requires a server-side Paper plugin (Java, build cycle, server restart). Chat is sufficient for v0.2.

**Approach:** Paper plugin that exposes events for right-click-on-entity, trade attempts, and book/sign reads, then bridges them to the orchestrator over a local socket or HTTP. Bots gain new interaction *modes* without changes to the skill layer — the orchestrator just routes new event types to the same NPC agents.

### Multi-NPC coordination

**Why deferred:** v0.2 treats each NPC as fully independent — no shared world knowledge, no cross-bot conversation. Coordination opens significant complexity (shared state, conflict resolution, who-owns-which-task).

**Approach:** Range of options:
- **Light:** Bots can `say` to each other via public chat (already supported — Steve hears Brick's chat as ambient if ambient lands).
- **Medium:** Shared world-knowledge store keyed by location (e.g., "the base is at X,Y,Z; the storage chest contains…").
- **Heavy:** Joint task delegation, mutex on shared resources, explicit handoff protocol.

Pick a level based on friction observed in v0.2.

### Direct Anthropic API runtime (instead of Agent SDK + Pro)

**Why deferred:** Pro subscription via Agent SDK covers v0.2 scope. Architecture is explicitly designed to make this swap cheap.

**Reconsider when:** (a) ambient overhearing or multi-bot use regularly hits Pro rate limits, (b) we need finer per-call control over model selection / caching than the Agent SDK exposes, or (c) we want to deploy off this Mac (Agent SDK auth is host-bound to where Claude Code is installed).

**Approach:** Swap the agent runtime layer in the orchestrator from `@anthropic-ai/claude-agent-sdk` to `@anthropic-ai/sdk`. Skill layer, behavior rules, interaction modes, server setup — all unchanged. New billing: `ANTHROPIC_API_KEY` in `.env`. Implement explicit prompt caching on system + tool defs.

### Conversation memory persistence across restarts

**Why deferred:** v0.2's two-tier memory model already persists world knowledge by design (`world.json` per bot). Conversation memory — dialog history, recent intent, in-flight clarification — is held in-process by the Agent SDK and lost on restart. Acceptable for v0.2; addressable later.

**Approach:** Persist per-bot conversation state to disk alongside `world.json` under `data/orchestrator/memory/<bot-username>/`. Likely JSON for short-term history and Haiku-summarized long-term notes. Orchestrator loads on bot spawn, flushes on graceful shutdown plus periodic checkpoints. Implementation pulls on whatever the Agent SDK exposes for serializing/restoring conversation state — pin down when we get there.

### Heavy-reasoning escalation (Opus 4.7 on demand)

**Why deferred:** Sonnet 4.6 + Haiku 4.5 cover v0.2 needs. Opus 4.7 is held in reserve.

**Approach:** Two paths:
- **Claude self-escalates** via a `requestHeavyReasoning(why)` skill that switches the model for the next turn. Cleanest, but requires the SDK to support per-call model switching cleanly.
- **Orchestrator heuristic escalation** — detect complexity (large `mineBlock` counts, multi-step build plans, repeated skill failures) and route to Opus automatically.

Probably implement the first; fall back to the second if Claude doesn't self-escalate well.
