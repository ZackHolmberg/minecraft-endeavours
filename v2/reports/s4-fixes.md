# v2-s4 fixes (branch v2-build)

## 1. build_incomplete after "Server refused to place" (t3.build_house-1)
- Evidence: the 2-tall column (774,64..65,-13) was refused on every try, from several stand spots and faces, across 3 job retries (80/82).
  This points to an entity (Tester or a mob) standing in the cell. mineflayer reports it as "the block is still air".
- `src/jobs/steps/build.ts`: failed `place` actions are deferred and retried at the end of the layer pass, before scaffold removal.
  The scaffold persistence and cleanup (H2) rules are untouched. Per cell, up to 3 rounds (`RETRY_TUNING`):
  1. `clearBlockers`: find overlapping player/mob/boat entities (not items). Fight a hostile, ask a player once in chat, wait up to 4 s.
  2. Step off the cell if the bot overlaps it, and re-pick a stand spot from round 2.
  3. Re-place with `avoidFaces` (new `placeBlock` param in `src/skills/world.ts`; failures return `state.face`), so each round uses another reference face.
  - Bounds: 45 s per layer, skip when out of material, stop/death respected. Only then does it fail `build_incomplete`.
- Not reproduced live (the s4fix builds were 57/57 with 0 refusals), so this path is covered by the sim tests only.

## 2. Chest beyond 16 blocks (conv.followup_chest-2)
- `world.json` `containers[]` gets seen-only entries (`seen: true`, `last_seen`, no contents). `last_opened` and `last_opened_by` are now optional. An open replaces the entry.
- Capture: `rememberSeenContainers` (`src/skills/containers.ts`) runs from the 5 s scan in `event-hooks.ts`. It skips double-chest halves and prunes broken ones. It keeps at most 40 entries.
- Context: a new line "remembered containers beyond 16m (seen, not opened)" with distances, at most 3, nearest first. A one-line note was added to the system prompt.
- `storage.ts` `resolveChestBlock`: seen containers within 64 blocks are the fallback for deposit and withdraw. It walks toward the chest if the chunk isn't loaded.
- Live: conv.followup_chest x2 deposited into the remembered chest at (442,63,-441).

## Validation
- tsc, `tsc -p src/web/ui`, vitest (26 files, 368 tests) and the 4 `__checks__` all exit 0.
- New tests: 3 in `build.sim.test.ts` and `src/skills/remembered-containers.test.ts` (4 tests).
- Live `dev-s4fix` (1 invocation): t3/cr.build_house, conv.followup_chest and t2.chest_store, 2 reps each, 8/8 PASS at 1.00.
