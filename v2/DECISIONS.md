# v2 decisions

Short records: decision, why. Settled unless new evidence; add a superseding entry rather than editing history.

## D1 — Separate worktree, branch `v2` from tag `v1` (2026-10-09)
v2 lives in `~/dev/minecraft-endeavours-v2` on branch `v2`; `v1` tag = `main@b184e5e`. **Why:** the public web panel runs via launchd from the main checkout; switching branches there ships to the internet.

## D2 — Isolated test server via `COMPOSE_FILE` in the worktree `.env` (2026-10-09)
`docker-compose.test.yml` (project `mcv2test`, container `mc-v2-test`, loopback ports 25566/25576, own `./data`). The `.env` selects it, so the shared scripts work unchanged. **Why:** the main compose file hardcodes `container_name: minecraft-server`; the env-level switch makes accidental live hits impossible from the worktree. Details: [TEST_SERVER.md](TEST_SERVER.md).

## D3 — Bot username `Steve_v2`, same Haiku runtime (2026-10-09)
**Why:** never collides with live `Steve_AI`; brain stays `claude-haiku-5-5` via the Agent SDK (hard constraint).

## D4 — `CLAUDE.md` is gitignored (inherited from v1)
The worktree holds a local copy. v2 docs that must survive go in `v2/`.

## D5 — Black-box benchmark (2026-10-09)
The eval drives any bot checkout only via chat (Tester player), RCON and the telemetry JSONL; v1 is scored from the frozen `../minecraft-endeavours-v1base` worktree. **Why:** one harness, comparable numbers across versions. **Consequence:** v2 must keep the `task_start`/`task_end`/`pillar`/`death` telemetry schema (`src/observability/telemetry-types.ts`). Docs: [EVAL.md](EVAL.md), [SCENARIOS.md](SCENARIOS.md).

## D6 — Fresh bot memory + pristine world per run (2026-10-09)
Bot process restarted with wiped memory per scenario; world restored from `v2/world-pristine/` per repeat; scenario sites ≥200 blocks apart. **Why:** independence and reproducibility; v1's disk memory would otherwise leak between scenarios.

## D7 — Harness rewrites "steve" → bot username in `ctx.say()` (2026-10-09)
v1's router only aliases `_ai/_bot/_npc` suffixes, so "steve" doesn't route to `Steve_v2`. Rewriting keeps scenario text natural and equivalent to how live players address `Steve_AI`. v2 should support configurable aliases.

