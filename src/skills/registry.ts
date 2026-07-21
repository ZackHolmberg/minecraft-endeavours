/**
 * Neutral skill registry — the single source of truth for every skill the
 * bot can call, independent of which LLM backend drives it.
 *
 * Each `SkillSpec` carries the name, the model-facing description, the zod
 * input shape, a `run` dispatcher (which goes through `runSkill` so the
 * actions-log / current-tool / cancellation / question-tracker cross-cutting
 * concerns stay in the loop), and `surfaces` tags marking which backends may
 * expose it.
 *
 * Adapters turn these specs into backend-specific tool definitions:
 *  - `toClaudeMcpServer` (src/agent/backend/adapters.ts) → Claude Agent SDK
 *    `tool()` defs. `tool()` consumes a raw zod shape directly, which is why
 *    `schema` is a `ZodRawShape` rather than a wrapped `z.object`.
 *  - `toOpenAITools` (Phase B) → OpenAI-style function defs via
 *    `z.toJSONSchema(z.object(spec.schema), ...)`.
 *
 * Surface tags:
 *  - `claude`   — exposed to ClaudeBackend (all 35; preserves today's surface).
 *  - `executor` — curated local-executor subset validated in spikes/mlx-tools-spike.ts.
 *  - `planner`  — planner toolset (talk or plan only) for the hybrid coordinator.
 * Only `claude` is consumed in Phase A; `executor`/`planner` are forward-looking
 * metadata wired in Phase B/C.
 */

import type { Bot } from "mineflayer";
import { z } from "zod";
import { runSkill } from "./harness.js";
import type { SkillResult } from "./types.js";
import {
  activateBlock,
  advanceTaskQueue,
  attack,
  checkInventory,
  craft,
  craftMany,
  depositManyToChest,
  depositToChest,
  dropItem,
  eat,
  equipItem,
  equipLoadout,
  fish,
  flee,
  followPlayer,
  giveItemsTo,
  giveItemTo,
  goTo,
  mineBlock,
  mineBlocks,
  observeSurroundings,
  pickUpNearby,
  placeBlock,
  placeBlocks,
  remember,
  say,
  setTaskQueue,
  sleepIn,
  smelt,
  stop,
  useItem,
  useOnEntity,
  whisper,
  withdrawFromChest,
  withdrawManyFromChest,
} from "./index.js";

export interface SkillSurfaces {
  /** Exposed to ClaudeBackend. All 35 today — preserves current behavior. */
  claude: boolean;
  /** Curated local-executor subset (spikes/mlx-tools-spike.ts). */
  executor: boolean;
  /** Planner toolset: talk or plan only (hybrid coordinator). */
  planner: boolean;
}

export interface SkillSpec {
  name: string;
  description: string;
  /** Raw zod shape — consumed directly by the SDK `tool()`. */
  schema: z.ZodRawShape;
  /** Dispatch through `runSkill`; args are validated by the caller's adapter. */
  run: (bot: Bot, args: unknown) => Promise<SkillResult>;
  surfaces: SkillSurfaces;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch helpers. `withParams` casts the already-validated args to the skill's
// param type (the adapter validates against `schema` before calling); `noParams`
// covers the four argument-free skills.
// ─────────────────────────────────────────────────────────────────────────────

function withParams<P>(
  name: string,
  fn: (bot: Bot, params: P) => Promise<SkillResult>,
): (bot: Bot, args: unknown) => Promise<SkillResult> {
  return (bot, args) => runSkill(bot, name, args, (p) => fn(bot, p as P));
}

function noParams(
  name: string,
  fn: (bot: Bot) => Promise<SkillResult>,
): (bot: Bot, args: unknown) => Promise<SkillResult> {
  return (bot) => runSkill(bot, name, undefined, () => fn(bot));
}

// Reused schema fragments (moved verbatim from skill-tools.ts).
const posSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });
const goToTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coords"),
    coords: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  }),
  z.object({ kind: z.literal("entity"), entity: z.string() }),
  z.object({ kind: z.literal("block"), block: z.string() }),
]);

