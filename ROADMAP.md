# Roadmap

Where the project is going. Items we've intentionally deferred from current work, with enough technical context to pick them up later without re-deriving the reasoning.

## Versioning

- **v0.1** — Plain Paper server in Docker with DuckDNS dynamic DNS. ✅ Shipped.
- **v0.2** — First AI NPC: one bot, chat-driven (name-mention / `/msg` / `@all`), partial skill catalogue (8 of 24 skills), offline-mode + whitelist. ✅ Shipped. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **v0.3** — In-terminal dashboard (4 phases) + the full slice-3 skill follow-ons. ✅ Shipped. The original four dashboard phases landed on `main` (`cc0b0d3 → 0d2e174`), and the priority / follow-on / tool-use / survival skill batches landed on top (`37583ae → f695c10`), bringing the catalogue from 8 to 28 registered skills and closing the iron-armor production loop end-to-end.
- **v0.3+** — Backlog below. No clear next version tag; items are sized so they can land independently.

---

## Backlog

### v0.5 live-test pass (Haiku + player-likeness)

**Run `./scripts/botReport.sh --since run` after each play session.** Its flags answer most of the items below: cache hit, first-reply latency, the turn cap, stuck spots, and skill failure rates. The telemetry and dashboard pages are shipped (see ARCHITECTURE.md *Telemetry & insight*).

The v0.5 pass (Haiku switch, per-task sessions, doors, pillar rewrite, structure guard, reflexes, crafting-count fix, disk persistence, `deaths[]` capture) is typecheck-clean but **not run in-game**. Highest-risk items to verify first:

- **Per-task session cost:** chat → first `say` latency (a CLI subprocess per task), and `cache_read` on the 2nd task ≈ system prompt + tools. If either is bad, set `session_mode: persistent`.
- **Stop:** "steve stop" mid-`placeBlocks`/`mineBlocks` halts, acks, and the next task runs normally ("wait, also…" must *not* stop).
- **Doors:** in/out of a closed-door house, double door, fence-gate pen; closes behind; iron door treated as wall; no open/close flapping in a 1-wide corridor.
- **Pillar:** `pillarUp(5)` on flat ground and in a 1×1 hole.
- **Structure guard:** `mineBlock oak_planks` next to a house refuses; trees still chop.
- **Crafting counts:** 1 log → 4 planks; 2 planks → 4 sticks; pickaxe with no table nearby places one.
- **Follow-ups from disk:** "steve get wood" → "now put it in the chest"; survives an orchestrator restart.
- **Reflexes:** faces you when idle, eats at food ≤14, wears dropped armor, swings back at a zombie.
- **Death:** `deaths[]` entry with cause; `lastDeath` in the context block.

### Field-untested code paths

Implementations exist; never run in live play. Each is a real risk surface.

- **Reconnect of an active agent session.** The supervisor's reconnect logic existed before slice 3, but slice 3 added the per-bot agent lifecycle (`registerAgent` replaces the existing one and `stop()`s it). Tearing down a live SDK session mid-conversation and rebuilding it on the new bot connection isn't field-tested. Plan: kill the MC container mid-turn (`docker compose stop minecraft && docker compose start minecraft`) and confirm a clean rebuild on the new bot connection. Only ten minutes of work, prevents a real outage class.
- **Rate-limit cooldown (`status: rejected` → whisper-and-drop).** Pro quota was healthy through all live testing — the rejected branch hasn't actually run. Will exercise itself naturally the first time the 5-hour window burns. No code action; just be ready to read the log when it happens.

The 30s continuation heuristic was field-tested via the `026836e` fix; if you've seen `continuity armed for <player>` followed by `ROUTE chat→<bot> reason=continuation`, it's done.

### Test scaffolding

No test suite exists today. ARCHITECTURE.md claims "skills are unit-testable independently of Claude" but no tests prove it. With 28 registered skills, the next refactor that touches `runSkill`, the harness, or any shared helper (item-naming, world-knowledge, pathfinder wrapping) could silently break several skills with no signal until live play surfaces the bug.

