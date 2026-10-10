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
