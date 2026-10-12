# Live session review — first production session (2026-10-11)

Source: main checkout `.bot-runtime/bot.log` (394 lines, 28 tasks, creative mode) + `./scripts/botReport.sh --since today`. Isolation verified on the live bot: `sdk init: tools=41 foreign=0 mcp=[minecraft-skills]`.

## What went well
- Chat, follow-through on simple requests, "come to me", status questions, honest refusals ("I won't dig straight down"). Cost $0.003/task, cache hit 93%, p50 first reply 3.1 s.
- The Canadiens logo eventually got built (second attempt, on sand).

## Problems, ranked by how much they hurt the session

1. **Silent turns drop the player's un-named answers (8/28 tasks said nothing).** Messages routed as `continuation` (an answer to the bot's own question) ended with Haiku thinking and no `say`; the player had to repeat with "Steve" (logo, "sounds perfect", "go mine for it"). Cause: the silent-turn nudge (`claude-backend.ts` ~565) fires only for `active.direct` routes; continuation isn't direct. **Fix:** treat continuation (and follow-up from the current partner) as direct for the nudge; reword the continuation note to "they're answering your question — reply and act".
2. **Custom builds are LLM block-by-block (placeBlocks 27% success, p95 queue wait 113 s).** "Build a Canadiens logo, triple size" went through `getItems` + hand-written coordinate lists: inventory full (asked 1,280 wool), placements into occupied terrain, against nothing, through trees; it then chopped 30 trees and fought flowers ("You should be able to place blocks on grass"); "lost track of the exact design" across tasks; long blocking tool calls held chat 113 s. **Fix (owner direction 2026-10-11): pixel art uses an existing image→blocks conversion tool** (research: `v2/reports/pixel-art-research.md`) feeding the builder; a Haiku-drawn grid is only a fallback. The builder does layout, terrain (replace grass/flowers/snow; flat → on top of the surface; wall → foundation), creative just-in-time `getItems`, scaffolding, and runs as a job. Also: `placeBlock(s)` should replace replaceable plants; the agreed design is persisted (pending build spec in the context block) so "yes" / follow-ups don't lose it.
3. **Exploration requests turn into question loops.** "Mine until you find diamonds" → six exchanges of "want me to scan another direction or grab from creative?" before anything moved; then "no stone within 32 blocks" by water. Creative mode makes `achieve(diamond)` short-circuit to getItems. **Fix:** a `find` job (`find({block, action: "point"|"mine"|"report"})`): explore surface/underground (stair-mine, relocate away from water), report position or stand next to it; works in creative. Prompt: a clear directive given twice = act with a sensible default, never ask again.
4. **No creative flight.** "Can you fly with me?" → "no flight tool". v1 has creative flight handling (`flight.ts`). **Fix:** in creative, `followPlayer` flies when the player flies (`bot.creative.flyTo`), and `goTo` may fly to far/airborne targets.
5. **Duplicate completion message.** "Done, the CH logo is up…" then "The CH logo is finished…" (task result + extra follow-up). Minor chat spam; dedupe the job-end/`say` path.
6. **Nav traps around trees** (botReport: 13 nav failures at 3 tree clusters — `no_path` into leaves/logs at y+4). Gather/clear targets above reach should be skipped earlier, not retried.
7. **3 disconnects at startup** (EPIPE while the server finished booting) — harmless; `botStart.sh` could wait for the server's "Done" rather than port open.

## Proposed next slice ("live polish")
1, 2, 3, 4, 5 in that order — 1 and 5 are small; 2 and 3 reuse the job/builder machinery; 4 reuses `flight.ts`. Each gets a benchmark scenario (`conv.unnamed_answer`, `cr.pixel_art`, `cr.find_diamonds`, `cr.fly_follow`).