**Minimal start:** `vitest` + 6 smoke tests for the most-touched skills (`mineBlock`, `craft`, `smelt`, `depositToChest`, `equipItem`, `observeSurroundings`) using a mineflayer-bot stub. ~4 hours including the stub helper.

**Follow-up:** GitHub Actions CI running `npm run typecheck` + `npm test` on push. ~30 min once tests exist.

### Pending catalogue skills

From SKILLS.md status table. None gate real play; bundle as one cleanup slice if/when a player interaction surfaces the need.

- `findBlock` / `findEntity` — mostly redundant with `observeSurroundings.nearbyBlocks` / `nearbyEntities`. Marginal value; ~30 LOC each.
- `lookAt` — cosmetic. `goTo` and the activate skills both `lookAt` internally as needed. ~15 LOC.
- `wait` — literal `await sleep(seconds)`. Model can express "do nothing" by not calling tools. ~10 LOC.

### Dashboard polish (post-v0.3)

- **Narrow terminals** — below ~120 columns the Perf / Skills tables clip on the right (no scrolling).
- **Flag tuning** — the "silent tasks" (>30%) and cost-per-task ($0.05) thresholds in `src/report/flags.ts` are guesses for Haiku; tune after the first real sessions.
- **Telemetry coverage for local/hybrid** — `LocalBackend` emits no task events; hybrid executor skills have `taskId: null`. Low priority while the bot is Haiku-only.
- **Per-bot log filtering** — log pane shows orchestrator-wide; no `[username]`-prefix filter on the active tab.
- **SDK subprocess stdout capture** — Claude Code subprocess's own stdout bypasses the ring buffer; only `console.*` from this process is captured. Pipe subprocess streams into the ring buffer if a bug ever hides there.
- **Cost projections** — `total_cost_usd` is shown per-turn and per-session; no projection to the 5-hour-window likely spend.
- **Pro window precision** — `rate_limit_info.utilization` may only populate at `allowed_warning`. Dashboard falls back to `status + resetsAt countdown` until `utilization` shows up. Verify in live use.

### Larger deferred features

Bigger swings, each with a technical sketch. None of these are small slices.

#### Personas / multi-bot differentiation

**Why deferred:** v0.2 / v0.3 ship with a single bot. Username alone is sufficient identity for one bot; persona is overkill. Earns its keep when bot count > 1.

**Approach:** Add `persona` (one-sentence character description) to `config/bots.yml`. Injected into the per-bot system prompt to bias voice and default preferences (*"friendly and chatty, loves mining"* vs. *"terse, prefers building"*). Doesn't change capability — only tone and how vague requests get defaulted. Trivial: a string field in config, one interpolation point in the system-prompt builder. ~30 LOC.

#### Ambient overhearing

**Why deferred:** Highest-cost interaction mode (every nearby chat is a potential Claude call). Cut from v0.2 to fit Pro subscription rate limits.

**Reconsider when:** (a) we move to direct Anthropic API + pay-per-token, or (b) measured Pro usage is consistently well under the 5-hour window cap with room to spare.

**Approach:** Bots subscribe to nearby public chat within a configurable proximity radius. A cheap pre-filter — keyword / proximity / recency heuristic, possibly run through Haiku 4.5 — gates whether to invoke the main loop. Most overheard chat won't pass.

#### Owner-based safety / griefing limits

**Why deferred:** Friends server + whitelist already encodes trust. Per-bot ownership adds complexity without clear benefit at current scope.

**Reconsider when:** opening the server to wider play, or when bots gain meaningfully destructive capabilities (breaking player-placed blocks, attacking players — `attack({ entity: "<player_name>" })` already works today, so this is closer than it looks).

