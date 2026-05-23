# Roadmap

Where the project is going. Items we've intentionally deferred from current work, with enough technical context to pick them up later without re-deriving the reasoning.

## Versioning

- **v0.1** — Plain Paper server in Docker with DuckDNS dynamic DNS. ✅ Shipped.
- **v0.2** — First AI NPC: one bot, chat-driven (name-mention / `/msg` / `@all`), partial skill catalogue (8 of 24 skills), offline-mode + whitelist. ✅ Shipped. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **v0.3** — In-terminal dashboard for orchestrator + bot state (4 phases: blessed-contrib spike → orchestrator instrumentation → `getBotSnapshot` aggregator → single-bot layout → multi-bot tabs + sparkline + error highlighting). ✅ Shipped. Run via `./scripts/dashboard.sh` or `DASHBOARD=1 npm run start`.
- **v0.3+** — Backlog below. Next up: the pending skill batches (priority + follow-on) to fill out the rest of the v0.2 catalogue. Version tags are tentative; assigned only where there's a clear next step.

---

## Backlog

### Slice-3 smoke-test follow-ups

**Why deferred:** Surfaced by the first live end-to-end run of the agent loop. None block shipping slice 3; each is small enough to stand on its own.

**`mineBlock` doesn't always pick up dropped items** — ✅ fixed. Each iteration now calls `pickUpNearby({ maxDist: 4 })` after the dig so any items that natural auto-collect missed are swept up explicitly. See [SKILLS.md → mineBlock](SKILLS.md).

**Priority skill batch** — ✅ shipped (commit `37583ae`):
- `pickUpNearby` — snapshot-at-entry sweep; tolerates per-item path failures.
- `dropItem`, `giveItemTo` — drop / hand-off composites.
- `followPlayer` — sustained pathfinder `GoalFollow` with cooperative cancellation.
- `placeBlock` — derives face vector by probing six adjacent positions for a solid neighbor.
- `stop` skill — landed alongside the priority batch as a prerequisite for the cancellable looping skills. Flips a per-bot cancellation flag (`src/state/cancellation.ts`) and cancels active pathfinder goals. The corresponding **side-channel preempt** in `mineflayer-glue/event-hooks.ts` flips the flag when the current conversation partner sends "stop" / "halt" / "wait" while a cancellable skill is in flight — necessary because chat is queued during skills, so without the side-channel a player saying "stop" couldn't actually preempt `followPlayer`.

**Follow-on skill batch — production / combat / storage** — ✅ shipped (commit `473f8e3`):
- `craft` — table resolution falls back to nearest remembered crafting_table from `world.json` POIs when none is within 32 blocks live, which is what makes the multi-step production loop (mine → smelt → craft) work from deep in a cave. Shortfall messages name the missing ingredient and count.
- `attack` / `flee` — tick-loop combat pair. Both cancellable via the same side-channel that priority-batch `followPlayer` uses. `attack` equips the best available weapon (sword > axe, tiered netherite → wooden); `flee` re-paths every ~1.5s so chasers don't end up running alongside.
- Chest interaction — all three coupled pieces shipped:
  1. **Skills.** `depositToChest` / `withdrawFromChest` with auto-resolution to nearest known container (filtered by item-presence for withdraw) when `pos` is omitted.
  2. **Container auto-capture hook.** `windowOpen` / `windowClose` in `event-hooks.ts` snapshot contents into `world.json.containers[]`. Block correlation via a per-bot hint set by the chest skills (`noteContainerOpening`), with `blockAtCursor(6)` as a fallback for chests opened via `activateBlock` or any other path.
  3. **Storage-aware fetch heuristic.** New "Storage and utility blocks" section in `system-prompt.ts` teaches propose-and-confirm when a requested item is in known storage, plus the multi-step production loop pattern using `knownUtilities`.

**Bonus — utility-block POI auto-capture.** Surfaced as a natural extension of the chest work: a 5s periodic scan in `event-hooks.ts` walks `findBlocks` for crafting_table / furnace / blast_furnace / smoker / smithing_table / etc. within 8 blocks and upserts to `pois[]`. Surfaced through `observeSurroundings.knownUtilities` (proximity-sorted). `craft`'s third-tier fallback (`remembered` source) reads from this — closes the iron-armor loop: mine ore deep in a cave, walk back to a remembered furnace, smelt, walk to a remembered crafting table, craft.

