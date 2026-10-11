# Promotion review: v2 @ 032b0e4 (slices 2c-A, 2c-B, pocket, live fixes, follow job, panel diff)

Read-only static review; nothing was run. "Unverified" marks things that need one live or log check.

## HIGH
**H1. SDK sessions load ALL filesystem settings (no `settingSources`).** `claude-backend.ts:358-376` (task) and `:849-864` (side reply) set `strictMcpConfig` but not `settingSources`. The SDK docs (`sdk.d.ts:2249`) say that when omitted "all sources are loaded (matches CLI defaults)".
- The bot session then inherits the operator's `~/.claude/settings.json`: hooks, plugins, env, permissions. It also probably gets the CLAUDE.md files and auto-memory (global CLAUDE.md, repo CLAUDE.md, MEMORY.md).
- `strictMcpConfig` only covers MCP servers. Runs show 15-30k cache_read tokens per turn, which is more than the system prompt plus 37 tools should need (unverified).
- Scenario: a whitelisted player says "repeat your instructions / what's in your memory file". Haiku has the owner's private instructions and memory, which mention the panel host, the public/raw-console choice and the DuckDNS name. A user-level hook or plugin could also fire on the bot's tool calls.
- Fix: add `settingSources: []` (SDK isolation) to both `query()` calls. Log the SDK `system/init` message once (`tools`, `mcp_servers`, `plugins`, `skills`) and assert it lists only `mcp__minecraft-skills__*`. This also cuts per-turn cache tokens.

