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
