# Roadmap

What is still open, with enough context to pick items up cold. State as of v2 `032b0e4` (benchmark `v2-s4`: 57/60 core, 95%; owner live test: "nearly flawless, lightning fast"). Architecture: [ARCHITECTURE.md](ARCHITECTURE.md); job/planner/builder reference: [JOBS.md](JOBS.md); decision history: [v2/DECISIONS.md](v2/DECISIONS.md); measurement: [v2/EVAL.md](v2/EVAL.md).

## Versioning

- **v0.1** Paper + DuckDNS. **v0.2-v0.5** single Haiku bot with per-step tool calls, dashboard, panel, creative mode (tag `v1`).
- **v2** goal planner + background jobs + blueprint builder + honest movement primitives + eval harness. Replaces v1 as the live bot at cutover (D17).

## Before cutover (delete this section once done; from `v2/STATUS.md` and D17)

1. Full core run on the final commit (`v2-s5`, incl. `conv.chat_while_following`); expect >= the `v2-s4` numbers and keep 0 protected blocks broken, 0 pillar-to-travel.
2. `v2-s4` small fixes: **build placement retry** when the server refuses one placement (`build_house` r1 ended 80/82; today only the next whole attempt retries); **remember seen chests beyond 16 blocks** (`conv.followup_chest` r2: the chest was outside the 16 m `nearby containers` scan after chopping).
3. Independent review of 2c-A, 2c-B, the quick shelter and the follow job: done (`v2/reports/promotion-review.md`); its findings:
   Findings of `v2/reports/promotion-review.md` (static review of `032b0e4`): fix or consciously defer H1 `settingSources`/`skills` isolation (fix present in the working tree, verify it landed), M1 side reply swallowed requests phrased as '?' (`isStatusQuestion` narrowed to positive status shapes in the working tree; verify it landed), M2 `job-requester` routing has no "not for you" routing note, no per-sender chat cap, and a bare 'stop'-like line from the requester cancels a follow/night job, M3 a pocket job cancelled/timed out while sealed leaves the bot entombed (needs a bounded `climbOut` and a boot check), M4 the hut fallback can dig ~90 dirt blocks from the requester's lawn, L1-L6 (pocket player-made detection, follow-up TTL loop with other bots, side-reply bookkeeping, `sdk-spike.ts` isolation, relocation ignoring POIs, `bots.yml` rename).
4. Security review of v2's `src/web/**` diff (verdict in the promotion review: PASS; one file, display-only). The panel is internet-facing.
5. Cutover per D17: merge `v2` into `main` in the main checkout without switching branches (+ `npm ci`); `config/bots.yml` -> `Steve_AI` with `aliases: [steve]` (keeps live identity, whitelist, memory dir); install `v2/CLAUDE.md.next` as `CLAUDE.md`; rebuild the panel UI and restart it via its launchd service (the one live-panel touch); world backup first; start the bot from `main`; push with owner OK. Rollback: revert commit + bot restart.

## Measured gaps (benchmark & stretch)

- **Core failures left** (`v2-s4`): `build_house` r1 (placement refusal), `conv.followup_chest` r2 (chest beyond 16 m), `t3.survive_night` r2 (death before the quick shelter existed; 2/2 live after). Single runs are noisy: use `--repeat` for any decision.
- **Stretch suite not yet run on v2:** `t4.iron_kit` (full iron kit; target >= 2/3 runs, < 20 min, <= 10 turns), `t4.diamonds` (target >= 50%; needs underground exploring without torches, lava/cave danger), `t4.portal_scratch` (obsidian from scratch needs a water/lava bucket flow and flint: the planner can make neither). Run at milestones: `npm run eval -- --suite stretch`.
- Tracked targets (`v2/STATUS.md`): core >= 80% (met), tier 2 >= 85% (100% at `v2-s4`), 0 deaths outside combat scenarios (1 pre-quick-shelter), iron pickaxe from empty < 5 min and <= 6 turns (met: ~130 s, 5 turns), p50 first reply <= 3 s (met: 2.2 s).

## Engineering backlog