## D8 — Shared subscription: the bot and the dev team draw from one 5-hour window (2026-10-09)
The first baseline stalled when the dev agents exhausted the window (the bot's Haiku calls got `rate_limit rejected`). **Consequence:** the runner tags rate-limited scenarios `harnessError` (not bot failures) and `--wait-limit` sleeps through resets; keep ≤2 heavy agents running during benchmark runs.

## D9 — Slice order (2026-10-09, from baseline smoke + `reports/v1-internals.md` + `reports/research-sota.md`)
1. **Honest primitives:** apply the Movements config v1 thought it had (canDig=false, door patch, no 1×1 towers, liquidCost); gather counts inventory deltas, not digs; configurable aliases. Small; fixes player-likeness at the root.
2. **Goal planner:** deterministic `achieve(item, n)` over the minecraft-data recipe graph + hand tables (smelting, fuel, tool tiers, ore heights), with per-step postconditions, typed failures and a recovery ladder; Haiku only at decision points; system prompt + tool surface shrink.
3. **Pathfinder master pin** (`d773d15`), separately so the two changes aren't confounded; `createHuman` for open-ground walking behind a flag.
4. Breadth: blueprint builder, farming, night survival, combat; then spatial world model, plan cache, background goals.
Each slice: benchmark before/after, keep only measurable wins, independent review, commit.

## D10 — Goals run as background jobs; Haiku re-enters only on job end (2026-10-09)
`achieve({goals})` plans deterministically (pure planner over minecraft-data + hand tables), starts a persisted job, and returns at once; the job executes with per-step postconditions, typed failures and a recovery ladder; `job_end` queues a synthetic event for a fresh Haiku decision. **Why:** v1 spends one Haiku turn per step and a 20-min goal can't live inside one tool call (10-min watchdog, session cost). Mid-job chat gets the job status in the context block. Design: [PLANNER.md](PLANNER.md); contracts `src/planner/types.ts`, `src/jobs/types.ts`. Eval treats a running job as busy (new `job_*` telemetry).

## D11 — Benchmark a frozen checkout, never the live worktree (2026-10-09)
The eval launches the bot per scenario from `--bot-dir`; editing `src/` in that dir mid-run mixes code versions. Procedure: `git worktree add --detach ../mcv2-bench <sha>` + `ln -s ../minecraft-endeavours-v2/node_modules ../mcv2-bench/node_modules` + copy `.env`, then `--bot-dir ../mcv2-bench`. (The `v2-s2b` run predates this rule; no `src/` edits were made during it.)

## D12 — Pillar violation = pillaring not for escape (2026-10-09)
`pillar` telemetry gains optional `purpose: "escape" | "requested"`. Escaping a pit/water while mining or via `navigate` escape is player-like; a Haiku-requested `pillarUp` to reach somewhere is the "pillar to travel" violation unless the scenario allows it. Events without `purpose` (v1) all count — conservative for v1.

## D13 — Keep propose-and-confirm for big builds; harness answers like a player (2026-10-09)
v1's owner-approved vagueness policy (propose a plan for big/permanent/taste requests and wait for a yes) stays. In v2-s2b both house builds ended "sound good?" with nothing built. The Tester now replies "yes go ahead" only in scenarios where that policy applies (`confirm: true`); elsewhere a trailing question counts as giving up (autonomy matters). v1 is re-run on those 4 scenarios for a fair baseline.

## D14 — Building = parametric blueprints executed as jobs (2026-10-09)
`build({blueprint, params})` starts a job: blueprint → world-space block list (oriented to the player/bot) → materials via the planner (survival) or `getItems` (creative) → deterministic bottom-up placement with temporary scaffolding, then cleanup. Blueprints: house (size/material/door/windows/roof), nether portal, wheat farm, (later: shelter, walls, stairs). Haiku only picks blueprint + params. **Why:** v1 builds were LLM block-by-block (11.8k output tokens for one creative house) and failed in survival (portal needed support blocks; plans never executed). Same job/telemetry contract as D10. Also: `achieve` gains `deliverTo` (hand the items to a player at the end) — v1/v2 fetched torches and never handed them over.

## D15 — Bulk gathers are jobs; mid-task questions get a side reply (2026-10-10)
"Chop 10 logs" now goes through `achieve({item:"#log"})` (generic tags: `#log #planks #wool #stone_tool_material #coal #sand`, resolved per plan to the species owned / in view, `Plan.goals` always concrete, `Job.generic` keeps the tag goals for re-plans). The Haiku session ends in ~2 turns, so later chats get a fresh session with job progress. Remaining blocking tool calls (direct `mineBlock`): a directly addressed status question (`isStatusQuestion`) while a skill is in flight is answered by a one-turn side session (`ClaudeBackend.runSideReply`): same system prompt and byte-identical tool definitions (cache hit), every tool but say/whisper is a refusing stub, no cancellation/current-tool/task bookkeeping touched, not coalesced; falls back to the queue if it says nothing within 15 s. Gathering never gives up on a tree whose drops can't be collected: it abandons that tree and moves on (≤6), and the job gather step loops on partial progress.

## D16 — Bot sessions must not load the account's claude.ai connectors (2026-10-10, SECURITY)
The Agent SDK sessions loaded the logged-in account's claude.ai MCP connectors (Claude Docs etc.) alongside our skills; with `permissionMode: bypassPermissions`, Haiku could call them — it called a Docs `batch({})` once in a dev run. v2 sets `strictMcpConfig: true` on every bot session. **The live v1 bot on `main` (`claude-backend.ts`) lacks this** — a player could steer `Steve_AI` into the owner's connected accounts. Hotfix on `main` is the owner's call (flagged 2026-10-10).

## D17 — v2 replaces v1 as soon as its remaining work is done (owner, 2026-10-10)
Owner approved: security hotfix on `main` (`bd32483`, local; not pushed), pushing `v2` + tag `v1` (done), and **promoting v2 to live immediately once finished**. "Finished" = (1) full core run on the final commit meets targets; (2) the v2-s4 small fixes (build placement retry, remembered chests); (3) independent review of the unreviewed slices (2c-A, 2c-B, quick shelter, follow job) with fixes; (4) panel security review of v2's `src/web/**` changes; (5) docs updated for a cold-start Claude (ARCHITECTURE/SKILLS/ROADMAP/CLAUDE.md, v2 docs folded in).
**Cutover:** merge `v2` → `main` *in the main checkout without switching branches* (merge + `npm ci`); `config/bots.yml` → `Steve_AI` (aliases `[steve]`, keeps the live identity, whitelist and memory dir); rebuild the panel UI + restart the panel via its launchd service (the one live-panel touch, after the security review); start the live bot from `main`; push `main` with owner OK. Rollback: `git -C ~/dev/minecraft-endeavours reset --hard v1`-equivalent revert commit + bot restart; world backup first.

## D18 — Bot sessions load no filesystem settings (2026-10-10, SECURITY)
Installed SDK docs (`sdk.d.ts` `settingSources`): "When omitted, all sources are loaded (matches CLI defaults)" — so bot sessions loaded the owner's `~/.claude/settings.json` (hooks, plugins), CLAUDE.md files and likely skills; players could get them repeated, and it inflated the cached prefix. v2 sets `settingSources: []` on every `query()` — **not sufficient**: auto-memory still loaded (Haiku quoted the operator's `MEMORY.md` index verbatim). Final fix `src/agent/backend/sdk-isolation.ts` (`21d66c6`): `settingSources: []`, `skills: []`, `settings.autoMemoryEnabled: false`, env `CLAUDE_CODE_DISABLE_AUTO_MEMORY/CLAUDE_MDS/BUNDLED_SKILLS=1`, on every `query()`; `sdk init` log line shows what loaded. Live v1 on `main` has the same exposure; v1 bot is not running and cutover (D17) replaces it — don't start the v1 bot before cutover without this line.