**Field-untested code paths from slice 3.** Implementations exist; smoke testing didn't exercise them. Each needs a deliberate live test before being trusted.
- **Chat router's 30s conversation-continuity heuristic.** Routing logs confirmed it fires correctly in isolation, but it's never been triggered by a real bot question followed by an addressee-less reply. Live test plan: post-phase-5 cutover, ask the bot something vague enough to provoke a clarifying question (`?`-terminated), then reply without using its name; expect `reason=continuation` in the dispatch.
- **Rate-limit cooldown.** `SDKRateLimitEvent` with `status: "rejected"` triggers the whisper-and-drop path. Pro quota was healthy during smoke testing — the rejected branch hasn't actually run. Will exercise itself the first time we burn a 5-hour window.
- **Reconnect of an active agent session.** The supervisor's reconnect logic existed before slice 3, but slice 3 added the per-bot agent lifecycle (`registerAgent` replaces the existing one and `stop()`s it). Tearing down a live SDK session mid-conversation and rebuilding it on the new bot connection isn't field-tested. Force a disconnect (kill the MC server briefly) during an active turn to verify the agent rebuilds cleanly.

### In-terminal dashboard for orchestrator + bot state — ✅ shipped in v0.3

Four-phase build landed on `main`:
- **Phase 0** — `spikes/dashboard-spike.ts`. Confirmed `blessed-contrib` renders on this terminal before wiring real data.
- **Phase 1** — orchestrator instrumentation: `agent.sessionUsage` / `lastTurnUsage` / `lastTurnError` retained, `latestRateLimitInfo` payload kept verbatim, `BotState.currentTool` tracker, `BotSupervisor.state` + `connectedSince` + `bot` getters, ring-buffer logger (`src/observability/log-buffer.ts`) that monkey-patches `console.*` with optional forwarding and pub/sub subscribers.
- **Phase 2** — `getBotSnapshot(username)` plain-object aggregator at `src/observability/snapshot.ts`. Reusable for a future HTTP/WebSocket API.
- **Phase 3** — single-bot layout at `src/dashboard/index.ts`: status panel + token/Pro-window panel + recent-actions list + live log pane, polled at 500ms.
- **Phase 4** — multi-bot tabs (Tab / Shift-Tab), per-turn cache-hit `contrib.sparkline`, red `LAST ERR` banner from `agent.lastTurnError`.

Run with `./scripts/dashboard.sh` (brings up MC + orchestrator + dashboard) or `DASHBOARD=1 npm run start` if MC is already up.

**Still deferred (post-v0.3):**
- **IPC split** — dashboard and orchestrator share one Node process today; quitting the dashboard SIGINTs the orchestrator. Split via Unix socket / WebSocket when restarting the dashboard without dropping bots becomes useful.
- **Log filtering** — pane shows orchestrator-wide log; no per-bot filter when tabbed to one bot. Add `[username]`-prefix filter on the active tab.
- **SDK subprocess stdout capture** — the Agent SDK spawns Claude Code as a subprocess. Its own stdout/stderr currently bypasses the ring buffer; only `console.*` calls from this process are captured. Pipe the subprocess streams into the ring buffer if/when a real bug hides there.
- **Cost projections** — `lastTurnUsage.total_cost_usd` and `sessionUsage.total_cost_usd` shown; no projection to the 5-hour window's likely spend. Easy add when the data justifies it.
- **Pro window precision (verify in live use)** — `rate_limit_info.utilization` may only populate at `allowed_warning`. Confirmed in early testing that `status: "allowed"` events ship without it. Dashboard falls back to `status + resetsAt countdown` until `utilization` shows up.

---

The remainder of this section preserves the original design context for future debugging / extension. **Below this line is design history, not active work.**

---

**Goal:** A live TUI showing per-bot state (location, current activity, health, task queue, conversation partner), Pro 5-hour-window token usage, per-turn token breakdown, recent skill activity, and a live log pane — without losing the existing log stream that's invaluable when something blows up unexpectedly.

**What's already collectable (no new instrumentation):**

| Field | Source |
|---|---|
| Position / facing / dimension | `bot.entity.position`, `bot.entity.yaw`, `bot.game.dimension` |
| Health / food / saturation / xp | `bot.health`, `bot.food`, etc. |
| Time of day / weather | `bot.time`, `bot.isRaining`, `bot.thunderState` |
| Held item / inventory snapshot | `bot.heldItem`, `bot.inventory.items()` (aggregated in `observeSurroundings`) |
| Current task / remaining queue | `state.tasks` |
| Recent actions (5min) | `state.actions.recent()` |
| Online / recently-seen players | `bot.players` + `state.presence.recentlySeen()` |
| Last conversation partner | `chat-router.getCurrentConversationPartner(username)` |
| Rate-limit cooldown state | `agent.isRateLimited()` + `RateLimitCooldown.remainingMinutes()` |
| Per-turn token usage | `SDKResultSuccess.usage` (currently logged via `console.log`, not retained) |
| Pro window utilization + resetsAt | `SDKRateLimitEvent.rate_limit_info` |

**Small new instrumentation needed:**