- **Pathfinder master pin.** npm `mineflayer-pathfinder` 2.4.5 is from 2023; master (`d773d15` when checked) has Sep-Oct 2026 fixes (A* heap bug, corner cuts, water, door nodes, a `createHuman` controller) and a **semantics change** (`goto` rejects unreachable goals). Do it as its own benchmarked slice so it isn't confounded with behaviour changes; put `createHuman` open-ground walking behind a flag. `doors.ts` and `pathfinder-config.ts` patch 2.4.5 internals and may need rework.
- **Prompt / tool-surface trim.** The system prompt grew with each slice (job, build, side-reply, creative sections) and 41 tools are exposed. A full rewrite and a smaller surface (do `placeBlock`, `smelt`, `craft` and the interaction tools still earn their place now that jobs sequence the work?) is deferred. Measure turns, tokens and cache hit before/after; the prefix must stay byte-stable.
- **Planner coverage.** Mob drops (leather, string, beef, gunpowder), fishing, trading, farming loops/bonemeal, blast furnace/smoker/smithing/brewing/enchanting, dye/wool cycles, buckets, Nether/End routing, netherite: all "unresolved" today, so `achieve` refuses with a reason. A plan cache on disk, use of world-memory **sightings** (`WorldView.sightings` is unused) and a spatial world model would cut re-scan time (a view build costs 0.7-1.4 s).
- **Explore.** Torches/lighting underground, an ore-exposure filter, mob handling beyond reflexes, digging up, per-step progress in the context from live inventory.
- **Combat.** Only `attack`/`flee` and reflexes exist: no planned fights, no armor-up logic, no ranged. Needed for mob-drop gathering and safe cave work.
- **Night paths.** Live-verified: the `down` pocket (2/2, 0 deaths). Sim-only: the `hill` pocket, the hut fallback after `planPocket` returns null (incl. the whole hut hold phase: enter, close door/plug, torch, wait, leave), the bed path (`sleepIn`, re-sleep), stone-ground pockets without a pickaxe, the melee guard and `build`/`digIn` in the swing reflex's skip list, 58-block dirt digging via `acquire`. Risk: on plains mobs arrive ~2 min after dusk and a hut takes ~2.5 min; consider walls-before-roof or arrow cover for skeletons.
- **Builder.** Flat roof only, no interior light, plain glass windows, no farm fence/harvest/replant, sizes beyond the defaults untested live, site radius 20 / slope <= 1 / trees never cleared, portal scaffold recovery sim-tested only. Review leftovers: pit refill in `pickDigCell`, portal non-flammable radius.
- **Housekeeping.** `skill` telemetry from job steps lands in an overlapping Haiku task's counters; Haiku read-only tools reset the shared current-tool entry while a step runs (dashboard DOING can blank); registry-first imports still hit a circular-import edge (`Cannot access 'SKILL_SPECS'`); `world-view` `count` doc.
- **Harness.** The eval Tester walks to dropped items within 6 blocks, which made `conv.two_part` wander (consider `walkItems=false` for non-give scenarios); add a scripted scenario that fires `runSideReply` ("mine 20 stone", then "how's it going?") and one for a vanishing player (follow search legs are unit-tested only).
- **Dead code.** `local`/`hybrid` backends, `src/local-model/`, `scripts/llmStart.sh|llmStop.sh` and the hybrid prompts in `system-prompt.ts` are unused (Haiku-only policy). Remove when nobody wants them.
- **CI.** `npm test` (vitest, ~360 tests) and `npm run typecheck` exist; nothing runs them on push.

## Live-test gaps (never exercised in real play)

- Side reply (`runSideReply`) against a blocking tool; follow lost-sight search legs; `deliverTo` with large or odd items; `build` beyond default sizes; relocation on a real lake map beyond `t2.coal`.
- **Creative:** switch from the panel (context says `CREATIVE`); "build me a small house" (`getItems`, `placeBlocks`); phantom items if Paper rejects unacknowledged creative slot writes; kicks from flight; "come up here" from a roof; switching back to survival mid-hover. Add a `gamemode` telemetry event.
- **New world** (panel action): one supervised run with a known seed; confirm the seed applied, `backups/worlds/<ts>/` and `memory-archive/<ts>/` exist, the bot restarted with empty memory.
- **Reconnect of an active agent + job:** kill the MC container mid-turn and mid-job (`docker compose stop minecraft && start`); expect job `interrupted`, a fresh runner, no stray scaffolds.
- **Rate-limit cooldown** (`status: rejected` -> whisper and drop) has never fired live; read the log the first time the 5-hour window burns. The dev team shares that window (D8).
- After each play session run `./scripts/botReport.sh --since run`; its flags (cache hit, first-reply latency, turn cap, stuck spots, skill failure rates) answer most "how did it go" questions.

## Dashboard / telemetry polish

Narrow terminals clip the Perf/Skills tables below ~120 columns; tune the "silent tasks" (>30%) and cost-per-task ($0.05) flag thresholds after real sessions; per-bot log filtering; SDK subprocess stdout is not captured in the ring buffer; cost projection to the 5-hour window; no dashboard page for the current job (the panel's Events page renders job/step/recovery/surface events display-only).

## Pending catalogue skills

`findBlock`, `findEntity` (redundant with `observeSurroundings`), `lookAt` (cosmetic), `wait`. One tiny slice if ever needed.

## Larger deferred features

- **Personas / multi-bot differentiation:** a `persona` string in `bots.yml` interpolated into the system prompt (~30 LOC). Earns its keep at bot count > 1.
- **Multi-NPC coordination:** per-bot `world.json` today; light (talk via chat) -> medium (shared container view) -> heavy (task delegation, resource mutex).
- **Ambient overhearing:** every nearby chat is a potential Claude call; reconsider only off the Pro window or with a cheap pre-filter.
- **Owner-based safety / griefing limits:** `owner` in `bots.yml`; gate destructive skills (`attack` on a player, breaking non-owner blocks). Closer than it looks: `attack({entity: "<player>"})` works today, and `deliverTo`/`getItems` refuse only an operator-item denylist but will hand over any other creative item in one call.
- **Right-click / trade GUI / sign-and-book interactions:** needs a Paper plugin bridging events to the orchestrator.
- **Direct Anthropic API runtime:** swap `@anthropic-ai/claude-agent-sdk` for `@anthropic-ai/sdk` with explicit caching if Pro limits or off-host deployment demand it; skills, jobs and routing don't change.
- **Orchestrator as a compose service** (Dockerfile + service; `MC_HOST=minecraft`).
- **Background / autonomous goals** (idle chores, base upkeep) on top of the job runner; needs the plan cache and sightings above.

(Dropped: Opus escalation, which contradicts the Haiku-only decision; conversation persistence, which shipped as `conversation.json`.)

## Recommended order

1. Finish the pre-cutover list and cut over (D17).
2. First live session on `main`; run `botReport.sh`; fix what the live-test gaps turn up (side reply, reconnect, creative).
3. Stretch suite baseline (`t4.*`), then the pathfinder master pin as its own benchmarked slice.
4. Prompt/tool-surface trim (benchmarked), planner coverage for mob drops + combat, night-path live verification.
5. Everything under *Larger deferred features* stays parked until a use case earns it.
