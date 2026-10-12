# Live-polish A: conversation + call efficiency (2026-10-12)

Worktree `mcv2-dev` (v2 @ eb61503 + uncommitted changes). Gates: `tsc` (both projects), `vitest` (420 tests), the 4 `__checks__` stubs: all exit 0.

## Changes
1. **Silent turns:** `expectsReply()` (coalesce.ts): continuation, and follow-up from the current partner, count as direct for the nudge. Continuation note now "they're answering your question - reply with say and act". The nudge names the unanswered line and says not to repeat old news.
2. **Early end after a terminal say** (`backend/early-end.ts`, ~100 lines + tests). The SDK runs tools while later blocks still stream, so "no tool pending" is not a turn end; the tracker uses raw stream events (`includePartialMessages`): at `message_stop`, all tool results ok, only say/whisper + launchers (`achieve build followPlayer surviveNight cancelJob stop remember`), >=1 speech -> `query.interrupt()`. The interrupt still returns a `result` with usage, booked as `finished` / `ended_after_say`. Rollback: `BOT_NO_EARLY_END=1`.
3. **Prefix:** `getContextUsage()` (probe: `spikes/ctx-probe.ts`) shows no big SDK overhead. SDK baseline with no tools and a 1-token prompt is ~0.8k; built-in plugins/agents/slash lists are not in the prompt (`agents:{}` changed nothing). The "unexplained 7-8k" was the tool definitions, which are 13.3k, not the 8k estimated. Only removable SDK part: git-status/env block via a neutral `cwd` (`SDK_CWD`, also an isolation gain): -255 tokens.
4. **Tool surface:** 12 tools hidden (`HIDDEN_FROM_CLAUDE`, still registered for jobs/tests), top descriptions + schema `.describe`s + system prompt trimmed (Creative, Batch tools, task-queue rule removed). SKILLS.md / ARCHITECTURE.md / DECISIONS.md D22 updated.
5. **Duplicate completion:** the live double was a nudged fresh task restating "the logo is finished" after the bot had said it. Fixed by the nudge wording above plus a near-duplicate guard in `say` (>=8 words, 70% word overlap, numbers must match, 2 min) **active only for orchestrator tasks (nudge, `[job ...]` report)**. A first version applied everywhere and wrongly dropped a legit "sure, on it, 5x5 oak house..." confirmation (caught by the new scenario, rep 1 FAIL); now scoped.
6. **Prompt rule 7:** max one clarifying question per request; a repeated/confirmed directive is acted on with a default; exploring is a directive.

## Numbers (same 16 scenarios, 1 rep dev-polA vs 2 reps v2-s5, per scenario-set)
| | v2-s5 | dev-polA |
|---|---|---|
| per-call prefix (probe, tools+prompt+msgs) | 20.3k | **14.6k** (-28%): prompt 5.1k->4.4k, tools 13.3k->8.7k, messages 1.9k->1.5k |
| per-call cached prefix in live logs | 19.7k | 14.5k (cache_read 13.6k + ~0.9k create) |
| API calls (sum of `event complete after N turn(s)`) | 62.0 | **35.0** (-44%); calls per event 2.25 -> 1.30 |
| input+cache tokens | 1268k | **517k** (-59%) |
| output tokens | 7.1k | 5.3k |
| success | 31/32 (fail: chat_while_following rep 1) | 15/16 |
Only failure: `t3.iron_pickaxe` (job's craft-furnace walk "stuck" back to a crafting table in a pit; job nav code, not touched here; passed 2/2 in s5, likely noise).
Early end fired on every task that ended on a say (event lines "terminal say - ending the session"). First reply times unchanged (p50 ~2.5 s).

## New scenario `conv.unnamed_answer` (`src/eval/scenarios/polish-a.ts`)
Bot proposes a house and asks; Tester answers without the name; pass = bot replies within 25 s. Final code: 2/2 PASS. (Rep 1 of the earlier run failed on the over-broad dedupe, see 5; rep 2 hit the usage limit.) Runs: `v2/runs/dev-polA(.out)`, `dev-polA-unnamed*`. Because the v2 runner lacks the scenario, it ran via a scratchpad wrapper that appends `polishA` to the v2 runner's list; 3 runner invocations in total (the third a re-run of one scenario after the fix).

## Caveats
- Cost field of early-ended tasks comes from the interrupt's `result` (fine); `num_turns` is replaced by our unique-message count.
- Skipping the final text-only call assumes a say-only turn needs no follow-up; a say alone followed by tools in a later API turn would be cut (0 counter-examples in s3+s5 and this run; `conv.two_part` passes).
- Not done: templated job reports (deferred in D21), gather watchdog (jobs slice).
