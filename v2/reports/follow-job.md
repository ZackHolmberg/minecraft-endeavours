# Follow as a background job (branch v2-fixes, no commits)

**Problem (live test 2026-10-10):** `followPlayer` blocked the task session; a non-question chat mid-follow ("I am so proud of you") waited until the follow failed ("lost sight"), then was answered far too late.

## What changed
- `followPlayer` (src/jobs/tools.ts, registry.ts) now calls `runner.startFollow` and returns at once; the Haiku session ends. Falls back to the old blocking skill if no runner exists (legacy backends).
- New job kind `follow` (`Job.follow = {player, dist}`): runner.ts `startFollow` / `runFollowJob`, telemetry `job_start` (goal `follow:<player>`) / `job_end`, persisted in job.json, 30-min cap (ends `done`, `[job finished]`).
- Pure logic src/jobs/follow.ts (`FollowTracker`, `movementDir`, `searchWaypoints`). Bot-bound src/jobs/steps/follow.ts: 250 ms loop, dynamic `GoalFollow` (~3 blocks), `navigate` for search legs, shared Movements (doors, natural-only digging).
- Lost sight (entity gone, `bot.players[name]` still present): 1 s debounce, walk to last known position, then 8 and 20 blocks ahead along the last heading; back in view => follow again. Fails `[job failed]` (kind `unreachable`, clear reason incl. last seen coords) after 45 s, 3 s after the player left the list, or 40 s visible-but-not-closer (no path).
- Reflexes: runs outside `runSkill` (no current-tool slot), so auto-eat, defend, idle look work; the follow goal is re-issued after the surfacing reflex drops it.
- Ends on: stop (side-channel / `maybeInterrupt`, quiet, no event), `cancelJob`, a new job, any non-exempt Haiku tool call (auto-cancel). Not on chat: `say`/`whisper` are exempt, so chat during a follow is a fresh Haiku task that answers and leaves the follow running. Verified live (below).
- Context: `# Current job` shows `following <player> (Ns)` plus a "chat is fine, movement tools cancel it" hint; system prompt + tool description updated. `registerJobRequesterProbe` routes the requester's un-named chat (requestedBy = conversation partner, else the followed player); confirmed in log ("this way" -> `reason=follow-up`; the probe also covers it).
- Docs: v2/PLANNER.md "Follow job", SKILLS.md, v2/SCENARIOS.md row.

## Tests / validation
- `npx tsc --noEmit`, `npx tsc --noEmit -p src/web/ui`, `npx vitest run` (23 files, 340 tests; new src/jobs/follow.test.ts: 19 tests: tracker transitions, lost/left/stuck timings, waypoints, runner states with a fake executor), `src/skills/__checks__/*.check.ts` all pass.
- Live (test server): dev-follow: t1.follow PASS (4.8 blocks), t1.come_here PASS, int.stop PASS; dev-follow2: conv.chat_while_following PASS (reply to the praise in <15 s, "thanks Tester, still following you"; bot 5.3 blocks from Tester at the end; job kept running through both chats).
- Eval note: the v2 checkout's runner does not contain the new scenario (can't be edited from here), so dev-follow2 used a preload (scratchpad `preload.mts`) that registers `conv.chat_while_following` from mcv2-dev. Add the scenario in the v2 checkout when merging. Lost-sight search legs are unit-tested only (no live scenario for a vanishing player).
