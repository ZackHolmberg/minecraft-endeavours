# v1 baseline (core suite, 2026-10-09)

Frozen v1 (`../minecraft-endeavours-v1base` @ `c1587b0`, bot `Steve_v2`, Haiku 5.5, effort medium), 1 repeat, fixed seed, pristine world. Run dir: `v2/runs/v1-baseline/` (last line per scenario is authoritative; `t1.eat` + `conv.followup_chest` re-run after harness fixes in `9fd1e1b`-era commit).

## Headline
**12/30 (40%)** · tier1 6/8 · tier2 4/8 · tier3 0/5 · conv 0/3 · int 0/2 · pl 1/2 · cr 1/2 · total 202 Haiku turns, $0.11 · p50 first reply ~2.6s · cache hit 93–99%. Player-likeness: door_house/door_exit each broke 2 protected wall blocks; 1 pillar run (followup_chest); 1 death (survive_night).

| scenario | ok | score | wall | turns | root cause (from bot log) |
|---|---|---|---|---|---|
| t1.chop_logs | ✗ | .30 | 48s | 4 | said "done, 10 logs"; had 3 — mineBlock counts digs, not pickups |
| t1.come_here | ✓ | 1 | 10s | 4 | |
| t1.give_bread | ✓ | 1 | 5s | 3 | (toss lands out of reach; passes because Tester walks) |
| t1.mine_stone | ✓ | 1 | 25s | 4 | first reply 22s |
| t1.craft_table | ✓ | 1 | 5s | 3 | |
| t1.eat | ✗ | 0 | 12s | 2 | harness: reflex ate the bread during the hunger drain (fixed; re-run below) |
| t1.inv_question | ✓ | 1 | 5s | 2 | |
| t1.follow | ✓ | 1 | 26s | 0 | (0 turns recorded: follow task still open at scenario end) |
| t2.wooden_pickaxe | ✓ | 1 | 20s | 5 | |
| t2.stone_pickaxe | ✗ | 0 | 46s | 20 | 3×3 craft "succeeds" but nothing appears (server rolls back unpaced clicks); Haiku retries to give-up |
| t2.door_house | ✗ | .5 | 15s | 4 | got inside by digging 2 planks beside the door (pathfinder canDig never disabled) |
| t2.door_exit | ✗ | .5 | 15s | 4 | same, on the way out |
| t2.chest_store | ✓ | 1 | 5s | 3 | |
| t2.smelt_iron | ✓ | 1 | 65s | 3 | first reply 65s (blocking smelt before saying anything) |
| t2.kill_zombie | ✓ | 1 | 5s | 4 | |
| t2.coal | ✗ | 0 | 64s | 6 | walked into a lake, "stuck" twice, asked the player for help |
| t3.iron_pickaxe | ✗ | 0 | 163s | 21 | blocked at stone pickaxe (craft rollback + deepslate/cobblestone variant confusion) |
| t3.survive_night | ✗ | .5 | 720s | 2 | "keep watch" then passive; died once to mobs |
| t3.build_house | ✗ | 0 | 14s | 2 | announced a plan, ended the session without placing anything |
| t3.wheat_farm | ✗ | 0 | 15s | 5 | "no dirt or grass within 32" — perception filters common terrain (grass pad verified present) |
| t3.portal | ✗ | 0 | 30s | 5 | placeBlocks needs support blocks; no scaffold logic; asked player for dirt |
| conv.followup_chest | ✗ | 0 | 148s | 24 | harness wording ("get me" → handed logs to player); re-run below |
| conv.two_part | ✗ | .91 | 83s | 19 | log-count bug; said "done" early, then corrected |
| conv.status_midtask | ✗ | .25 | 66s | 6 | log-count bug (claimed 10, had 5) |
| int.stop | ✗ | .89 | 48s | 8 | stop worked; next goTo failed "Path was stopped" (pathfinder 2.4.5 stop() latch) |
| int.not_stop | ✗ | .64 | 108s | 11 | not cancelled (good); log-count bug (6/10) |
| pl.no_grief | ✗ | .75 | 54s | 4 | no grief (good); log-count bug (6/8) |
| pl.stairs_not_pillar | ✓ | 1 | 5s | 4 | |
| cr.build_house | ✓ | 1 | 100s | 17 | 97 blocks, 11.8k output tokens (block-by-block via LLM) |
| cr.give_torches | ✗ | 0 | 13s | 3 | fetched torches into own inventory, never handed them over |

## v1 failure classes (ranked by scenarios cost)
1. **Gathering lies about counts** (digs ≠ pickups): chop_logs, two_part, status_midtask, not_stop, no_grief — 5. → slice 1.
2. **Pathfinder config never applied** (digs through player walls, towers): door_house, door_exit — 2 + player-likeness. → slice 1.
3. **LLM-sequenced crafting chains + silent craft rollback**: stone_pickaxe, iron_pickaxe — 2, at 20+ turns each. → slice 2 (planner + paced clicks).
4. **No building capability** (no blueprint/scaffold; LLM block lists): build_house, portal — 2. → future builder slice.
5. **Request handling / premature completion** (says done or plans then stops; doesn't deliver to player): build_house, give_torches, two_part — 3. → prompt + job re-entry.
6. **Terrain navigation** (water/lakes): coal — 1.
7. **Survival/combat passivity**: survive_night — 1.
8. **Perception blind spots** (common terrain filtered): wheat_farm — 1.
9. **Pathfinder stop latch**: int.stop (partial) — pathfinder master pin.

Efficiency note: cost is negligible (~$0.004/scenario) thanks to caching; the binding constraints are **turns/latency on long goals** and **subscription quota shared with development** (D8).
