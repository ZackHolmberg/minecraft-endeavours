# Slice 2c-A: conversation + autonomy (worktree mcv2-dev, branch v2-fixes, uncommitted)

Status: done. Offline green; live 5/5 on the final code (dev-2ca-b).

## Changes
1. **Nearby containers (conv.followup_chest).** New `src/skills/containers.ts` (`findNearbyContainers`, chest/trapped_chest/barrel/all shulker boxes, 16 m, double chest = one entry). `planning-context.ts` adds `nearby containers: chest @x y z (5m)` to every context block. `storage.ts` uses the same scan (coloured shulker boxes now count); deposit/withdraw without `pos` already preferred a chest in plain sight over a farther remembered one. Prompt: listed container => use it, don't ask where.
2. **Gathering keeps going.** Cause of "stopped at 8/10": `mineBlocks` quit after 3 consecutive digs that dropped nothing ("dropped nothing I could pick up"), not out-of-reach logs. Now: full inventory still stops; otherwise it sweeps 8 m (freeing perched drops), and if still nothing it abandons THAT tree and goes to the next (<=6 trees, `MAX_UNREACHABLE_SKIPS` 6 -> 12). Felling always ends with a litter sweep. Job `gatherStep` loops on partial progress instead of failing a step that gained items. R5 bottom-up rules untouched.
3. **Mid-task responsiveness.**
   - Generic goals: `#log #planks #wool #stone_tool_material #coal #sand` in `achieve`/planner (`planner/knowledge/tags.ts`, `Planner.resolveGoals`; additive `Job.generic`, runner re-plans from tags). 11 planner tests + 2 runner tests.
   - Prompt: gather/collect/chop/mine N => `achieve` (tags ok); direct mine tools only for one specific block / tiny count.
   - Side reply (`ClaudeBackend.runSideReply`, D15, PLANNER.md): status question while a skill is in flight is answered by a one-turn Haiku session with refusing stubs for every tool but say/whisper (same tool defs/system prompt => cache hit); does not touch cancellation, currentTool, queue or task telemetry; falls back to the queue after 15 s. `currentTool` now carries an args summary (`harness.ts`, `current-tool.ts`). 17 tests for `isStatusQuestion`.
4. **conv.two_part "8.4 blocks away".** Not the bot. Bot telemetry has no movement after `goTo` arrived (last event = `nav Tester`; task ended 1.5 s later; no reflex events). The eval Tester (`src/eval/tester.ts pickupStep`) walks toward any dropped item within 6 blocks, so it wandered off from the bot after the felling left items near it; repeat 2 passed only because `giveItemsTo` walked to it again. Bot-side mitigation: the post-felling litter sweep (above) so fewer loose items remain. Harness fix (not done, v2 worktree is off limits): disable `walkItems` for non-give scenarios.
5. **int.stop**: unchanged path; re-verified live (below).
6. **Lead's extra: "Digging aborted" (t2.stone_pickaxe-2, t3.build_house-2).** Cause: the survival (drowning) reflex `interruptMovement()` calls `bot.stopDigging()`; logs show `[reflex] drowning: oxygen 8/20` right before every `dig FAILED ... Digging aborted`, with the bot standing in water ("no solid block directly under the bot (water)"). Other reflexes (look, eat, defend, armor) already bail while `currentTool` is set (job steps go through `runSkill`), so none interrupt a dig; the surfacing one must (it's a safety override). Fix in `mineOneBlock`: on "Digging aborted" wait for the reflex (`surfaceInterrupted`) + 300 ms, re-fetch the block and retry once from scratch; a second abort marks only that block unreachable (batch continues). Not done: skipping candidates that need standing in deep water.

## Hunks in shared files (for the merge)
`jobs/runner.ts`: import `isGoalTag`; `generic` set in `startInner`; `replan` plans from `job.generic ?? job.goals` and stores `job.goals = plan.goals` (3 small hunks). `agent/system-prompt.ts`: 3 sentences (achieve bullet, Gathering bullet, containers line). Also `jobs/wire.ts` (ledger keys), `jobs/describe.ts` (label), `jobs/tools.ts` (tag validation), `skills/registry.ts` (achieve description).

## Offline checks (mcv2-dev)
`tsc --noEmit` 0, `tsc -p src/web/ui` 0, `vitest run` 0 (280 tests, 17 files).

## Live results (v2/runs/dev-2ca, 1 repeat)
- t1.chop_logs PASS 10/10 (via achieve #log). conv.followup_chest PASS (chest had 6 logs; deposited by nearby-container line). conv.status_midtask PASS: "how's it going?" answered in seconds via the fresh job-context session (job path; side reply not needed), 10/10 logs. int.stop PASS (cobble frozen, 1.4 m away).
- conv.two_part FAIL: Haiku used achieve+deliverTo Tester ("come back here" misread as a hand-over), gave all 3 away => bot kept 1/3. Prompt fixed afterwards (deliverTo only for "give me"; second part of a request is done on [job finished]).
- Found: the SDK sessions loaded the account's claude.ai connectors (Haiku called a Docs `batch` tool once; +5k cached tokens of foreign tool defs). Added `strictMcpConfig: true` to task + side sessions.
- Run 2 (dev-2ca-b, final code): **5/5 PASS** - chop_logs, followup_chest, two_part (3/3 logs, 1.0 m from Tester), status_midtask (reply <20 s, 10/10), int.stop. Invocations used: 2 (a third was queued behind another agent's eval, not needed).
- Not exercised live: the side reply (`runSideReply`); with `achieve` the status question lands on a fresh job-context session instead. It only fires when a direct blocking tool (e.g. mineBlock) is in flight. Covered by unit tests of the gate (`isStatusQuestion`) only; worth a scripted scenario ("mine 20 stone" then "how's it going?").
- Prompt (system-prompt.ts) now also: second part of a request is done on [job finished]; deliverTo only for hand-overs.