// Surface presets.
const CLAUDE_ONLY: SkillSurfaces = { claude: true, executor: false, planner: false };
const EXECUTOR: SkillSurfaces = { claude: true, executor: true, planner: false };
const PLANNER_ONLY: SkillSurfaces = { claude: true, executor: false, planner: true };
const EXEC_AND_PLAN: SkillSurfaces = { claude: true, executor: true, planner: true };

export const SKILL_SPECS: SkillSpec[] = [
  {
    name: "observeSurroundings",
    description:
      "Look around. Returns nearby blocks (grouped by type with counts and nearest coords), nearby entities (players, mobs, vehicles like boats/minecarts, immobile objects like item frames, dropped items), the bot's status (health, food, position, facing, time of day, weather), known storage from world memory, known utility blocks (crafting tables, furnaces, beds), known waypoints (any other POI you've `remember`-ed — mine entrances, named bases, etc.), recent skill activity, recently-seen players, and the current task queue.",
    schema: {
      radius: z.number().int().min(1).max(64).optional().describe("Search radius in blocks (default 16)"),
    },
    run: withParams("observeSurroundings", observeSurroundings),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "checkInventory",
    description:
      "Read-only inventory report. Returns a grouped list of every item in main inventory + hotbar + armor + off-hand, with stack counts, durability for tools, and equipped-slot annotations. Call this BEFORE trying to use a specific tool — observeSurroundings only shows the currently-held item, not what else is available.",
    schema: {},
    run: noParams("checkInventory", checkInventory),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "say",
    description:
      "Send a message to public chat. Use this to reply to players who addressed you on public chat, and to narrate what you're doing during multi-step tasks. Keep messages short (one or two sentences). Messages over 256 chars are truncated.",
    schema: { message: z.string().min(1) },
    run: withParams("say", say),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "whisper",
    description:
      "Send a private message to a single player. Use this to reply to players who whispered you via /msg. Same length rules as `say`. Fails if the player is not currently online.",
    schema: { player: z.string().min(1), message: z.string().min(1) },
    run: withParams("whisper", whisper),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "goTo",
    description:
      "Pathfind to a target. Pre-checks reachability and fails fast (without committing to a doomed walk) if no path exists. Target is one of: { kind: 'coords', coords: { x, y, z } } | { kind: 'entity', entity: '<player or mob name>' } | { kind: 'block', block: '<block id>' }. Optional `reach` (default 1) sets stop distance in blocks.",
    schema: {
      target: goToTargetSchema,
      reach: z.number().int().min(0).max(16).optional(),
    },
    run: withParams("goTo", goTo),
    surfaces: EXECUTOR,
  },
  {
    name: "stop",
    description:
      "Cancel the bot's current movement and any in-flight long-running skill (followPlayer, attack, flee). Safe to call when nothing is in flight. Use when the player says 'stop' or when you decide to abandon a sustained skill mid-task.",
    schema: {},
    run: noParams("stop", stop),
    surfaces: EXECUTOR,
  },
  {
    name: "followPlayer",
    description:
      "Follow a player at `dist` blocks of separation, indefinitely, until cancelled. Cancellation fires when the player says 'stop'/'halt'/'wait' (side-channel) or when you call the `stop` skill. Blocks the agent loop — use only when sustained following is what the player actually asked for.",
    schema: {
      player: z.string().min(1),
      dist: z.number().int().min(1).max(16).optional().describe("Follow distance in blocks (default 2)"),
    },
    run: withParams("followPlayer", followPlayer),
    surfaces: EXECUTOR,
  },
  {
    name: "mineBlock",
    description:
      "Mine N blocks of ONE specific type. PREFER `mineBlocks` for prospecting (mining several ore types in one excursion) — that variant scans for any of N types nearest-first and adapts as the bot moves. Reserve `mineBlock` for true single-type gathering (a stack of wood, a count of cobblestone).",
    schema: {
      type: z.string().min(1).describe("Block ID, e.g. 'oak_log', 'stone', 'iron_ore'"),
      count: z.number().int().min(1).max(64).optional(),
    },
    run: withParams("mineBlock", mineBlock),
    surfaces: EXECUTOR,
  },
  {
    name: "mineBlocks",
    description:
      "Multi-type mining sweep — the right call for *'mine any ores you can find down there'*. Searches for the nearest instance of ANY type in `types`, walks to it, mines it, repeats until `maxCount` or no candidates remain. Tool-tier preflight per type: types the bot can't harvest are skipped (reported in state.skipped), not fatal — a mixed `[iron_ore, coal_ore, diamond_ore]` request with only a stone pickaxe still gathers iron + coal and tells you why diamond was skipped. Returns state.mined (total) + state.byType (per-type counts).",
    schema: {
      types: z
        .array(z.string().min(1))
        .min(1)
        .describe("Block IDs to look for, e.g. ['iron_ore', 'coal_ore', 'diamond_ore']"),
      maxCount: z
        .number()
        .int()
        .min(1)
        .max(128)
        .optional()
        .describe("Total blocks across all types (default 32, max 128)"),
      maxDistance: z
        .number()
        .int()
        .min(1)
        .max(128)
        .optional()
        .describe("Search radius per scan (default 64)"),
    },
    run: withParams("mineBlocks", mineBlocks),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "placeBlock",
    description:
      "Place a block of the given type at the target position. Requires the item in inventory and a solid neighbor at one of the six adjacent positions to click against. Fails with a specific message if either is missing. PREFER `placeBlocks` for any multi-block structure — placing one block per tool call costs an LLM round-trip each, so a 30-block wall takes minutes instead of seconds.",
    schema: {
      type: z.string().min(1).describe("Block item ID, e.g. 'cobblestone', 'oak_planks'"),
      position: posSchema,
    },
    run: withParams("placeBlock", placeBlock),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "placeBlocks",
    description:
      "Batch placement — place up to 64 blocks in one tool call. Use this for any contiguous structure (walls, floors, roofs, pillars, paths). One LLM round-trip places the whole batch, then mineflayer paces the placements at ~10 blocks/sec. Cancellable mid-batch via the `stop` skill or chat side-channel. On the first failure, returns ok:false with `state.placed` (how many landed) and `state.failedIndex` so you can re-plan from where it stopped.",
    schema: {
      blocks: z
        .array(
          z.object({
            type: z.string().min(1).describe("Block item ID, e.g. 'cobblestone'"),
            position: posSchema,
          }),
        )
        .min(1)
        .max(64),
    },
    run: withParams("placeBlocks", placeBlocks),
    surfaces: EXECUTOR,
  },
  {
    name: "pickUpNearby",
    description:
      "Walk to and pick up every dropped item within `maxDist` blocks. Use after a mob fight, after dropping items, or whenever you see items in `nearbyDroppedItems` you want to collect. mineBlock already does this internally per-dig, so you usually don't need it after a mining task.",
    schema: {
      maxDist: z.number().int().min(1).max(32).optional().describe("Search radius in blocks (default 8)"),
    },
    run: withParams("pickUpNearby", pickUpNearby),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "dropItem",
    description:
      "Drop `count` of `item` from inventory onto the ground at the bot's feet. If `count` is omitted, drops every matching stack. Partial-progress is reported in state.dropped on failure.",
    schema: {
      item: z.string().min(1).describe("Item ID, e.g. 'oak_log', 'iron_ingot'"),
      count: z.number().int().min(1).max(2304).optional(),
    },
    run: withParams("dropItem", dropItem),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "giveItemTo",
    description:
      "Hand off ONE item type to a player. PREFER `giveItemsTo` for any multi-item handoff (full toolset, full armor set) — that variant walks once and tosses each item in sequence. Reserve `giveItemTo` for true single-item handoffs.",
    schema: {
      player: z.string().min(1),
      item: z.string().min(1),
      count: z.number().int().min(1).max(2304).optional(),
    },
    run: withParams("giveItemTo", giveItemTo),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "giveItemsTo",
    description:
      "Hand off SEVERAL items to a player in one walk. One LLM round-trip walks to the player once, looks at them, and tosses each item from `items` in sequence (each `count` defaults to every matching stack). Use for any multi-item ask: 'give me a full iron set', 'drop me food and a pickaxe'. Stops at the first per-item failure and returns state.given[] + state.failedIndex so you can re-plan from where it stopped.",
    schema: {
      player: z.string().min(1),
      items: z
        .array(
          z.object({
            item: z.string().min(1),
            count: z.number().int().min(1).max(2304).optional(),
          }),
        )
        .min(1)
        .max(36),
    },
    run: withParams("giveItemsTo", giveItemsTo),
    surfaces: EXECUTOR,
  },
  {
    name: "equipItem",
    description:
      "Equip ONE item to a slot (default 'hand'). PREFER `equipLoadout` when changing multiple slots at once (full armor set, weapon+shield combo). Most item-use skills (activateBlock, useOnEntity) accept an optional `with` parameter that calls this internally — reach for `equipItem` directly for a single armor / off-hand swap or to set up before a sequence sharing one tool.",
    schema: {
      item: z.string().min(1).describe("Item ID, e.g. 'iron_pickaxe', 'shears', 'iron_helmet'"),
      slot: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"]).optional(),
    },
    run: withParams("equipItem", equipItem),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "equipLoadout",
    description:
      "Equip several slots in one call. Pass any subset of {head, torso, legs, feet, hand, offHand}; omitted slots are left alone. One round-trip covers a full armor-up (head+torso+legs+feet) or a combat loadout (hand+offHand). Stops at the first per-slot failure with state.equipped[] + state.failedSlot for re-planning.",
    schema: {
      head: z.string().min(1).optional().describe("Helmet, e.g. 'iron_helmet'"),
      torso: z.string().min(1).optional().describe("Chestplate, e.g. 'iron_chestplate'"),
      legs: z.string().min(1).optional().describe("Leggings, e.g. 'iron_leggings'"),
      feet: z.string().min(1).optional().describe("Boots, e.g. 'iron_boots'"),
      hand: z.string().min(1).optional().describe("Main-hand item, e.g. 'iron_sword'"),
      offHand: z.string().min(1).optional().describe("Off-hand item, e.g. 'shield'"),
    },
    run: withParams("equipLoadout", equipLoadout),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "activateBlock",
    description:
      "Right-click on a block at the given position. Covers hoe → till dirt to farmland, flint_and_steel → ignite, bucket → fill from water/lava source, water_bucket/lava_bucket → place liquid, bone_meal → grow crop, seeds → plant on farmland, doors/trapdoors/levers/buttons → toggle, jukebox → insert disc. Pass `with` to auto-equip the tool first.",
    schema: {
      position: posSchema,
      with: z.string().optional().describe("Item ID to equip to hand before activating (e.g. 'iron_hoe', 'bucket')"),
    },
    run: withParams("activateBlock", activateBlock),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "useOnEntity",
    description:
      "Right-click on an entity (mob or player). Covers shears → sheep (collect wool without killing), bucket → cow (milk), name_tag → entity (rename), dye → sheep (color wool), lead → animal, saddle → horse, glass_bottle → cow (honey/water from sources). Pass `with` to auto-equip the tool first.",
    schema: {
      entity: z.string().min(1).describe("Mob type ('sheep', 'cow', 'pig') or player username"),
      with: z.string().optional().describe("Item ID to equip to hand before using (e.g. 'shears', 'bucket')"),
    },
    run: withParams("useOnEntity", useOnEntity),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "useItem",
    description:
      "Right-click in mid-air with the held item (or off-hand item). Fire-and-forget — does not wait for any animation to complete. Use for: throwing an ender pearl, throwing a splash/lingering potion, starting to charge a bow or crossbow, casting a fishing rod manually (prefer the `fish` skill). DO NOT use for eating food or drinking potions — use the `eat` skill instead, which handles the full activate-then-consume cycle.",
    schema: {
      with: z.string().optional().describe("Item ID to equip first (e.g. 'ender_pearl', 'bow')"),
      offhand: z.boolean().optional().describe("Use the off-hand item instead of main-hand"),
    },
    run: withParams("useItem", useItem),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "eat",
    description:
      "Eat food. Composite: equip the food → call bot.consume which handles the activate-then-finish cycle. When `item` is omitted, picks the best available food from inventory (cooked > raw, higher saturation first). Won't eat when food is already 20/20 unless an explicit `item` was passed.",
    schema: {
      item: z.string().optional().describe("Specific food item; omit to auto-pick best from inventory"),
    },
    run: withParams("eat", eat),
    surfaces: EXECUTOR,
  },
  {
    name: "fish",
    description:
      "Cast a fishing rod and wait for a bite. Requires fishing_rod in main-hand (equipItem first if needed) and water within casting range. Cancellable via the `stop` skill or the chat side-channel — reels in early on cancel. Times out after 5 minutes with no bite.",
    schema: {},
    run: noParams("fish", fish),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "sleepIn",
    description:
      "Sleep in a bed. Bed resolution: caller-supplied `pos` → nearest *_bed within 32 blocks → nearest remembered bed POI from world memory. Walks within reach, then calls bot.sleep. Vanilla preconditions apply: must be night (or thunderstorm), bed not obstructed; mineflayer's error messages surface as-is.",
    schema: {
      pos: posSchema.optional().describe("Explicit bed position; omit to auto-find"),
    },
    run: withParams("sleepIn", sleepIn),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "craft",
    description:
      "Craft ONE recipe (item × count). PREFER `craftMany` for any multi-recipe ask (full toolset, full armor set, sticks+planks+chest in one go) — that variant walks to a table at most once and runs each recipe in order. Reserve `craft` for true single-recipe asks.",
    schema: {
      item: z.string().min(1).describe("Item ID, e.g. 'oak_planks', 'iron_pickaxe'"),
      count: z.number().int().min(1).max(64).optional(),
      tablePos: posSchema.optional().describe("Explicit crafting table position; omit to auto-find"),
    },
    run: withParams("craft", craft),
    surfaces: EXECUTOR,
  },
  {
    name: "craftMany",
    description:
      "Craft SEVERAL recipes in one call. The table is resolved lazily — if every item has a 2×2 recipe, no table walk happens; otherwise the bot walks once on the first 3×3 recipe and stays there for the rest. ORDER MATTERS: earlier crafts consume ingredients later ones may need (sticks → pickaxe → sword is fine; sword → pickaxe → sticks isn't). On per-item failure (shortfall, no recipe, etc.) returns state.crafted[] + state.failedIndex so you can re-plan from that point.",
    schema: {
      items: z
        .array(
          z.object({
            item: z.string().min(1).describe("Item ID"),
            count: z.number().int().min(1).max(64).optional(),
          }),
        )
        .min(1)
        .max(36),
      tablePos: posSchema.optional().describe("Explicit crafting table position; omit to auto-find"),
    },
    run: withParams("craftMany", craftMany),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "smelt",
    description:
      "Smelt `count` of `input` in a furnace. Composite: resolve furnace (caller-supplied → nearby 32 blocks → nearest remembered furnace POI), walk to it, put input + fuel, wait for output, take it. Fuel is auto-picked from inventory when omitted (prefers coal → charcoal → coal_block → blaze_rod → dried_kelp_block). Closes the iron-armor loop: mine raw_iron → smelt → craft.",
    schema: {
      input: z.string().min(1).describe("Item ID to smelt, e.g. 'raw_iron', 'raw_copper', 'sand', 'beef'"),
      fuel: z.string().optional().describe("Fuel item ID; omit to auto-pick best fuel from inventory"),
      count: z.number().int().min(1).max(64).optional().describe("How many to smelt (default 1)"),
      furnacePos: posSchema.optional().describe("Explicit furnace position; omit to auto-find"),
    },
    run: withParams("smelt", smelt),
    surfaces: EXECUTOR,
  },
  {
    name: "attack",
    description:
      "Attack `entity` (a mob name like 'zombie' or a player username) in melee. Equips the best available weapon, paths into range, swings on cooldown. Blocking; exits when the target dies, leaves visibility, or cancellation is requested (player says 'stop' / `stop` skill).",
    schema: { entity: z.string().min(1) },
    run: withParams("attack", attack),
    surfaces: EXECUTOR,
  },
  {
    name: "flee",
    description:
      "Run away from `from` (a mob name or player username) until `dist` blocks of separation, or cancellation. Re-paths every ~1.5s so a chasing threat doesn't end up running alongside the bot.",
    schema: {
      from: z.string().min(1),
      dist: z.number().int().min(1).max(64).optional().describe("Target separation in blocks (default 16)"),
    },
    run: withParams("flee", flee),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "depositToChest",
    description:
      "Deposit ONE item type into a chest. PREFER `depositManyToChest` when stashing several item types into the same chest (post-mining haul, cleanup runs) — that variant opens the chest once and runs each deposit in sequence. Reserve `depositToChest` for true single-item stashes.",
    schema: {
      item: z.string().min(1).describe("Item ID to deposit"),
      count: z.number().int().min(1).max(2304).optional(),
      pos: posSchema.optional().describe("Explicit chest position; omit to use nearest known container"),
    },
    run: withParams("depositToChest", depositToChest),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "depositManyToChest",
    description:
      "Deposit SEVERAL item types into one chest in a single trip. Walks + opens + closes once; each item's `count` defaults to every matching stack. Container auto-capture snapshots on close, so memory updates once per batch (not once per item). Stops at first per-item failure with state.deposited[] + state.failedIndex.",
    schema: {
      items: z
        .array(
          z.object({
            item: z.string().min(1),
            count: z.number().int().min(1).max(2304).optional(),
          }),
        )
        .min(1)
        .max(36),
      pos: posSchema.optional().describe("Explicit chest position; omit to use nearest known container"),
    },
    run: withParams("depositManyToChest", depositManyToChest),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "withdrawFromChest",
    description:
      "Withdraw ONE item type from a chest. PREFER `withdrawManyFromChest` when pulling several item types out of the same chest. Reserve this for true single-item pulls.",
    schema: {
      item: z.string().min(1).describe("Item ID to withdraw"),
      count: z.number().int().min(1).max(2304).optional(),
      pos: posSchema.optional().describe("Explicit chest position; omit to use nearest known container with the item"),
    },
    run: withParams("withdrawFromChest", withdrawFromChest),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "withdrawManyFromChest",
    description:
      "Withdraw SEVERAL item types from one chest in a single trip. Walks + opens + closes once. When `pos` is omitted, finds the chest by the FIRST requested item (so all items should live in the same chest — split into multiple calls if they span chests). Each per-item count is clamped to what's actually in the chest; partial pulls land in the success message rather than failing. Stops only on a per-item zero-stock or transfer error: state.withdrawn[] + state.failedIndex.",
    schema: {
      items: z
        .array(
          z.object({
            item: z.string().min(1),
            count: z.number().int().min(1).max(2304).optional(),
          }),
        )
        .min(1)
        .max(36),
      pos: posSchema.optional().describe("Explicit chest position; omit to resolve via the first item"),
    },
    run: withParams("withdrawManyFromChest", withdrawManyFromChest),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "remember",
    description:
      "Record a named place into the bot's durable world knowledge (data/orchestrator/memory/<bot>/world.json). Use when a player names a location: 'this is the base', 'call this the wheat farm'. Position defaults to the bot's current location. Idempotent on (type, position).",
    schema: {
      type: z.string().min(1).describe("Classification: 'base', 'portal', 'bed', 'crafting_table', 'home', etc."),
      name: z.string().optional(),
      pos: posSchema.optional(),
    },
    run: withParams("remember", remember),
    surfaces: PLANNER_ONLY,
  },
  {
    name: "setTaskQueue",
    description:
      "Declare a multi-step plan. The first task becomes the current task; the rest are queued. The current and remaining tasks appear in every `observeSurroundings` call, so you do not need to remember them from chat history. Use for chained requests: 'get wood, then iron, then come back'.",
    schema: { tasks: z.array(z.string().min(1)).min(1) },
    run: withParams("setTaskQueue", setTaskQueue),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "advanceTaskQueue",
    description:
      "Mark the current task done and promote the next one. Returns 'task queue drained' when nothing remains. Call between steps of a `setTaskQueue` plan.",
    schema: {},
    run: noParams("advanceTaskQueue", advanceTaskQueue),
    // Executor needs this to drain a planner-authored queue (spikes/mlx-exec-spike.ts);
    // it sits outside the routing-spike curated-15, to be re-validated in Phase B.
    surfaces: EXECUTOR,
  },
];

export const SKILL_SPECS_BY_NAME: ReadonlyMap<string, SkillSpec> = new Map(
  SKILL_SPECS.map((s) => [s.name, s]),
);
