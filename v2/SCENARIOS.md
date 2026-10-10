# Benchmark scenario catalogue

Spec for `src/eval/scenarios/*`. Contract: `src/eval/types.ts`; harness: [EVAL.md](EVAL.md). Every request starts "steve, …". "Protected" = `ctx.protect()` box (breaking it = violation). Timeouts are hard caps; success ends a scenario early.

**Suites:** `core` = tiers 1–3 + conv/int/pl/cr (run every slice). `stretch` = tier 4 (run at milestones; slow).

## Tier 1: single capability
| id | site | setup | request | success | timeout |
|---|---|---|---|---|---|
| t1.chop_logs | forest | empty inv | "chop 10 logs please" | ≥10 `*_log` (score n/10) | 6m |
| t1.come_here | plains | Tester 25 blocks away | "come here" | bot ≤4 blocks from Tester | 2m |
| t1.give_bread | plains | bot 6 bread; Tester inv cleared | "can you give me 3 bread?" | Tester ≥3 bread | 2m |
| t1.mine_stone | hills | wooden_pickaxe | "mine 8 stone" | ≥8 cobblestone | 4m |
| t1.craft_table | plains | 3 oak_log | "make a crafting table" | crafting_table in inv or placed ≤6 blocks | 2m |
| t1.eat | plains | hunger effect until food ≤10, then 4 bread (reflex eating counts) | "eat something" | foodLevel > post-setup level | 2m |
| t1.inv_question | plains | 5 bread, 3 torch, iron_sword | "what's in your inventory?" | reply ≤45s mentions bread AND sword | 1m |
| t1.follow | plains | — | "follow me", then Tester walks 24 blocks (tp 3 blocks every 1.5s) | bot ≤6 blocks from Tester 10s after last step | 2m |

## Tier 2: multi-step
| id | site | setup | request | success | timeout |
|---|---|---|---|---|---|
| t2.wooden_pickaxe | forest | empty | "make a wooden pickaxe" | wooden_pickaxe | 6m |
| t2.stone_pickaxe | forest | empty | "make yourself a stone pickaxe" | stone_pickaxe | 10m |
| t2.door_house | plains2 | closed 7×7 plank house + oak_door, protected; Tester inside | "come inside the house to me" | bot in interior AND 0 broken | 3m |
| t2.door_exit | plains2 | same house; bot inside, Tester 10 out | "come out here" | bot outside, ≤5 from Tester, 0 broken | 3m |
| t2.chest_store | plains | 16 oak_log, 5 cobblestone; chest 6 away (protected) | "put your logs in the chest" | chest ≥16 oak_log | 3m |
| t2.smelt_iron | plains | 6 raw_iron, 4 coal; furnace 5 away (protected) | "smelt your raw iron" | inv+furnace output ≥6 iron_ingot | 4m |
| t2.kill_zombie | plains | iron_sword; tagged zombie w/ helmet (no burn), 8 away | "kill that zombie" | tagged zombie gone, bot alive | 2m |
| t2.coal | cave | stone_pickaxe | "get me some coal" | ≥3 coal in bot or Tester inv | 8m |

## Tier 3: long-horizon
| id | site | setup | request | success | timeout |
|---|---|---|---|---|---|
| t3.iron_pickaxe | forest | empty | "make an iron pickaxe" | iron_pickaxe | 25m |
| t3.survive_night | plains | stone_sword, 5 bread; time 13000 | "it's getting dark, survive the night" | time ≥23500 reached, 0 deaths (score 0.5 if 1 death) | 12m |
| t3.build_house | plains | 64 oak_planks, oak_door, 4 glass | "build a small house here" | ≥40 placed blocks in 16-block box AND door placed (partial) | 15m |
| t3.wheat_farm | plains | wooden_hoe, 16 wheat_seeds; water source placed | "set up a small wheat farm here" | ≥9 `wheat` crop blocks within 10 (score n/9) | 10m |
| t3.portal | plains | 10 obsidian, flint_and_steel | "build a nether portal here" | ≥1 `nether_portal` block within 12 | 10m |

## Tier 4: stretch
| id | site | setup | request | success | timeout |
|---|---|---|---|---|---|
| t4.iron_kit | forest | empty | "get yourself a full iron kit: armor, sword and pickaxe" | 4 armor + sword + pickaxe (score n/6) | 60m |
| t4.diamonds | cave | iron_pickaxe, 32 torch, 16 bread | "go find some diamonds" | ≥1 diamond | 30m |
| t4.portal_scratch | forest | empty | "build a nether portal" | nether_portal block exists anywhere near (≤64) | 60m |

## Conversation / interruption / player-likeness / creative
| id | site | setup | script | success | timeout |
|---|---|---|---|---|---|
| conv.followup_chest | forest | chest 5 away (protected) | "chop 5 logs" → waitForDone → "now put them in the chest" ("get me" was ambiguous: v1 handed them over) | chest ≥5 `*_log` | 8m |
| conv.two_part | forest | — | "grab 3 logs and then come back here" | ≥3 logs AND ≤4 from Tester | 5m |
| conv.status_midtask | forest | — | "chop 10 logs" → after 20s "how's it going?" | reply to 2nd msg ≤20s AND ≥10 logs eventually | 7m |
| int.stop | hills | wooden_pickaxe | "mine 64 stone" → after 20s "steve stop" → after 10s "come here" | cobblestone count frozen within 8s of stop AND ≤4 from Tester at end | 3m |
| int.not_stop | forest | — | "chop 10 logs" → after 10s "wait, also grab some sticks" | ≥10 logs (not cancelled) (+0.2 if sticks) | 7m |
| pl.no_grief | forest | small hut walled with oak_log among trees (protected) | "chop the trees around here, get 8 logs" | ≥8 logs AND 0 broken | 6m |
| pl.stairs_not_pillar | plains2 | 6-high platform with built stairs; Tester on top | "come up here" | ≤4 from Tester AND pillarRuns = 0 | 3m |
| cr.build_house | plains | creative | "build me a small house with a door right here" | ≥40 placed blocks AND a door | 10m |
| cr.give_torches | plains | creative; Tester inv cleared | "give me 64 torches" | Tester ≥64 torch | 2m |

## Harness additions needed (additive to types.ts)
- `placedBlocks(box)`: count of positions in box that changed air/replaceable → solid since setup ended (Tester `blockUpdate` tracking, like `protect`).
- `foodLevel(player)`, `timeOfDay()` via RCON (`data get entity … foodLevel`, `time query daytime`).
- Suite tags: `Scenario.suite?: "core" | "stretch"` (default core) and runner `--suite`.

**Confirm policy:** `t3.build_house`, `cr.build_house`, `t3.wheat_farm`, `t3.portal` use `ask(…, { confirm: true })`: if the bot proposes a plan and waits (v1's owner-approved propose-and-confirm rule for big/permanent requests), the Tester answers "yes go ahead" (≤2×). Other scenarios never auto-confirm: a trailing question there means the bot gave up.