**Approach:** Add `owner` (Minecraft username) to `config/bots.yml`. Some skills become owner-gated — e.g., breaking blocks placed by non-owners requires confirmation, or `attack` on a player is owner-only. Sits in the orchestrator as a permission check around skill dispatch, before the call reaches mineflayer.

#### Right-click / trade GUI / sign-and-book interactions

**Why deferred:** Requires a server-side Paper plugin (Java, build cycle, server restart). Chat + `useOnEntity` cover the v0.3 surface.

**Approach:** Paper plugin that exposes events for right-click-on-entity, trade attempts, and book / sign reads, then bridges them to the orchestrator over a local socket or HTTP. Bots gain new interaction *modes* without changes to the skill layer — the orchestrator just routes new event types to the same NPC agents.

#### Multi-NPC coordination

**Why deferred:** Each NPC has its own `world.json`. Two Steves in the same base would re-learn the chest contents independently. Not relevant until bot count > 1.

**Approach:** Range of options:
- **Light:** Bots can `say` to each other via public chat (already supported — Steve hears Brick's chat as ambient if ambient lands).
- **Medium:** Shared world-knowledge store keyed by location (e.g., one merged `containers[]` view across all bots at the same base).
- **Heavy:** Joint task delegation, mutex on shared resources, explicit handoff protocol.

Pick a level based on friction observed once a second bot is added.

#### Direct Anthropic API runtime (instead of Agent SDK + Pro)

**Why deferred:** Pro subscription via Agent SDK covers current scope. Architecture is explicitly designed to make this swap cheap.

**Reconsider when:** (a) ambient overhearing or multi-bot use regularly hits Pro rate limits, (b) we need finer per-call control over model selection / caching than the Agent SDK exposes, or (c) we want to deploy off this Mac (Agent SDK auth is host-bound to where Claude Code is installed).

**Approach:** Swap the agent runtime layer in the orchestrator from `@anthropic-ai/claude-agent-sdk` to `@anthropic-ai/sdk`. Skill layer, behavior rules, interaction modes, server setup — all unchanged. New billing: `ANTHROPIC_API_KEY` in `.env`. Implement explicit prompt caching on system + tool defs.

#### Conversation memory persistence across restarts

**Why deferred:** The two-tier memory model already persists world knowledge by design (`world.json` per bot). Conversation memory — dialog history, recent intent, in-flight clarification — is held in-process by the Agent SDK and lost on restart. Acceptable; addressable later.

**Approach:** Persist per-bot conversation state to disk alongside `world.json` under `data/orchestrator/memory/<bot-username>/`. Likely JSON for short-term history and Haiku-summarized long-term notes. Orchestrator loads on bot spawn, flushes on graceful shutdown plus periodic checkpoints. Implementation depends on whatever the Agent SDK exposes for serializing / restoring conversation state — pin down when starting.

#### Heavy-reasoning escalation (Opus 4.7 on demand)

**Why deferred:** Sonnet 4.6 + Haiku 4.5 cover current needs. Opus 4.7 is held in reserve.

**Approach:** Two paths:
- **Claude self-escalates** via a `requestHeavyReasoning(why)` skill that switches the model for the next turn. Cleanest, but requires the SDK to support per-call model switching cleanly.
- **Orchestrator heuristic escalation** — detect complexity (large `mineBlock` counts, multi-step build plans, repeated skill failures) and route to Opus automatically.

Probably implement the first; fall back to the second if Claude doesn't self-escalate well.

---

### Recommended order

In rough priority for picking the next slice:

1. **v0.5 live-test pass** (above) — everything shipped in the Haiku/player-likeness pass is unverified in-game.
2. **Reconnect live test** — no code; just kill MC mid-turn and confirm.
3. **Minimal test scaffolding (vitest + 6 smoke tests + CI)** — pays off the moment the next refactor lands.
4. **Pending catalogue skills (`findBlock` / `findEntity` / `lookAt` / `wait`)** as one tiny slice — closes the v0.2 catalogue to 100%.

Everything else stays parked until a specific use case earns it.
