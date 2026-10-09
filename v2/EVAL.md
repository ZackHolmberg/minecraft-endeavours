# v2 eval harness

Black-box benchmark for the Minecraft bot. It scores any bot checkout (frozen v1, v2 worktree, a branch) by playing a human: a mineflayer **Tester** sends chat, **RCON** sets up/inspects the world, the bot's **telemetry JSONL** supplies turns/tokens/cost. Contract: `src/eval/types.ts`. Code: `src/eval/`.

## Run it

```bash
# test server must be up (worktree: ./scripts/start.sh; see v2/TEST_SERVER.md)
npm run eval -- --bot-dir <checkout> --label <name> [--only "t1.*,t2.door_house"] [--repeat N] [--out dir] [--no-reset] [--timeout-scale 0.1]
npm run eval:compare -- v2/runs/<A> v2/runs/<B>     # markdown deltas to stdout
npm run typecheck
```
- `--bot-dir`: checkout with `src/index.ts`, `config/bots.yml` (bot username = first entry), `.env` (MC_HOST/MC_PORT/MC_VERSION; must point at the test port). The live checkout is refused.
- Frozen v1: `/Users/zackholmberg/dev/minecraft-endeavours-v1base` (its `node_modules` is a **symlink** to the v2 worktree's; run `npm install` only in the v2 worktree).
- Output (default `v2/runs/<label>-<YYYYMMDD-HHMM>/`, gitignored): `results.jsonl` (one `ScenarioResult` per line), `summary.md`, `logs/<scenario>-<rep>.log` (bot stdout), `telemetry/<scenario>-<rep>/<bot>/events.jsonl`, `meta.json`.
- Each scenario: **fresh bot process** (cwd = bot dir, `BOT_TELEMETRY_DIR` per scenario, memory `data/orchestrator/memory` + `.bot-runtime` wiped) → standard reset → `setup()` → `run()` under timeout while `check()` is polled every 5s → final `check()` → wait ≤60s for any in-flight `task_end` → metrics → SIGTERM bot (SIGKILL group after 10s).
- Real Claude Haiku calls happen (cost shown per scenario). A full tier-1 pass is a few cents to a few dollars.

## World & sites

Fixed seed (`LEVEL_SEED` in `.env`). `src/eval/sites.json` (committed) has standing coordinates (feet y) for `forest, plains, plains2, hills, cave, village, spawn`, all ≥150 blocks apart. Regenerate with `npx tsx src/eval/scout.ts [--only forest,plains2]` (needs the server up; visits sites with the Tester, which also pregenerates chunks), then re-snapshot.

World reset: `npx tsx src/eval/world.ts snapshot` copies `data/world*` to `v2/world-pristine/` (stops/starts ONLY `mc-v2-test` via `docker compose` in the worktree; player data is stripped). The runner calls `restorePristine()` at the start of every repeat (stop → replace dirs → start → wait for RCON). `--no-reset` skips it (faster; world may carry earlier scenarios' leftovers). Scenarios run sequentially in one repeat, so builds from an earlier scenario persist; sites are far apart to avoid interference.

## Standard reset (before each `setup()`)
Bot started and joined, then via RCON: gamemode (`scenario.gameMode`, default survival), `clear`, `effect clear`, heal + saturation, xp 0, `weather clear`, `time set 1000`, difficulty normal, kill non-player/non-villager/non-golem entities within 64 of the site, tp bot to `site + botStart` (y snapped to Tester-read surface), tp Tester 4 blocks east (creative). `setup()` then builds; protected boxes arm 2s after setup ends.

## Adding a scenario
1. Add an object in `src/eval/scenarios/tier*.ts` (or a new group file) and append it to `scenarios` in `scenarios/index.ts`. Keep it short:
```ts
export const giveBread: Scenario = {
  id: "t1.give_bread", tier: 1, category: "conversation", title: "...", timeoutMs: 120_000, site: "plains",
  async setup(ctx) { await ctx.rcon(`clear ${ctx.tester}`); await ctx.give(ctx.bot, "bread", 6); },
  async run(ctx) { await ctx.say("steve, can you give me 3 bread?"); await ctx.waitForDone(); },
  check: (ctx) => hasItems(ctx, ctx.tester, "bread", 3),   // helpers.ts: hasItems, containerHas, playerNear, buildHouse, box, inBox ...
};
```
2. `ctx.say()` rewrites the word "steve" to the bot's real username (the router only matches `Steve_v2`, not "steve").
3. Player builds: construct with `ctx.fill/setBlock`, then `ctx.protect(box, label)`. Any protected block that changes **block type** (door open/close is fine) after setup counts in `violations.brokenProtected` and forces `ok=false` (score capped at 0.5).
4. `check()` must be cheap and idempotent (polled every 5s). Return `score` for partial credit. `waitForDone()` returns early once a poll succeeds.
5. Set `pillarAllowed`, `maxBotChats` (default 8), `gameMode` when relevant. Scenario coordinates: `ctx.at(dx,dy,dz)` (site-relative), `ctx.surface(x,z)` (standing y).
6. Smoke it: `npm run eval -- --bot-dir <v1base> --label dbg --only "<id>" --no-reset --out v2/runs/dbg`.

## Metrics (`ScenarioResult`)
- `ok`/`score`/`detail`: success latched if **any** poll or the final check passed; score = best seen. `timedOut`: timeout hit without success. `harnessError`: infra failure, not the bot's fault (check `logs/`).
- `wallMs`: first `say()` → success detected (≤5s granularity) else end of run. `firstReplyMs`: first `say()` → first bot chat/whisper the Tester saw.
- `tasks, turns, toolCalls, toolFailures, *Tokens, costUsd, outcomes`: sums over `task_end` events in that scenario's telemetry file. `cacheHitRate = cacheRead / (input + cacheRead + cacheCreate)`. summary's "tok in" = input + cacheRead + cacheCreate.
- `violations`: `brokenProtected` (distinct protected positions changed), `pillarRuns` (`pillar` events, only if `!pillarAllowed`), `chatSpam` (bot chat lines beyond `maxBotChats`), `deaths` (`death` events).
- Summary: per-scenario table + per-tier (success rate, mean score, median wall, total turns/tokens/cost) + overall. `compare` groups by id across repeats.

## Caveats
- Paper throttles same-IP logins within 4s; the runner waits 5.5s after the Tester connects before starting the bot.
- The Tester walks over dropped items within 6 blocks (like a human) so hand-offs register; it otherwise stays put. It is creative so mobs ignore it.
- `blockAt/countBlocks` read the Tester's loaded chunks (view distance 6); if a chunk is unloaded the ctx hops the Tester there briefly. Keep scenario boxes within ~80 blocks of the site.
- Telemetry flushes ~1/s; wall times have ~5s poll granularity. A task still running when the 60s in-flight wait ends is missing from metrics.
- Bot-side state outside `data/orchestrator/memory` and `.bot-runtime` is not wiped. If v2 stores state elsewhere, extend `wipeBotState` in `bot-process.ts`.
- Costs/turns have run-to-run variance; use `--repeat 3` for decisions.
