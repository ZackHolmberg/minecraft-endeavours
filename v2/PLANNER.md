# v2 goal planner + job runner (slice 2 design)

**Problem (v1):** Haiku sequences every step itself (gather → planks → sticks → table → pickaxe → stone → …), one tool round-trip each; v1's prompt hard-codes recipes. Long goals cost dozens of turns and break on any surprise. Research (Plan4MC, GITM, Optimus-1, Voyager's self-verification) says: resolve the dependency graph deterministically and verify every step.

## Shape

```
player chat ─► Haiku task (fresh session, context block)
                 │  achieve({goals:[{item,count}…]})   ← 1 tool call
                 ▼
            Job runner (middleware, one active job per bot, persisted job.json)
                 │  plan = planner(goals, worldView)    ← pure, minecraft-data + hand tables
                 │  for step in plan: execute → postcondition (inventory delta)
                 │     on failure: recovery ladder (deterministic) → re-plan
                 ▼
            job_end event ─► Haiku task "[job done/failed: …]" ← decision point only
```

- `achieve` **returns immediately** after the plan is accepted (`{ok, jobId, plan summary}`), so the Haiku session ends in ~2 turns. The job runs in middleware; no tool call outlives the session, and the 10-min skill watchdog doesn't apply to jobs (they have their own per-step timeouts).
- On job end, the orchestrator queues a synthetic event for the bot's agent (like v1's max-turns follow-up). Haiku decides what to tell the player or what to try next. Success → usually one `say`.
- Mid-job player messages start a normal Haiku task whose context block shows the job status; Haiku answers without disturbing it, or calls `cancelJob` / a new `achieve` (which replaces the job). Stop commands cancel the job via the existing cancellation flag.
- Restart-safe: `job.json` in `data/orchestrator/memory/<bot>/`; on boot, an unfinished job is reported to Haiku as interrupted (not auto-resumed in slice 2).

## Planner (`src/planner/`, pure, no bot)

`plan(goals, view) → Plan` over:
- **minecraft-data 1.21.9:** recipes (collapse wood/stone variants; pick the variant matching inventory, then nearest species), `block.drops`, `harvestTools` (tool tier), `entityLoot`.
- **Hand tables (`src/planner/knowledge/`):** smelting (input→output), fuel burn units, tool-tier order (wooden < stone/copper/gold quirk < iron < diamond < netherite), ore Y-bands, stations (crafting_table, furnace) as craftable+placeable.

Resolution for `have(item, n)`, first viable source wins: inventory → known container (withdraw) → craft (recurse on ingredients, yields + leftovers tracked) → smelt (recurse on input + fuel + furnace) → gather (blocks whose drops include item; recurse on min tool) → mob loot (later) → `unresolved` with a reason. Tools/stations are acquired once and reused; already-owned higher-tier tools satisfy lower requirements. Output is an ordered, count-exact step list plus raw-material totals, so Haiku can see "needs 3 iron_ore, 2 coal, 5 logs".

## Executor (`src/jobs/`)

Each step runs via existing skills/primitives (mine, craft, smelt, withdraw, place station) with a **postcondition** (inventory delta / block placed) and a **typed failure** (`FailureKind`). Recovery ladder before escalating: (1) retry once; (2) re-plan from the current inventory; (3) for `no_source`: widen the search → consult world memory sightings → explore (surface walk for wood; stair/branch-mine to the ore's Y-band for ores); (4) give up → job fails with the failure + the remaining plan. Haiku sees a structured summary, never raw logs.

## Telemetry (additive to `telemetry-types.ts`)

`job_start`, `job_end`, `step`, `recovery`. The eval treats a running job as "busy" (not idle), so `waitForDone` waits for `job_end` too.

## Contracts

`src/planner/types.ts`, `src/jobs/types.ts`. Decisions: D10 in [DECISIONS.md](DECISIONS.md).

## Generic goals (slice 2c-A)
`Goal.item` may be a tag: `#log`, `#planks`, `#wool`, `#stone_tool_material`, `#coal`, `#sand` (`planner/knowledge/tags.ts`). `plan()` resolves tags first (`Planner.resolveGoals`): held members count first (largest stack first), any shortfall goes to the member that is cheapest to *get* now (in view / craftable from what is held, ignoring what is already held; avoided blocks excluded; ties → owned, then default species order). `Plan.goals` is always concrete. The runner stores the asked goals as `Job.generic` and re-plans from them, so the species is re-chosen each time (an unreachable one is avoided); `Job.goals` is the latest concrete resolution (what `deliverTo` hands over).

## Mid-task side reply (slice 2c-A)
In `per_task` mode a routed chat that arrives while the task session is blocked in a skill used to wait for the whole task. Now, if a directly addressed *status question* (`isStatusQuestion`: '?' or how/what/where/when/are/is/can, but not "can you also grab…" requests) arrives while the task session is live and a skill is in flight, `ClaudeBackend.runSideReply` answers it within seconds: a one-turn Haiku session (effort low, same system prompt, tool defs byte-identical via `buildSideReplyServer` so the prompt cache hits) whose context is `buildAgentContext(bot, {midTask:true})` (adds `# Right now: running <tool> <args> for Ns`, plus live inventory and job progress). Safety: all tools except say/whisper are refusing stubs; it never touches the cancellation flag, `currentTool`, the task queue or the telemetry task, so the running skill is undisturbed and it is not a task for coalescing. Its say is logged to conversation.json like any other. Fallback: nothing said in 15 s ⇒ the message is queued normally. Limitation: one at a time; a request phrased as a question is queued, not answered.