## D19 — Cutover done: v2 is the live bot (2026-10-11)
Merged `v2` → `main` (`7448dac`, pushed) in the main checkout without switching branches; `npm ci`; bot identity `Steve_AI` (alias `steve`); new `CLAUDE.md` installed (gitignored); panel UI rebuilt + restarted via `panelStop.sh`/`panelStart.sh` (launchd, serving 200 on the DuckDNS hostname); live bot started from `main`. No world backup (owner: new world coming). `Steve_v2` removed from the whitelist; `../mcv2-live` retired. Rollback: revert the merge on `main` (the `v1` tag is `b184e5e`) + `botStop.sh`/`botStart.sh`.
**Workflow from here:** develop in the `v2` worktree / side worktrees against the test server (never in the live checkout); benchmark frozen checkouts; deploy = merge into `main` in the main checkout (no branch switch) + bot restart, with owner OK.

## D20 — Pixel art: thin pipeline, Wikimedia + pasted URLs (owner, 2026-10-12)
No maintained, permissively licensed image→block converter exists (`reports/pixel-art-research.md`: mapartcraft/cartographer GPL-3.0 map-art; others toys/GUI/unlicensed). Build: `sharp` decode/resize → dominant-colour cap → CIELAB nearest match over one palette family (default concrete) → `pixelart` blueprint into the existing builder (job). Sources (owner): **Wikimedia Commons by name** (server-rendered PNG thumbs, descriptive User-Agent) and **pasted URLs** (https only, resolved-IP private-range block, manual redirects, byte/pixel caps, magic-byte sniff, timeouts; fetch+decode in a memory-limited child). No local-folder source. Block colours: averaged from 1.21.9 textures at dev time; **only the numbers are committed** (owner OK). Haiku-drawn grid only as a validated fallback.

## D21 — Efficiency priorities from v2-s5 telemetry (2026-10-12)
`reports/efficiency-analysis.md`: 44% of API calls are a final text-only call after a terminal `say`; ~7–8k of the ~19.7k-token prefix is unexplained SDK overhead; 12/41 tools redundant; gather's 400 s timeout pre-empts the recovery ladder (t2.coal). Do: end the session after a terminal say, measure/remove the prefix overhead (`getContextUsage()`), trim tools/descriptions, gather no-progress watchdog → recovery ladder. Deferred: templated job-success replies (player-likeness risk).

## D22 — Live-polish A: conversation + call efficiency (2026-10-12)
(1) Un-named answers (continuation, and follow-up from the current partner) now count as direct for the silent-turn nudge; the continuation note says "they're answering your question — reply and act". (2) Per-task sessions end after a terminal say via `interrupt()` once the API turn is complete (stream events, not "no tool pending": tools run while later blocks still stream). (3) `getContextUsage()` showed the "unexplained" prefix was not SDK overhead: the SDK adds only ~0.8k (plugins/agents/slash lists are not in the prompt; a neutral `cwd` removes ~250 of it); the real split was system prompt 5.1k + tool definitions **13.3k** (the efficiency report estimated 8k). (4) 12 redundant tools hidden from the model (`HIDDEN_FROM_CLAUDE`; still registered for jobs/tests), top descriptions and prompt trimmed: prefix 20.3k -> 14.6k tokens. (5) Duplicate completion lines: nudge carries the unanswered line + no-repeat rule, and `say` drops near-duplicate long lines within 2 min (orchestrator-generated tasks only). (6) Prompt rule 7: one clarifying question max; a repeated/confirmed directive is acted on.

## D23 — Polish review fixes (2026-10-12)
`reports/polish-review.md` "Fixes". Web text never reaches the model: the Wikimedia credit is a code-posted fixed template. Image decode is split: the guarded parent fetches, a `sandbox-exec`'d child (no network, reads limited to node + node_modules + `src/pixelart`) only decodes bytes from stdin; no `sandbox-exec` -> stripped-env child + warning. Early end needs a launcher or a non-ack say. `find mine` is natural-terrain/ore/tree-log only; lone containers and stations are protected by the structure guard.