- **`agent.currentTool`** — name of the in-flight skill. Set/clear via `runSkill` (2 lines).
- **`agent.sessionUsage`** — running cumulative totals updated on `result` messages.
- **Ring-buffer logger** — wrap `console.log` to push lines to a fixed-size buffer for the log pane while still writing to stdout/a log file.
- **`BotSupervisor.state`** — expose connected / reconnecting / stopped (trivial).
- **`getBotSnapshot(username)`** helper — single function returning a plain object with everything to render. Consumed by the dashboard and reusable for a future HTTP/WebSocket API.

**Library choice — `blessed-contrib` (recommended) vs `ink`:**

- **`blessed-contrib`** — dashboard-shaped from day one; gauges, sparklines, log panes, tables are one-liners. Mature, stable, ugly defaults. Right choice when the goal is "render state" not "interactive UI".
- **`ink`** (React for CLIs) — modern component model, JSX, hot reload. Better dev ergonomics; weaker out-of-the-box for charts. Reach for it if the dashboard later grows from monitor → control panel.
- **Roll-your-own ANSI** — viable for one-bot single-screen, but maintenance cost compounds fast. Reject.

**Rough layout:**

```
┌── Steve_AI ──────────────────────────┬── 5h Pro Window ──────────────┐
│ STATE   working                      │ ████████░░░░  67%              │
│ DOING   mineBlock(sand, 5)           │ resets 14:30 (in 1h 47m)       │
│ POS     -78.5, 67.0, 72.4 (south)    │                                │
│ HP/FOOD 20/20  ·  18/20              │ Last turn:                     │
│ TASK    gather 5 sand                │   in     124  out    287       │
│ QUEUE   2 remaining                  │   cache  95%   $0.003 (est.)   │
│ TALK    LordoftheBlock               │ Session total:                 │
│ NET     connected · uptime 14m       │   in    1.2k  out   3.8k       │
├──────────────────────────────────────┴────────────────────────────────┤
│ Recent actions                                                        │
│   12:34:01  mined 5 sand                                              │
│   12:33:42  arrived near LordoftheBlock at (-78,67,72)                │
│   12:33:30  observeSurroundings — 7 block groups                      │
├───────────────────────────────────────────────────────────────────────┤
│ Log                                                                   │
│   [Steve_AI] → mcp__minecraft-skills__observeSurroundings({})         │
│   [Steve_AI] thinking: "Looking around for sand near the player..."   │
│   [Steve_AI] turn complete (cache_read=23000, out=287)                │
└───────────────────────────────────────────────────────────────────────┘
```

For 2+ bots: tab-cycle with Tab / Shift-Tab, or render side-by-side if there are only 2–3.

**Risks worth knowing:**

1. **stdout capture.** The Agent SDK spawns the Claude Code CLI as a subprocess; mineflayer also emits warnings of its own. To keep the dashboard clean, route the orchestrator's logging through a logger that fans out to disk *and* the dashboard ring buffer. For an MVP it's acceptable to leave subprocess stderr as the catch-all in the log pane.

2. **Pro window precision is unclear.** `SDKRateLimitEvent.rate_limit_info` exposes `utilization` (0..1) and `surpassedThreshold` — the smoke test only saw `status: "allowed"` without a numeric utilization, suggesting these may only populate after a threshold is crossed. Verify by inspecting all rate-limit-info fields after several heavy turns. The dashboard may end up showing `status` (allowed / allowed_warning / rejected) + countdown to reset without a precise percentage until the window starts filling.

3. **Cross-terminal rendering.** `blessed` handles resize cleanly, but iTerm vs Windows Terminal vs tmux render Unicode bars and box-drawing slightly differently. Test on the actual dev terminal before adding too many decorative elements.

4. **Single-process lock-in.** The dashboard and orchestrator share one Node process by default. Restarting the dashboard restarts every bot. Fine for v0.2; split via Unix socket or WebSocket later if it becomes painful.

**Effort estimates:**
- **MVP** — one bot, polling every ~500ms, static layout, three panels (status / token / log). 3–5 hours.
- **+ Multi-bot, cache-hit sparkline, cost estimates** — another 3–4 hours.
- **+ Polished** — resize-aware layout, color theme, log filtering, IPC split for separate dashboard process. Another day.

**Suggested starting order:**

1. **Spike** — `dashboards/spike.ts` with one hardcoded `blessed-contrib` panel. ~30 min. Confirms the lib renders correctly on the dev terminal before wiring anything real.
2. **Add the small instrumentation** — `agent.currentTool`, `agent.sessionUsage`, ring-buffer logger, `BotSupervisor.state` expose. Single concrete commit.
3. **Write `getBotSnapshot(username)`** returning the full plain-object snapshot. Consumed by the dashboard; reusable for a future HTTP/WS API.
4. **Build the layout** against a single bot (status panel + token panel + recent-actions + log pane). Poll the snapshot at ~500ms.
5. **Polish** — multi-bot via tabs, cache-hit chart, error highlighting, then maybe IPC split.

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
