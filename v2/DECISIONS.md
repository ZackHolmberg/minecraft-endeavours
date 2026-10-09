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
