# Efficiency analysis: final v2 benchmark (run `v2-s5`)

62 runs (31 scenarios x2), 58 pass. Method: `task_start`/`task_end`/`skill`/`nav`/`step`/`recovery` events, `logs/*.log`, `results.jsonl`; compared with `v2-s3` and `v1-baseline`. Scripts in the session scratchpad. **Cost is negligible ($0.114 for all 62 runs). Subscription rate-limit headroom (events show 7-day utilization 0.73) and latency are the real currency.**

## 0. Measurement correction
`results.turns` / `task_end.turns` = tool_use blocks + 1, so it **overstates API calls** (parallel `achieve`+`say` counts as 2). Log `event complete after N turn(s)` is the real call count: **234 API calls over 102 events** (294 "turns" in results). Check: cacheRead 4.62M / 234 = **19.7k cached tokens per call** (not 13-16k). This matches v1 (~20k).

## 1. Where the calls go (234 calls, 102 LLM events)
| bucket | calls | share | deterministic-able? |
|---|---|---|---|
| final text-only call after the last tool (`thinking:` text nobody sees; 0.7 s p50, 75 s total) | 102 | 44% | yes, stop the session after a terminal `say` |
| `[job finished]` report events, success path, `say` only (21 events x 2 calls) | 42 (21 once #1 is done) | 18% | yes, templated line |
| post-action `say` after a blocking tool (`goTo`/`attack`/`deposit..`/`eat`) | 27 | 12% | partly: 8 duplicate a pre-ack (`say+goTo` then `say`) |
| conversation-only replies (inv question, stop, status, praise, build proposal) | ~20 | 9% | no (genuine judgment) |
| first-batch action + ack (`achieve+say`, `say+achieve`, `build+say`, ...) | ~43 | 18% | needed (this is the work) |
- `observeSurroundings` before acting: **0 calls** (v1: 12 of 164). Retries after tool failure: **1 failed LLM call in the whole run** (`mineBlocks` "sticks", `int.not_stop`; v2-s3: 3, v1: 34). Replans: 0 in 45 jobs. So retry/observe overhead is already ~0.
- Top scenarios (calls per run): `t3.portal` 8, `conv.followup_chest` 7, `int.stop` 7, `conv.chat_while_following` 6.5, `cr.build_house` 6. By group: t2 50, conv 45, t3 44, t1 42, int 22, cr 21, pl 10. Plain T1 tasks = 2 calls.
- `say` is 120 of 198 tool calls (61%). 5 job-finished events were cut by teardown (`backend_stopped`), so a live bot has ~5 more report events.
- **Deterministic savings:** ending after a terminal `say` (-102) plus templated success reports (-21 more) = 111 of 234 calls (**-47%**, about -2.2M of 4.6M cached-read tokens). Per-run mean 3.8 -> 2.0 calls.

## 2. Tokens
Measured prefix 19.7k tokens/call (+~1.6k `cacheCreate` per task for the context and new turns).
| component | chars | est. tokens |
|---|---|---|
| system prompt (rendered; file is 24.6k incl. dead hybrid/local prompts) | 14,398 | ~3.9k |
| 41 tool defs (desc 14,833 + zod->JSON schema 12,134 + names) | 27,361 | ~8k |
| context block (`contextChars` p50 812, p95 1,668, max 2,140, mean 973) | ~1k | ~0.3k |
| **unexplained (SDK/CLI side)** | | **~7-8k (~38%)** |
`sdk init` still logs `plugins=3 skills=3 slash=39 agents=5` on all 62 runs, so some of this is likely removable. `Query.getContextUsage()` (in `sdk.d.ts`) gives the exact split and has never been called.
Top-10 tools by size (chars, desc+schema): achieve 1860, build 1849, goTo 1303, mineBlock 1281, mineBlocks 1263, surviveNight 1132, craftMany 1057, smelt 1029, craft 914, placeBlocks 913 (these ten = 12.6k = 46%).
**Tool usage by the LLM:** s5 used 15 of 41 (say 120, achieve 32, goTo 14, build 9, followPlayer 4, craft 3, depositMany 3, others <=2). s3 adds mineBlock, craftMany, stop, getItems. Never called in s3 or s5: 22 tools. Never called in s3, s5 or v1: whisper, pillarUp, dropItem, equipLoadout, activateBlock, useOnEntity, useItem, fish, sleepIn, flee, withdrawFromChest, withdrawManyFromChest, remember, cancelJob.
- Redundant or superseded (drop or merge): observeSurroundings, checkInventory (context block carries inventory and nearby), setTaskQueue, advanceTaskQueue, pickUpNearby, mineBlock, craftMany, placeBlock, depositToChest, withdrawFromChest, giveItemTo, equipLoadout = 12 tools, 7.1k chars (~2k tokens, 10% of the prefix). Shortening the top-10 descriptions by ~35% saves about 2.5k chars (~0.7k). System prompt: the Creative section (839), setTaskQueue errand rule and Batch tools (333) could go or be injected only when relevant, ~0.4k. **Total about 3k tokens/call (-15%), or 0.7M tokens over this run.** Keep `stop`/`cancelJob`/`whisper` (safety, whisper channel) even though the bench never exercises them.

## 3. Latency
- First reply (n=105): **p50 2.28 s, p95 4.94 s, max 10.3 s** (s3 2.53/4.68, v1 2.75/15.8). Say-first tasks p50 2.0 / p95 2.65 s vs act-first (`goTo+say`, `achieve+say`) p50 3.0 / **p95 6.8 s** (56% of tasks): `say` waits for the sibling tool. Start -> first tool begins is 1.9 s p50 (model time at effort `medium`).
- Queue wait: p50 52 ms, p95 73 ms, max 1.9 s (s3: max 194 s; v1: 85 s). Context build p50 49 ms. Not a bottleneck anymore.
- Step durations (ms, p50/p95/max): gather 31,950/148,581/400,446 (n=38, 11 cancelled, 2 timeouts); build 20,911/56,133 (n=10); layer 2,275/7,733 (n=31); smelt 30,190/60,756 (n=3, 10 s per ingot); craft 782/5,749/10,730 (n=36); place_station 13; deliver 523.
- Slowest machinery: gather ~6.5 s per log (nav 1.5-3 s + bare-hand dig ~3 s + pickup nav 0.3 s), so 10 logs = 65-70 s; **world-view build p50 0.9 s, p95 1.9 s (n=51, 61 s total)**, which sits inside `achieve` (p50 1.04 s) and delays the ack; smelt is furnace-bound; 5 pathfinder think-timeouts (3x5 s, 2x10 s).
- Benchmark wall 4,462 s: `t3.survive_night` 1,050 (night is inherent), **`t2.coal` 960 (22%)**, `t3.portal` 385, `t3.iron_pickaxe` 380.

## 4. Failure and recovery cost
- Recovery rungs: 3 `retry` (coal x2 on timeout, portal-1 build_incomplete); **0 replan / widen / explore / relocate**; `guard_refusal` 0; deaths 0.
- Nav (699 events): arrived 628 (mean 0.93 s); stuck 37 (mean 17.1 s), timeout 11 (32.4 s), error 7 (11.9 s), no_path 10, cancelled 6. Non-arrived nav time = 1,135 s; **901 s (79%) is `t2.coal`** (stuck 25, timeout 11; drowning reflex, `dig FAILED` x3, `pit-avoid` loops, think-timeout 10 s). The gather step has only a total timeout (`4 min + 20 s/item` = 400 s), so the relocate/widen/explore ladder never fires before the run ends. Both reps fail at 480 s with 0 coal.
- `t3.portal-1`: 16 failed obsidian placements ("no solid neighbor"), 82 s to `missing_input`, then 3 more tasks (8 calls); `-2` passes. think-timeout hits: status_midtask-1/-2, not_stop-1, coal-1/-2.

## 5. Ranked recommendations
| # | change | saves | size | risk |
|---|---|---|---|---|
| 1 | End the session after a terminal `say` (batch holds only `say` and/or background launchers `achieve/build/followPlayer/surviveNight`; hook `continue:false` or `Query.close()` in the say wrapper). 0 counter-examples in 191 events (s3+s5). | -102 calls (-44%), -2.0M tokens, -0.7 s/task | S (~40 lines) | low-med: model wanting a follow-up tool after a lone `say`; fall back to normal flow when any tool is pending |
| 2 | Gather no-progress watchdog: after ~60-90 s with 0 items and N stuck/timeout/dig-fail, fail `unreachable` so the existing relocate/widen/explore ladder runs; avoid water-adjacent ore after a drowning reflex. | coal 2x480 s -> est. <=150 s each (-660 s, 15% of bench wall); likely turns 2 fails into passes | S-M | low-med: false stalls in deep mining; key on zero progress, not total time |
| 3 | Deterministic success report for `[job finished]` (pool of 5-6 casual lines naming item and count, e.g. "done, 10 jungle logs"). Route to LLM on failure, on a pending second part (`then`/`and put`), or a question in the thread. | -21 calls (-9%) after #1 (-42 alone); report arrives ~2.3 s sooner | M | med: player-likeness and lost follow-up offers; mitigate with phrase variety, keep LLM for the failures |
| 4 | Probe `getContextUsage()` once; strip the ~7-8k unexplained tokens (plugins/skills/slash/agents still loaded: try `plugins:[]`, disable slash commands, empty `agents`). | -3 to -7k tokens/call (-15 to -35%), uncertain until probed | XS probe + S fix | low (cache invalidates once) |
| 5 | Ack inside the action: optional `ack` field on `achieve/build/goTo/followPlayer/attack/surviveNight`, spoken first by the handler (or prompt rule "say before the tool", partial). | first-reply p95 4.9 -> ~2.7 s, act-first p50 3.0 -> 2.0 s; removes the 2nd-batch duplicate `say` (-8 calls) | S-M | low |
| 6 | Trim the tool surface (12 redundant tools, shorter top-10 descriptions) and the system prompt (Creative section only when creative, remove stale task-queue rule). | -3k tokens/call (-15%, ~0.7M/run) | S | med: a rare tool may be needed live; keep stop/cancelJob/whisper |
| 7 | Planner crafts a wooden/stone axe before gathers of >=6 logs (bare-hand log ~3 s vs 1.5 s wooden). Player-like. | -1.5 to -2 s/log: 10 logs 68 s -> ~50 s (10 scenarios) | M | low |
| 8 | World-view: incremental or cached scan (reuse the 5 s utility scan, shrink r=64 on repeat starts); also cap pathfinder think timeout on repeated identical targets (35 s lost to 5 hits). | -0.5 to -1 s per job start (-61 s/run view cost), faster ack | M | low-med: stale view |
Notes: the A/B for `effort: low` on T1/conv scenarios (start -> first tool 1.9 s) is a free test, but keep medium for build/portal. #1+#3+#6 together: calls -47%, prefix -15%, so tokens about -55% per run with no change in skills or the Haiku-only rule.