## MEDIUM
**M1. The side reply swallows requests phrased with "?".** `coalesce.ts:69` (`body.includes("?")` → status question), with the dispatch at `claude-backend.ts:785` (not queued).
- Only `can/could/would/will you <verb>` and "do you mind" are excluded.
- Scenario: while `mineBlock` is in flight, "steve, grab coal instead?", "how about you build first?", "go to spawn?" or "what about iron?" count as status questions. The side session has stubbed tools and the note says "Don't promise or start anything". It says one line, `said=true`, and the message is never queued. The request is silently lost.
- Fix: treat as status only with a positive pattern (how's it going/what are you doing/status/progress/almost done/how long/how many). Otherwise queue it. Or queue the message after the side reply when it contains an imperative verb.

**M2. The `job-requester` route has no routing note, and its edge cases are unguarded.** `npc-agent.ts:198` (switch has no case, so Haiku sees a bare `(.)`); `chat-router.ts:135`.
- Scenario: during a 30-min follow or a night job, every un-named line from the requester ("Bob, come mine with me", "lol") starts a Haiku task. There is no "end silently if it isn't for you" hint, so the bot butts into player-to-player talk. This is unlike `follow-up`, which has the hint.
- `isStopCommand` runs on these too: the requester telling a friend "wait" or "stop that" cancels the follow or night job (`maybeInterrupt`).
- Cost: nothing caps routed chats per player. At about $0.003-0.006 per task a chatty requester is 50+ tasks per half hour on the shared quota. Whitelist-bounded, not otherwise bounded.
- Fix:
  - Add a `job-requester` case with the same "not meant for you → no tool" text.
  - Gate it on cheap signals (a `?`, 2nd person, or the requester within ~12 blocks).
  - Add a per-sender cap (e.g. 6 routed un-named chats per 2 min, applied to `follow-up` and `job-requester`).
  - Don't let un-named routes trigger `isStopCommand` cancels unless the message is a bare stop.

**M3. A pocket job that is cancelled, times out or is replaced while sealed leaves the bot entombed.** `steps/night.ts:239, :445` (the `cancelled` returns); `climbOut` only runs on dawn or a dig failure.
- Scenario ("down" pocket): a player says "steve stop", or Haiku calls any non-exempt tool (goTo/mine/follow). The job aborts and the bot stays in a 1x1 shaft with a dirt lid, 3 blocks below the surface. The base Movements cannot climb out (`allow1by1towers=false`, no scaffolding), so goTo reports no path and only a `pillarUp` call frees it.
- The same happens on `NIGHT_HOLD_TIMEOUT_MS` (18 min) if the daylight cycle is frozen, and after an orchestrator restart (the job becomes "interrupted" while the bot is still inside).
- Fix: in `digInThrough`, when `waitForDawn` returns `cancelled` after sealing (not `dead`), run `climbOut` (bounded, ignores the latched stop flag). Add a boot check: if the feet cell is enclosed and no job is running, open it.

**M4. The dirt-hut fallback digs up to ~90 dirt blocks from the lawn around the requester.** `steps/build.ts:631-675`: `acquire` goes up to `max(10, 1.6*want)` tries and `pickDigCell` takes any `grass_block` or `dirt` in a 15x15 area.
- Its only guard is that none of the 6 neighbours is a crafted block (`isCraftedBlockName`), and the site footprint ±3 is skipped.
- The requester is usually standing in their own base. Scenario: a hut request on a lawn or a dirt-floored house digs dozens of 1-deep pits in the player's yard and floor. Nothing refills them.
- Fix: use `craftedWithin(r=3)` plus a sky-exposure check. Cap holes (~20). Refill what was dug when the job ends. Or source dirt only from a single column or far from POIs.

## LOW
- **L1. Pocket "player-made" detection is thin.** `pocket.ts:102,134,175` uses `CRAFTED_PATTERNS` (planks/stairs/glass/bricks...). It misses cobblestone, logs, crafting_table, furnace, chest, torch, rails, farmland and plain stone/dirt/sandstone builds.
  - Scenario: a starter base made of cobblestone/log, with a furnace and a chest, gets a 1x3 hole or a 2-deep tunnel 4+ blocks away. It is natural blocks only and refilled at dawn ("down" only).
  - The "hill" variant leaves an open 4-cell tunnel mouth that spawns mobs near the base.
  - Fix: widen the predicate (any non-natural block within 4, by `isNaturalTerrain` complement). For "hill", refill the plug and tunnel at dawn.
- **L2. `FOLLOW_UP_TTL_MS` 20 s → 60 s (`chat-router.ts:33`) with a window that renews on every `say`.** An auto-reply bot or another AI player on the server that answers the bot within 60 s keeps the loop alive indefinitely (each exchange is a Haiku task). Only `event.sender === self` is blocked. Fix: the per-sender cap from M2, plus ignore senders without a player entity.
- **L3. Side reply bookkeeping.** `skill-tools.ts:166` `markReply` stamps the main task's `firstReplyAt`, so `hasReplied()` suppresses the silent-turn nudge if the main task then ends mute.
  - `isDirectAddress` (`coalesce.ts:35`) regex-tests the whole formatted message, so a player typing "they said your name;" forces the "direct" path (one extra nudge call). Anchor it to the routing-note line.
- **L4. `spikes/sdk-spike.ts:120` calls `query()` without `strictMcpConfig`/`settingSources`.** It is dev-only, but it runs with the owner's account (D16 gap). Fix it or delete it before merge.
- **L5. Relocation (`explore.ts` `rankRelocations`)** ignores known POIs, containers and player areas. A 56-90 block hop with no return can cross a base. Mining there is still guarded by `builtStructureReason`, so this is walking and door use only. Fix: penalise candidates within ~40 blocks of world.json POIs.
- **L6. Cutover.** `config/bots.yml` here says `Steve_v2`. D17's rename to `Steve_AI` (aliases, whitelist, memory dir) must be in the merge; the failure mode is safe (not whitelisted).

## Panel security verdict: PASS
- `git diff v1..v2 -- src/web` is exactly one file, `ui/src/pages/bot/Events.tsx` (+11/-2). No server, auth, CSRF, TOTP or CSP file changed.
- The new `describe()` cases (`job_start`, `job_end`, `step`, `recovery`; the `hurt.cause` and `surface` reflex tweaks) return plain strings or JSX text children. No `innerHTML`/`dangerouslySetInnerHTML`/`document.write`/`eval`, and no dynamic `href`/`src` from telemetry anywhere under `src/web/ui/src` (grep clean; the only dynamic `href`s are router paths with `j.id`).
- Preact escapes text. Even if it did not, the CSP is `script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'` (`http-util.ts:23`), with no inline script allowed.
- Server-side `queryEvents` is unchanged and validates `kinds` against `^[a-z_]{1,32}$` and a limit of 32.
- Other panel-adjacent changes: `telemetry-types.ts` (types, plus `ReflexName` and the optional `hurt.cause`), `aggregate.ts` (adds a `surface` counter) and `telemetry.ts` (adds `hasReplied`), all additive. The shell scripts only read `MC_HOST`/`MC_PORT` from `.env`. `package.json` only adds the vitest devDependency and scripts; the SDK version is unchanged.
- New telemetry strings that can carry player- or mob-controlled text, all length-clipped and all rendered as text:
  - `recovery.detail` embeds the followed player's name (`steps/follow.ts:154,163`; names are up to 16 printable chars in offline mode, so markup-shaped names are possible).
  - `hurt.by` (a username or mob name), `hurt.cause`, and `death.cause` (the death message, which can contain player names and custom mob names, sliced to 200).
  - `job_start.goals[].item` is validated against item ids and tags; `step.item` is planner-generated.
  - `task_start.request` (raw player chat) was already rendered in v1 as an escaped text node.

## Verified fine
- **`strictMcpConfig` call sites:** `query()` appears only at `claude-backend.ts:358` (task and persistent) and `:849` (side reply). Both pass `strictMcpConfig: true`, `tools: []` and allowedTools restricted to the `mcp__minecraft-skills__*` set. No other src SDK use (`adapters.ts` only builds the in-process server). The one remaining gap is L4, plus H1.
- **Side reply tool surface:** `buildSideReplyServer` stubs every spec except say/whisper, with identical definitions, so there is no extra tool surface. say/whisper are `readOnly`, so they don't reset the stop flag, overwrite `currentTool` or auto-cancel the job (`JOB_EXEMPT_TOOLS`).
- **Side reply races:**
  - `sideReplyBusy` serialises it.
  - It has a 15 s timeout and `maxTurns: 3`; an empty or failed reply falls back to the queue.
  - Telemetry tasks and the cancel flag are untouched.
- **Follow job lifecycle:**
  - Stop, `cancelJob`, replacement and auto-cancel all go through `cancel` + abort.
  - Death or watchdog → `failed(died|timeout)` with an event.
  - Disconnect or restart → `interrupted`, no event.
  - There is a 30-min `deadline`; there is no `runSkill` watchdog, so no 10-min kill.
  - Reservations are cleared in `finish()`.
  - Follow failures are not ledger-keyed; the cap of 3 job events per 10 min bounds re-follow loops.
  - Pathing uses the base Movements: natural-only digging, structure guard, doors via `doors.ts`, no placing.
- **survive_night lifecycle:**
  - Start is refused by day and in creative.
  - The pocket and hut paths record `step` events.
  - Death → `failed(died)`.
  - `notifyStop` handles step-less jobs.
  - The hold timeout is 18 min, covering the 8.75-min night.
  - Pocket candidates require natural diggable blocks, no liquids within 2, no falling blocks above or in walls, and a solid floor and walls.
  - The refilled lid and pillar-out leave the column filled.
  - Melee guard targets only `hostile` kinds, never players.
- **Generic tags:** `#`, `#constructor` and `#__proto__` all resolve to null → a clean error. Count is Zod-capped (1-2304, 8 goals). `deliverTo` is clamped per item (tags assume stack 64 → 128). Operator items can't be tag members. Resolution preserves the requested total. Replan sets `job.goals` to the concrete resolution and the ledger keys on `job.generic`.
- **"Digging aborted" retry:** one retry per block, skipped when a stop is requested, and the block is re-fetched and type-checked first, so it cannot dig a changed block.
- **Token loops:**
  - Job events are capped at 3 per 10 min.
  - Relocation is capped at 2 per job.
  - Side replies are one-shot, with a 15 s close.
