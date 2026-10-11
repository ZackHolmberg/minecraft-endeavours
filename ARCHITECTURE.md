# Architecture

Design + as-shipped reference for the **AI NPC system**: Minecraft players backed by Claude Haiku that you can chat with and assign tasks. This describes **v2** (the goal-planner / background-job bot; tag `v1` is the previous per-step design). Companion docs: [JOBS.md](JOBS.md) (planner, jobs, builder, follow/night), [SKILLS.md](SKILLS.md) (tool reference), [ROADMAP.md](ROADMAP.md) (what's open), `v2/` (decision history, eval, reports).

## Goals

- NPCs join the Paper server as regular players (via [mineflayer](https://github.com/PrismarineJS/mineflayer)), one Claude agent per bot.
- Players talk to them in in-game chat; the bot carries out multi-step tasks (gather, craft, smelt, build, follow, survive the night) like a player would: no cheating, no griefing, fast replies.

## Layer stack

```
Orchestrator            spawns/supervises bots, routes chat (aliases, continuity), stop side-channel
  └─ NPC Agent          per-bot Claude Agent SDK; a FRESH Haiku session per task (context block from disk)
       ├─ Jobs          background execution of goals: achieve / build / followPlayer / surviveNight
       │    ├─ Planner  pure: (goals, WorldView) -> ordered steps over minecraft-data + hand tables
       │    └─ Build    pure: blueprint geometry, site choice, support/scaffold order, material math
       └─ Skills        41 tools = primitives + composites; reflexes run without the LLM
            └─ mineflayer + pathfinder (movement policy below)
                 └─ Paper server (docker compose)
```

**Haiku's role is judgment only:** interpret the request, pick a tool (usually `achieve` / `build`), talk to the player, and decide what to do when a job ends. Everything deterministic runs in TypeScript. Typical task: 2 tasks x ~2 turns (start job + one `say`, then the job-end note), ~5 turns for an iron pickaxe from nothing (v1: 20+, failing).

## Push work down the stack

**Core principle.** Anything deterministic is done in the orchestrator, job runner or skill layer, never through Claude: it's the most expensive and slowest part, and wasting it costs tokens, latency and reliability.

| Done by middleware | Saves Claude from |
|---|---|
| Planner: recipe graph, tool tiers, smelting/fuel, ore Y-bands, station placement (`achieve`) | Sequencing 10-20 craft/mine/smelt calls per goal |
| Job runner: postconditions, typed failures, recovery ladder, re-plans | Reading failure logs and improvising recovery |
| Blueprint builder: site, scaffolds, door-last, block count | Block-by-block building |
| Chat routing (aliases, `/msg`, `@all`, continuity windows, job requester), stop pre-empt | Reading every chat to decide "is this for me?" |
| Context block rebuilt from disk each task (state, inventory, containers, job, conversation) | Remembering anything across tasks |
| Reflexes: eat, armor, look at players, swing back, surface from water/suffocation, weapon-ready at night | Spending turns on survival |
| Structure guard, tree detection, door repair, filler reservations | Remembering not to grief |
| Failure messages carry adjacent options; did-you-mean on item IDs | Extra perception calls |

**Test for new features:** if it can be done in TypeScript with deterministic logic, do it there.

## Components

### Orchestrator
One Node process (`src/index.ts`): loads `config/bots.yml`, starts a supervisor + `NpcAgent` + `JobRunner` per bot connection, writes the snapshot for the dashboard, routes chat.

### NPC agent (`src/agent/`)
Per-bot Claude Agent SDK loop on **Claude Haiku 5.5** (`claude-haiku-5-5`), `session_mode: per_task` (default): every routed message gets a fresh `query()` closed when its result arrives (`persistent` = rollback). The single user message is a deterministic **context block** (`planning-context.ts` `buildAgentContext`): game mode, position/status/inventory/nearby, nearby containers (16 m), known storage/utilities/waypoints, last death, persisted recent actions, task queue, `# Current job`, and the last ~14 conversation lines from disk; then the chat line and a routing note. The system prompt says the block is ground truth. **Messages arriving mid-task are coalesced** into the next task.

- **Prompt cache:** the system prompt interpolates only the username and tool definitions are byte-stable, so the prefix caches across sessions (~99% hit).
- **SDK isolation** on every bot session (task and side reply): `strictMcpConfig: true` (only our skill MCP server; without it the SDK also loaded the logged-in account's claude.ai connectors with `bypassPermissions`, D16), plus `settingSources: []` and `skills: []` (otherwise the session inherits the operator's `~/.claude` hooks, plugins, CLAUDE.md and auto-memory; found in the promotion review, see `v2/reports/promotion-review.md` H1). The first `system/init` message of a session is logged as one `sdk init:` line to prove what loaded.
- **Guardrails:** 50-turn cap per task (`limits.ts`; then one "tell the player where things stand" follow-up); a **repeat-failure guard** in `skill-tools.ts` (3rd identical failing call refused unrun; after 6 failures a stop-and-report nudge); adaptive thinking with `effort: "medium"` (Haiku 5.5 rejects `budgetTokens`); refusal handling (no fallback model by policy: whisper "can't help with that").
- **Job-end re-entry:** when a job ends, `wire.ts` queues a synthetic `[job finished]` / `[job failed]` message (`NpcAgent.pushJobEvent`) that starts a fresh Haiku task. Cancelled/interrupted jobs queue none. Capped at **3 synthetic events per 10 min** (`JobEventLimiter`).
- **Side reply** (`ClaudeBackend.runSideReply`): a directly addressed *pure status question* (`isStatusQuestion` in `coalesce.ts`: a positive status shape such as "how's it going", "what are you doing", "are you almost done", "status", and no request cue like "instead", "also", "what about" or an action verb; a '?' alone is not enough; anything else is queued as a normal task) that arrives while a blocking tool is in flight is answered by a one-turn low-effort Haiku session with the same system prompt and byte-identical tool definitions (cache hit) where every tool except `say`/`whisper` is a refusing stub. It never touches cancellation, current-tool, the task queue or task telemetry. Falls back to the queue if nothing is said in 15 s. Rarely needed now: `achieve` ends the session in ~2 turns, so a status question lands on a fresh job-aware task.
- **Silent follow-up backstop:** a directly addressed task/job event that ends with no `say`/`whisper` gets ONE nudge (`queueSilentFollowUp`), because plain text is invisible to players.
- Retained per agent for the dashboard: `sessionUsage`, `lastTurnUsage`, `lastTurnError`, `latestRateLimitInfo`. SDK details: [spikes/SDK_NOTES.md](spikes/SDK_NOTES.md).

### Jobs (`src/jobs/`, `src/planner/`, `src/build/`): the primary execution model
Long goals don't fit a tool call (10-min watchdog, one Haiku turn per step). So `achieve`, `build`, `followPlayer` and `surviveNight` **start a persisted background job and return at once**; Haiku says one line and the session ends. Full reference: [JOBS.md](JOBS.md). In short:

- **One active job per bot** (`JobRunner`, `job.json` in the memory dir). A new job replaces the running one. Kinds: `achieve` (planner steps), `build` (blueprint; also the night shelter), `follow`.
- **Planner** (`planner/plan.ts`, pure): goals (items or tags like `#log`) -> ordered `gather|craft|smelt|withdraw|place_station` steps with raw-material totals; unresolved leaves are reported with `FailureKind`-style reasons and the job refuses to start.
- **Postconditions:** every step is verified against the world (inventory delta, placed block), not the skill's say-so. A skill reporting ok without an inventory change is a failure (this exposed the silent 3x3 craft rollback).
- **Recovery ladder** (`recovery.ts`, pure), chosen by `FailureKind`: unreachable gather (>=3 dead positions) -> relocate to dry land (<=2/job), else re-plan at once avoiding the unreachable block types; transient (`unreachable timeout internal hostile station_unavailable`) -> retry once; `no_source` -> widen the scan 64/96/160, then explore (surface spiral / underground stair + rake, <=2); `missing_*`/station -> re-plan from live inventory (<=5/job); otherwise fail with the failure and the remaining plan.
- **Loop guards:** `GoalFailureLedger` (same goal failing twice in 30 min makes `achieve` refuse until a player speaks again), `BuildFailureLedger` (same blueprint failing twice near the same place; also remembers partial structures so a retry resumes), the 3-per-10-min event cap, a 30-min job cap, `MAX_REPLANS`.
- **Reservations** (`state/reservations.ts`, `jobs/reserve.ts`): items the plan needs (step outputs, recipe ingredients, smelt input/fuel, goals) are reserved for the job so escape-pillaring and other filler use never spend them.
- **Stop & cancel:** the stop skill, chat pre-empt, death and the watchdog flip the per-bot cancellation flag; the runner subscribes and ends the job `cancelled`. `cancelJob` and any **non-exempt Haiku tool call** while a job runs also cancel it (`withJobAutoCancel` in `skill-tools.ts`); exempt: `say whisper observeSurroundings checkInventory remember setTaskQueue advanceTaskQueue achieve build surviveNight cancelJob`. So chat during a job is a fresh Haiku task that answers and leaves the job running.
- **Boot:** a leftover `running` job becomes `interrupted` (not auto-resumed); orphan scaffold blocks from a crashed build are reclaimed ~5 s after spawn.
- **Eval-visible:** `job_start`, `step`, `recovery`, `job_end` telemetry; the benchmark treats a running job as busy.

### Skills (`src/skills/`)
Plain `(bot, params) => Promise<SkillResult>` functions, exposed as MCP tools via `registry.ts` (the single source for Zod schemas and the descriptions Haiku sees). Primitives stay for one-offs and for the planner's step executors; composites hide find -> path -> equip -> act -> pickup. `runSkill` (`harness.ts`) wraps every call: traps exceptions, resets the stop flag, 10-min watchdog, actions log, current-tool tracking, continuity flag on `?` messages. Reference: [SKILLS.md](SKILLS.md).

### Movement policy (`pathfinder-config.ts`, `navigation.ts`, `doors.ts`, `structure-guard.ts`, ...)
mineflayer-pathfinder 2.4.5 (npm pin; master pin is open in ROADMAP). v1 *thought* it had a no-dig policy but never applied it; v2 applies one config to every skill:

- **Digging:** `canDig` on, but `blocksCantBreak` is the complement of an **allowlist of natural terrain** (`isNaturalTerrain` + foliage): never logs, planks, cobblestone, glass, doors, containers, stations, crops, beds. `digCost` 4 so walking and doors stay preferred. A player-built-structure guard (`builtStructureReason`: crafted blocks with crafted neighbours, doors/gates/glass) protects natural blocks set into walls. Explicit `bot.dig` in `mineBlock` is separate. `withDiggingMovements` is the cheap-dig scope for tunnelling toward a buried natural target.
- **Never places:** A* has no scaffolding (`scafoldingBlocks=[]`, no 1x1 towers, `dontMineUnderFallingBlock`, gravity blocks listed). Building/climbing is explicit (`placeBlocks`, `pillarUp`, the builder).
- **Liquids / drops:** `liquidCost` 8 (swimming costs more than digging), `maxDropDown` 3 (creative 8), `allowFreeMotion` off.
- **Doors** (`doors.ts`): pathfinder's own door support is broken, so door nodes are normalised (path post-processing lifts them to block-top; `normalizeDoorNodes`), wooden/copper doors and gates are walk-through on cardinal moves, the one ahead (next 3 nodes, <=2 blocks) is opened with polling for the state flip, and closed behind (>=2 blocks past, nobody near). Iron doors/trapdoors are walls.
- **Tree detection** (`structure-guard.ts` `isTreeLog`): a log is a tree if its connected cluster (<=200) has leaves within 2 blocks, no stripped log and no straight horizontal run of 3+. Log huts are safe.
- **Felling** (`tree-felling.ts`): candidate only if no log directly below and <=4 above the floor under it; ranked by distance + height penalty, sticky to the current tree; jungle giants yield their bottom logs, never the canopy. Perched drops: sweep r=8, then `freeStuckDrops`; an unreachable tree is abandoned and the batch moves on (<=6).
- **Surfacing reflex** (`auto-behaviors.ts` `survivalTick`, `surfacing.ts`): own-entity oxygen <= 8, or falling with no air close -> drop the goal, swim a BFS route to air, or dig <=3 natural blocks through a roof (never sand/gravel); head inside a solid cube -> dig out. `navigate` re-issues its goal afterwards (<=3). `fallsOnBot` refuses digging under falling blocks.
- **Pace:** window clicks are spaced 120 ms (`paced-clicks.ts`): mineflayer's back-to-back clicks make 1.21 servers roll back table crafts.
- `navigate()`: arrival check (`goal.isEnd`), stuck detection, 10 s think timeout for path decisions, escape-pillar fallback (`purpose: "escape"`), cancellation.

### mineflayer layer
Raw client + pathfinder, not exposed to Claude. `mineflayer-glue/` is the isolation point (bot factory, reconnect supervisor, event hooks: chat dispatch, stop side-channel, container capture, 5 s utility-block scan).

## Runtime & deployment

### Claude runtime & auth
Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` >= 0.3.293) authenticated via the **Pro subscription** Claude Code already holds on this Mac: no API key. Consequences: the 5-hour rate-limit window is shared by every bot **and the dev team** (the eval flags rate-limited scenarios as harness errors, not bot failures); auth is host-bound; on `rejected` the bot whispers "rate-limited, try in ~N min" and drops chats until reset. Swapping to the raw API would only touch the agent runtime layer.

### Model
**Claude Haiku (5.5, `claude-haiku-5-5`) via the plain `claude` backend. The standing owner decision: no local/hybrid backend, no other tiers.** Fix behaviour with prompts, tool descriptions, planners and middleware. When moving Haiku generations check the migration guide (thinking/sampling) and keep the SDK current. `model_hint` still accepts `sonnet`/`opus` and the `local`/`hybrid` backends remain in the tree but are dead code.

### Process model & scripts
Host process (Hybrid option: a compose service later, same code). Three lanes: **server** `start.sh`/`stop.sh` (docker compose), **bot** `botStart.sh` (the only entry point; refuses if the MC port is down or a bot is up; detaches `npm run start`, log -> `.bot-runtime/bot.log`) / `botStop.sh` (SIGTERM, graceful), **viewers** `botLogs.sh`/`dashboard.sh`/`botReport.sh` (read-only; never start anything). `.bot-runtime/` (gitignored): `bot.pid`, `bot.log`, `snapshot.json` (500 ms dump for the dashboard). Scripts read `MC_HOST`/`MC_PORT` from `.env`.

### Dev/test isolation
v2 development uses a separate worktree and an isolated test server (`docker-compose.test.yml`: project `mcv2test`, container `mc-v2-test`, loopback 25566/25576, own `./data`, whitelist off), selected by `COMPOSE_FILE` in the worktree's non-secret `.env` so the shared scripts can't touch the live server. Bot name there was `Steve_v2`. See [v2/TEST_SERVER.md](v2/TEST_SERVER.md). The eval scores only against this server.

## Configuration

`config/bots.yml` (versioned), one entry per bot:

```yaml
bots:
  - username: Steve_AI
    aliases: [steve]       # extra names players can use (2-16 chars [A-Za-z0-9_], unique across bots)
    model_hint: haiku
    backend: claude
    session_mode: per_task
```

`username` must be on the whitelist. `.env`: `MC_HOST`/`MC_PORT` (default localhost:25565), `PANEL_PORT`, `DUCKDNS_TOKEN` (the only real secret), `BOT_TELEMETRY_DIR` (override). `persona`/`owner` fields are deferred (ROADMAP).

## Skill catalogue

41 registered tools; per-skill reference (signature, params, success/failure messages, caveats) in [SKILLS.md](SKILLS.md). All return `{ ok, message, state? }`; failure messages are specific enough for Claude to adapt ("no oak_log within 64 blocks").

| Category | Tools |
|---|---|
| Jobs | `achieve` `build` `surviveNight` `cancelJob` (+ `followPlayer`, a job) |
| Perception | `observeSurroundings` `checkInventory` |
| Chat | `say` `whisper` |
| Movement | `goTo` `followPlayer` `stop` `pillarUp` |
| World | `mineBlock` `mineBlocks` `placeBlock` `placeBlocks` |
| Inventory | `pickUpNearby` `equipItem` `equipLoadout` `dropItem` `giveItemTo` `giveItemsTo` `getItems` (creative) |
| Interaction | `activateBlock` `useOnEntity` `useItem` |
| Crafting | `craft` `craftMany` `smelt` |
| Combat | `attack` `flee` |
| Storage | `depositToChest` `depositManyToChest` `withdrawFromChest` `withdrawManyFromChest` |
| Survival | `eat` `fish` `sleepIn` |
| Meta | `remember` `setTaskQueue` `advanceTaskQueue` |

Pending (low value): `findBlock`, `findEntity`, `lookAt`, `wait`.

**Principles:** specific machine-friendly params (concrete IDs; vagueness is resolved by the model, helped by the context block); structured results; composites accepted; batch siblings for multi-target skills (`mineBlocks`, `giveItemsTo`, `craftMany`, ...) stop at the first per-item failure and return `state.failedIndex`; long tick-loop skills are cancellable through the flag. Item names are normalised (`"diamond sword"` -> `diamond_sword`) with did-you-mean on a miss (`item-naming.ts`).

### `observeSurroundings()`
Primary "look around": position/dimension/facing/time/weather, status, held item, grouped `nearbyBlocks` (noteworthy allowlist, default radius 16, logs ranked by felling score with a `note`), `nearbyEntities`, dropped items, `knownStorage`/`knownUtilities` (from `world.json`), plus middleware state (`recentActions`, `recentlySeenPlayers`, `currentTask`, `remainingTasks`).

## NPC behavior

### Handling vague requests
Taught by the system prompt: **default and proceed** when cheap and reversible ("some wood" = ~16 of the nearest logs); **ask one question** when expensive or a matter of taste; **propose a concrete plan and wait for a yes** for big/permanent builds ("I'll put up a 5x5 oak house here, sound good?"; owner-approved, D13). Plain text is invisible to players: rule 1 of the prompt, backed by the silent-follow-up nudge.

### Interruption
Chat during a task is queued and coalesced into the next task, except: a **stop command** (`isStopCommand`, strict: "stop/cancel/nvm" leading a <=5-word message; "wait" only alone, so "wait, also grab coal" is not a stop) flips the cancellation flag immediately in `event-hooks.ts` (cancellable skills exit within a tick/block; the runner ends the job `cancelled`), then `npc-agent.ts` closes the Haiku session and the next task waits up to 35 s for the abandoned skill; and a status question may get a side reply. Every skill has a 10-min watchdog (jobs have per-step timeouts instead).

### Routing and conversation continuity (`orchestrator/chat-router.ts`)
A bot wakes on: its username or any **alias** (the `Steve_AI` -> "steve" suffix-stripped name plus configured `aliases`); `/msg`; `@all`; a **45 s question window** (the bot's last message to that player contained '?'); a **60 s follow-up window** after any bot reply to that player (the agent is told the bot wasn't named and may stay silent); and **job-requester** (while a job runs, the requesting player's un-named chat routes to the bot). A message naming another bot never falls through to continuation. Replies go on the channel addressed (public <-> public, whisper <-> whisper).

## Memory model

- **World knowledge** (`memory/world-knowledge.ts` -> `data/orchestrator/memory/<bot>/world.json`): `pois[]`, `containers[]` (chest contents with `last_opened`), `deaths[]` (newest 20, with cause). Captured by event hooks without any Claude call (container `windowOpen/Close` snapshot, 5 s utility-block proximity scan, death event); `remember` records named places. Writes are serialized per bot.
- **Conversation** (`conversation-log.ts` -> `conversation.json`): last 60 entries; the context block renders the last ~14 from the past hour. In `per_task` mode this is the only conversation memory.
- **Also on disk there:** `tasks.json`, `actions.json` (last 50), `job.json` (the current/last job, incl. exhausted areas and scaffold cells). Writes are temp-then-rename; a malformed file starts fresh. **Disk is the source of truth.**

World knowledge is exact and cheap (programmatic beats summarization for facts); conversation memory stays for intent and tone.

## Bot state (in memory)

Recent-actions log (5-min window; persisted history), player presence, task queue (persisted), current tool (name + args summary; observability only), the **cancellation flag** (cooperative; flipped by stop, chat pre-empt, death; reset at the start of every skill except `stop`), reservations (per job), and **reflexes** (`auto-behaviors.ts`; share one per-bot lock that `runSkill` waits on <=4 s): look at the nearest player when idle, auto-eat (food <= 14 or low health), wear better armor, swing back at hostiles that hurt the bot (even mid-dig; never players; not during `build`/`digIn`, which fight between actions themselves), `armTick` (night, idle, hostile within 6: best sword/axe), and `survivalTick` surfacing. The builder owns its hands (`melee-guard.ts` fights between actions; `build`/`digIn` are in the swing reflex's skip list).

## Resilience

| Failure | Policy |
|---|---|
| TCP loss | Exponential backoff 1 s -> 60 s, forever, per bot; the job runner ends the job `interrupted` (no `[job failed]`) and a fresh runner is attached |
| Bot dies | Auto-respawn; current skill dropped; death recorded; the job ends `failed(died)` / cancelled |
| SDK transient | SDK retries; escapes surface as tool failures or an apology |
| Rate limit | Whisper the wait, drop chats until reset, no retry loop |
| Skill throws | `runSkill` returns `{ok:false, message}`; never kills the bot |
| Step stalls | Per-step timeout -> cooperative stop (20 s grace) -> recovery ladder |

## Project layout

```
src/
  index.ts config.ts types.ts runtime-paths.ts snapshot-writer.ts
  mineflayer-glue/   bot-factory (supervisor, reconnect), event-hooks (chat, stop pre-empt, containers, POI scan)
  orchestrator/      chat-router (routing, aliases, stop detection, job-requester probe)
  agent/             npc-agent, backend/claude-backend (sessions, side reply), skill-tools (MCP wrap, repeat guard, job auto-cancel),
                     planning-context (context block), system-prompt, behavior, coalesce, limits
  jobs/              runner (state machine), recovery (pure ladder), wire (bot hookup), tools (achieve/build/surviveNight/followPlayer/cancelJob),
                     world-view, explore, exhausted, ledger, reserve, describe (job events/context),
                     follow + night + pocket (pure), steps/ (gather craft smelt withdraw place-station build deliver follow night classify)
  planner/           plan (pure), recipes (minecraft-data adapter), knowledge/ (smelting fuel tools ores wood stations tags), cli
  build/             blueprints, site, support, materials, prepare, types (all pure)
  skills/            registry (tool list + descriptions), harness, one module per category, pathfinder-config, navigation, doors, structure-guard,
                     tree-felling, surfacing, pillar, auto-behaviors, melee-guard, creative, flight, containers, item-naming, paced-clicks
  state/             actions-log player-presence task-queue current-tool cancellation reservations persist
  memory/            world-knowledge conversation-log
  observability/     telemetry(-types), aggregate, snapshot, log-buffer
  eval/              black-box benchmark (runner, scenarios/, tester, rcon, world, report, compare)
  report/ dashboard/ web/   botReport CLI, TUI, remote panel
  local-model/       unused (local/hybrid backends)
config/bots.yml  scripts/  spikes/  v2/ (decisions, eval, reports)
data/orchestrator/{memory,telemetry}/<bot>/   gitignored
```

`mineflayer-glue/` is the bot-client isolation point; `observability/`, `dashboard/`, `report/` are pure consumers. `npm test` = vitest (25 files, ~360 tests: planner, jobs with fake executors/in-memory worlds, build geometry, tree/structure/door logic); `npm run typecheck` covers the bot and the panel UI.

## Player <-> NPC interaction

Each NPC is a mineflayer client, so the server sees a real player. The server is **offline-mode with an enforced whitelist** (no Mojang account per bot; residual risk: a stranger who knows the address and a whitelisted name could impersonate that friend). Server-side Citizens-style NPCs were rejected: no mineflayer ecosystem, a Java plugin + IPC bridge, and fake-entity behaviour differences. Interaction modes: name/alias mention (primary), `/msg`, `@all`, continuity windows, job-requester routing (above). Ambient overhearing is deferred (token budget).

## Telemetry & the eval

Observe-only; never changes behaviour or throws into gameplay.

- **Contract** `observability/telemetry-types.ts`. Kinds: `task_start/task_end` (queue wait, context-build time, first-reply latency, turns, tokens, cache, cost, outcome), `guard_refusal`, `skill`, `nav`, `door`, `pillar` (`purpose: escape|requested`, D12), `structure_skip`, `reflex` (adds `surface`), `hurt` (with `cause`: mob, drowning, suffocation, lava, fall, ...), `death`, `chat_in/out`, `connection`, `loop_lag`, `rate_limit`, and **v2 job events** `job_start`, `step` (ops `gather craft smelt withdraw place_station` and build `clear layer scaffold light build`, `deliver`), `recovery` (rung), `job_end` (status, replans, failureKind, placed/total). Routed chat is `route=name-mention|follow-up|job-requester|...`.
- **Writer** `telemetry.ts`: buffered JSONL `data/orchestrator/telemetry/<bot>/events.jsonl` (flush 1 s/50 events, rotate 5 MB), 20k-event ring, every event has `runId`, in-task events a `taskId`. **Aggregation** `aggregate.ts` is pure (nearest-rank percentiles, normalised failure grouping). **Consumers:** `snapshot.json` (`telemetry`, `memory`), dashboard pages 2-4, `scripts/botReport.sh` (works with the bot down; flags in `report/flags.ts`: cache < 50%, p50 first reply > 5 s, tasks near the turn cap, context timeouts, skills < 60% success, watchdog hits, repeated stuck spots, disconnects/deaths/loop lag). Turns are counted by unique assistant `message.id` (the SDK streams one message per content block).
- **Eval is the measurement backbone** (`npm run eval`, `src/eval/`, [v2/EVAL.md](v2/EVAL.md), [v2/SCENARIOS.md](v2/SCENARIOS.md)): a black-box harness that drives any bot checkout like a player: a mineflayer **Tester** speaks in chat, **RCON** sets up/inspects the world, the bot's telemetry JSONL supplies turns/tokens/cost. Fresh bot process + wiped memory per scenario, pristine world per repeat, fixed seed and sites; protected player builds, pillar/death/chat-spam violations. 31 core scenarios (tier 1 single capability, tier 2 multi-step, tier 3 long-horizon, conversation/interruption/player-likeness/creative) + 3 stretch (`t4.iron_kit`, `t4.diamonds`, `t4.portal_scratch`). Every behaviour change is judged by benchmark before/after (single runs are noisy: use `--repeat`). Results: v1 45% -> v2 80% (milestone 1) -> 95% (`v2-s4`, 57/60, 0 protected blocks broken). Keep the `task_start/task_end/pillar/death/job_*` schema stable (D5).
- **Known gaps:** `local`/`hybrid` emit partial task events; `nav: no_path` conflates "no path" and "ended early"; `report/read-events.ts` duplicates the reader in `telemetry.ts` (keep in sync); `skill` events from job steps can land in an overlapping Haiku task's tool counters in the first seconds after `achieve`.

## Key design decisions

Full history and rationale: [v2/DECISIONS.md](v2/DECISIONS.md) (D1-D17).

| Decision | Choice | Why |
|---|---|---|
| Execution model | Goals run as persisted background jobs; Haiku re-enters on job end (D10) | One Haiku turn per step cost 20+ turns and broke on surprises |
| Planning | Pure deterministic planner over minecraft-data + hand tables, postconditions, typed failures, recovery ladder (D9/D10) | Verified steps; Haiku only at decision points |
| Generic goals | `#log #planks #wool #stone_tool_material #coal #sand`, resolved per plan; "chop N" is a job (D15) | Haiku needn't name species; chat stays free |
| Building | Parametric blueprints (house, portal, farm, shelter) executed as jobs, creative via `getItems` (D14); `deliverTo` hand-over | LLM block-by-block built 11.8k output tokens per house and failed in survival |
| Big builds | Keep propose-and-confirm (D13) | Owner-approved vagueness policy |
| Mid-task chat | Side reply for status questions; routing by alias / 60 s follow-up / job requester | Chats must not wait for a blocking tool |
| Sessions | Fresh Haiku session per task + disk context; `strictMcpConfig` (D16) | Cheap, restart-safe, no connector exposure |
| Model | Haiku 5.5 only | Owner decision; fix with prompts/middleware |
| Movement | Natural-terrain digging only, never place, doors repaired, trees detected | Player-likeness without griefing |
| Benchmark | Black-box eval vs a frozen checkout, fresh bot memory + pristine world per run (D5/D6/D11) | Comparable numbers across versions |
| Pillar violation | Pillaring not for escape (D12) | Escaping a pit is player-like; pillaring to travel isn't |
| Isolation | Separate worktree + test server; shared subscription window (D1/D2/D8) | The live panel runs from the main checkout |
| Server auth | Offline-mode + whitelist | No Mojang account per bot |
| Orchestrator process | Host process via `botStart.sh` (compose service later) | Fastest iteration |
| Dashboard coupling | Out-of-process via `snapshot.json` | Quitting it never disturbs the bot |
| Memory | World facts programmatic (JSON) + conversation log on disk | Exact, cheap, composable |
| Result shape | `{ ok, message, state? }`, specific failures | Claude can adapt |

## Open questions

- Multi-NPC coordination (per-bot `world.json` today) and owner-based griefing limits (`attack` accepts a player name; `getItems`/`deliverTo` can hand out creative items except the operator denylist): see ROADMAP.
- Heuristic tuning from live play: continuity windows (45 s / 60 s), stop detection, the 5-min action window, event cap (3/10 min), ledger limits (2/30 min).
- Everything else open is tracked in [ROADMAP.md](ROADMAP.md).


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
- **Access:** router TCP 443 → Mac 443. The Rogers gateway only forwards same-port, so `PANEL_PORT=443` is set in `.env` (read by the panel even under launchd; default 8443). macOS lets unprivileged processes bind <1024. Only HTTPS is served, with no HTTP listener.
- **TLS:** a Let's Encrypt certificate via ACME DNS-01 through the DuckDNS TXT API, using `DUCKDNS_TOKEN`. It is checked every 12h and renewed under 30 days, with a hot swap. The panel also updates the DuckDNS A record itself, because `stop.sh` stops the duckdns container.
- **Auth:**
  - A single admin with a scrypt password and **mandatory TOTP**. TOTP codes can't be replayed.
  - Sessions are server-side, with 256-bit IDs, rotated on login. The cookie is `__Host-`, HttpOnly, Secure, SameSite=Strict. Idle timeout is 12h, with a 7-day absolute cap.
  - CSRF: a per-session `X-CSRF-Token` plus Origin and Host allowlists, which also block DNS rebinding.
  - Login lockout: per IP, exponential, from 1 min up to 24h. Plus a **global slowdown**, not a lockout: while ≥20 failures (any IP) sit in a 15-min window, IPs that have never logged in successfully share one attempt per 10s. IPs with a prior successful login (last 30 days, in memory) skip it, so a distributed attacker can't starve the owner. This replaced a hard global lockout (15 min → 6h) that let anyone lock the owner out.
- **Command safety:**
  - Actions are a fixed allowlist of 9 (server/bot start/stop/restart, save, backup, `world.new`), mapped to fixed script argv and spawned without a shell. Only one job per group runs at a time.
  - **`world.new`** is the only action that takes input: an optional seed, plus `confirm: "NEW WORLD"`.
    - **Validation:** the seed must match `/^-?[A-Za-z0-9_ ]{1,32}$/`. It reaches the server only as `LEVEL_SEED` in the `start.sh` child env, always set (`""` for random) so it overrides `.env`. `.env` is never written.
    - **Steps:** backup → stop bot (restarted afterwards if it was running) → stop server → refuse if the MC port still answers → move `data/world*` to `backups/worlds/<ts>/` → move `data/orchestrator/memory/*` to `data/orchestrator/memory-archive/<ts>/` → start the server → wait until reachable.
    - **Safety:**
      - Moves, never deletes. The cross-device fallback copies and verifies before removing.
      - Archive dirs are created non-recursively, so it never merges into an existing one.
      - It stops at the first failure.
      - **No automatic pruning**, so the panel can never destroy a world. An earlier version kept only the newest 3 archives; the security review showed that let a stolen session erase the original world by running `world.new` repeatedly. Old archives in `backups/worlds/` are deleted by hand on the host.
      - It is exclusive across all groups, limited to 3 attempts per hour panel-wide (refused attempts are refunded), and audited with the seed.
    - **Interruption:** a panel restart mid-job leaves things stopped but intact.
  - **Game modes:** `GET /api/players` includes per-player `gameModes` (RCON `data get entity <name> playerGameType`, cached 15s). `POST /api/players/gamemode` runs `gamemode <mode> <name>`. The Bot page toggles the bot's own mode.
  - `PANEL_REPO_ROOT` / `PANEL_MC_PORT` are honored only in `--dev` (for tests against a fake tree).
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

## Creative mode

The bot plays creative as well as survival. Mode is read live from `bot.game.gameMode`, through `src/skills/game-mode.ts`, every time; it is never cached. The owner switches it from the panel (Bot or Players page → Survival/Creative). On a `game` event the bot stops flying and logs the mode change to the actions log.

- **Context:** the first line of every task's context block is `game mode: survival`, or `game mode: CREATIVE — take materials with getItems (never gather, craft or smelt); mined blocks drop nothing; no hunger, can't be hurt`. The system prompt has a short static "# Creative mode" section, and the mode itself comes only from the context block.
- **Skills:** the new `getItems` skill, plus creative branches in mining, placing, crafting, giving, `goTo` and `pillarUp`, with gated reflexes. See SKILLS.md under `getItems`.
- **Decisions:**
  - `craft` gives the item in creative instead of failing, which saves Haiku a round-trip.
  - `smelt` refuses, because there's no input→output table to look up.
  - Flight is used only where reliable (body-clear straight lines). Pathfinder walking stays the default.
- **Unverified live:** whether Paper accepts the unacknowledged creative slot writes (phantom items if not), and how Paper's movement checks treat our flight.
