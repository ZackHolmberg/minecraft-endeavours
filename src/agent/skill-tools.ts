/**
 * Expose the skill layer to the Claude Agent SDK as MCP tools.
 *
 * One MCP server per bot — closures over the bot give each tool handler a
 * fixed bot reference without changing the underlying skill signatures.
 * Tool execution still goes through `runSkill` so exceptions become
 * `{ ok: false, message }` results and successful calls feed the
 * actions log + conversation-continuity tracker.
 *
 * The SDK auto-namespaces these names to `mcp__minecraft-skills__<tool>`;
 * the agent's `allowedTools` list uses that fully-qualified form.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "mineflayer";
import { z } from "zod";
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
} from "../skills/index.js";
import { runSkill } from "../skills/harness.js";
import type { SkillResult } from "../skills/types.js";

export const MCP_SERVER_NAME = "minecraft-skills";

const SKILL_NAMES = [
  "observeSurroundings",
  "checkInventory",
  "say",
  "whisper",
  "goTo",
  "stop",
  "followPlayer",
  "mineBlock",
  "mineBlocks",
  "placeBlock",
  "placeBlocks",
  "pickUpNearby",
  "dropItem",
  "giveItemTo",
  "giveItemsTo",
  "equipItem",
  "equipLoadout",
  "activateBlock",
  "useOnEntity",
  "useItem",
  "eat",
  "fish",
  "sleepIn",
  "craft",
  "craftMany",
  "smelt",
  "attack",
  "flee",
  "depositToChest",
  "depositManyToChest",
  "withdrawFromChest",
  "withdrawManyFromChest",
  "remember",
  "setTaskQueue",
  "advanceTaskQueue",
] as const;

export const ALLOWED_TOOL_NAMES: readonly string[] = SKILL_NAMES.map(
  (n) => `mcp__${MCP_SERVER_NAME}__${n}`,
);

const goToTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coords"),
    coords: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  }),
  z.object({ kind: z.literal("entity"), entity: z.string() }),
  z.object({ kind: z.literal("block"), block: z.string() }),
]);

const posSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

export function buildSkillsServer(bot: Bot): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    tools: [
      tool(
        "observeSurroundings",
"Look around. Returns nearby blocks (grouped by type with counts and nearest coords), nearby entities (players, mobs, vehicles like boats/minecarts, immobile objects like item frames, dropped items), the bot's status (health, food, position, facing, time of day, weather), known storage from world memory, known utility blocks (crafting tables, furnaces, beds), known waypoints (any other POI you've `remember`-ed — mine entrances, named bases, etc.), recent skill activity, recently-seen players, and the current task queue.",
        { radius: z.number().int().min(1).max(64).optional().describe("Search radius in blocks (default 16)") },
        async (args) => {
          const result = await runSkill(bot, "observeSurroundings", args, (p) =>
            observeSurroundings(bot, p),
          );
          return toToolResult(result);
        },
      ),

      tool(
        "say",
        "Send a message to public chat. Use this to reply to players who addressed you on public chat, and to narrate what you're doing during multi-step tasks. Keep messages short (one or two sentences). Messages over 256 chars are truncated.",
        { message: z.string().min(1) },
        async (args) => toToolResult(await runSkill(bot, "say", args, (p) => say(bot, p))),
      ),

      tool(
        "whisper",
        "Send a private message to a single player. Use this to reply to players who whispered you via /msg. Same length rules as `say`. Fails if the player is not currently online.",
        { player: z.string().min(1), message: z.string().min(1) },
        async (args) => toToolResult(await runSkill(bot, "whisper", args, (p) => whisper(bot, p))),
      ),

      tool(
        "goTo",
        "Pathfind to a target. Pre-checks reachability and fails fast (without committing to a doomed walk) if no path exists. Target is one of: { kind: 'coords', coords: { x, y, z } } | { kind: 'entity', entity: '<player or mob name>' } | { kind: 'block', block: '<block id>' }. Optional `reach` (default 1) sets stop distance in blocks.",
        {
          target: goToTargetSchema,
          reach: z.number().int().min(0).max(16).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "goTo", args, (p) => goTo(bot, p))),
      ),

      tool(
        "stop",
        "Cancel the bot's current movement and any in-flight long-running skill (followPlayer, attack, flee). Safe to call when nothing is in flight. Use when the player says 'stop' or when you decide to abandon a sustained skill mid-task.",
        {},
        async () => toToolResult(await runSkill(bot, "stop", undefined, () => stop(bot))),
      ),

      tool(
        "followPlayer",
        "Follow a player at `dist` blocks of separation, indefinitely, until cancelled. Cancellation fires when the player says 'stop'/'halt'/'wait' (side-channel) or when you call the `stop` skill. Blocks the agent loop — use only when sustained following is what the player actually asked for.",
        {
          player: z.string().min(1),
          dist: z.number().int().min(1).max(16).optional().describe("Follow distance in blocks (default 2)"),
        },
        async (args) => toToolResult(await runSkill(bot, "followPlayer", args, (p) => followPlayer(bot, p))),
      ),

      tool(
        "mineBlock",
        "Mine N blocks of ONE specific type. PREFER `mineBlocks` for prospecting (mining several ore types in one excursion) — that variant scans for any of N types nearest-first and adapts as the bot moves. Reserve `mineBlock` for true single-type gathering (a stack of wood, a count of cobblestone).",
        {
          type: z.string().min(1).describe("Block ID, e.g. 'oak_log', 'stone', 'iron_ore'"),
          count: z.number().int().min(1).max(64).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "mineBlock", args, (p) => mineBlock(bot, p))),
      ),

      tool(
        "mineBlocks",
        "Multi-type mining sweep — the right call for *'mine any ores you can find down there'*. Searches for the nearest instance of ANY type in `types`, walks to it, mines it, repeats until `maxCount` or no candidates remain. Tool-tier preflight per type: types the bot can't harvest are skipped (reported in state.skipped), not fatal — a mixed `[iron_ore, coal_ore, diamond_ore]` request with only a stone pickaxe still gathers iron + coal and tells you why diamond was skipped. Returns state.mined (total) + state.byType (per-type counts).",
        {
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
        async (args) => toToolResult(await runSkill(bot, "mineBlocks", args, (p) => mineBlocks(bot, p))),
      ),

      tool(
        "placeBlock",
        "Place a block of the given type at the target position. Requires the item in inventory and a solid neighbor at one of the six adjacent positions to click against. Fails with a specific message if either is missing. PREFER `placeBlocks` for any multi-block structure — placing one block per tool call costs an LLM round-trip each, so a 30-block wall takes minutes instead of seconds.",
        {
          type: z.string().min(1).describe("Block item ID, e.g. 'cobblestone', 'oak_planks'"),
          position: posSchema,
        },
        async (args) => toToolResult(await runSkill(bot, "placeBlock", args, (p) => placeBlock(bot, p))),
      ),

      tool(
        "placeBlocks",
        "Batch placement — place up to 64 blocks in one tool call. Use this for any contiguous structure (walls, floors, roofs, pillars, paths). One LLM round-trip places the whole batch, then mineflayer paces the placements at ~10 blocks/sec. Cancellable mid-batch via the `stop` skill or chat side-channel. On the first failure, returns ok:false with `state.placed` (how many landed) and `state.failedIndex` so you can re-plan from where it stopped.",
        {
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
        async (args) => toToolResult(await runSkill(bot, "placeBlocks", args, (p) => placeBlocks(bot, p))),
      ),

      tool(
        "pickUpNearby",
        "Walk to and pick up every dropped item within `maxDist` blocks. Use after a mob fight, after dropping items, or whenever you see items in `nearbyDroppedItems` you want to collect. mineBlock already does this internally per-dig, so you usually don't need it after a mining task.",
        { maxDist: z.number().int().min(1).max(32).optional().describe("Search radius in blocks (default 8)") },
        async (args) => toToolResult(await runSkill(bot, "pickUpNearby", args, (p) => pickUpNearby(bot, p))),
      ),

      tool(
        "dropItem",
        "Drop `count` of `item` from inventory onto the ground at the bot's feet. If `count` is omitted, drops every matching stack. Partial-progress is reported in state.dropped on failure.",
        {
          item: z.string().min(1).describe("Item ID, e.g. 'oak_log', 'iron_ingot'"),
          count: z.number().int().min(1).max(2304).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "dropItem", args, (p) => dropItem(bot, p))),
      ),

      tool(
        "giveItemTo",
        "Hand off ONE item type to a player. PREFER `giveItemsTo` for any multi-item handoff (full toolset, full armor set) — that variant walks once and tosses each item in sequence. Reserve `giveItemTo` for true single-item handoffs.",
        {
          player: z.string().min(1),
          item: z.string().min(1),
          count: z.number().int().min(1).max(2304).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "giveItemTo", args, (p) => giveItemTo(bot, p))),
      ),

      tool(
        "giveItemsTo",
        "Hand off SEVERAL items to a player in one walk. One LLM round-trip walks to the player once, looks at them, and tosses each item from `items` in sequence (each `count` defaults to every matching stack). Use for any multi-item ask: 'give me a full iron set', 'drop me food and a pickaxe'. Stops at the first per-item failure and returns state.given[] + state.failedIndex so you can re-plan from where it stopped.",
        {
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
        async (args) => toToolResult(await runSkill(bot, "giveItemsTo", args, (p) => giveItemsTo(bot, p))),
      ),

      tool(
        "checkInventory",
        "Read-only inventory report. Returns a grouped list of every item in main inventory + hotbar + armor + off-hand, with stack counts, durability for tools, and equipped-slot annotations. Call this BEFORE trying to use a specific tool — observeSurroundings only shows the currently-held item, not what else is available.",
        {},
        async () => toToolResult(await runSkill(bot, "checkInventory", undefined, () => checkInventory(bot))),
      ),

      tool(
        "equipItem",
        "Equip ONE item to a slot (default 'hand'). PREFER `equipLoadout` when changing multiple slots at once (full armor set, weapon+shield combo). Most item-use skills (activateBlock, useOnEntity) accept an optional `with` parameter that calls this internally — reach for `equipItem` directly for a single armor / off-hand swap or to set up before a sequence sharing one tool.",
        {
          item: z.string().min(1).describe("Item ID, e.g. 'iron_pickaxe', 'shears', 'iron_helmet'"),
          slot: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"]).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "equipItem", args, (p) => equipItem(bot, p))),
      ),

      tool(
        "equipLoadout",
        "Equip several slots in one call. Pass any subset of {head, torso, legs, feet, hand, offHand}; omitted slots are left alone. One round-trip covers a full armor-up (head+torso+legs+feet) or a combat loadout (hand+offHand). Stops at the first per-slot failure with state.equipped[] + state.failedSlot for re-planning.",
        {
          head: z.string().min(1).optional().describe("Helmet, e.g. 'iron_helmet'"),
          torso: z.string().min(1).optional().describe("Chestplate, e.g. 'iron_chestplate'"),
          legs: z.string().min(1).optional().describe("Leggings, e.g. 'iron_leggings'"),
          feet: z.string().min(1).optional().describe("Boots, e.g. 'iron_boots'"),
          hand: z.string().min(1).optional().describe("Main-hand item, e.g. 'iron_sword'"),
          offHand: z.string().min(1).optional().describe("Off-hand item, e.g. 'shield'"),
        },
        async (args) => toToolResult(await runSkill(bot, "equipLoadout", args, (p) => equipLoadout(bot, p))),
      ),

      tool(
        "activateBlock",
        "Right-click on a block at the given position. Covers hoe → till dirt to farmland, flint_and_steel → ignite, bucket → fill from water/lava source, water_bucket/lava_bucket → place liquid, bone_meal → grow crop, seeds → plant on farmland, doors/trapdoors/levers/buttons → toggle, jukebox → insert disc. Pass `with` to auto-equip the tool first.",
        {
          position: posSchema,
          with: z.string().optional().describe("Item ID to equip to hand before activating (e.g. 'iron_hoe', 'bucket')"),
        },
        async (args) =>
          toToolResult(await runSkill(bot, "activateBlock", args, (p) => activateBlock(bot, p))),
      ),

      tool(
        "useOnEntity",
        "Right-click on an entity (mob or player). Covers shears → sheep (collect wool without killing), bucket → cow (milk), name_tag → entity (rename), dye → sheep (color wool), lead → animal, saddle → horse, glass_bottle → cow (honey/water from sources). Pass `with` to auto-equip the tool first.",
        {
          entity: z.string().min(1).describe("Mob type ('sheep', 'cow', 'pig') or player username"),
          with: z.string().optional().describe("Item ID to equip to hand before using (e.g. 'shears', 'bucket')"),
        },
        async (args) =>
          toToolResult(await runSkill(bot, "useOnEntity", args, (p) => useOnEntity(bot, p))),
      ),

      tool(
        "useItem",
        "Right-click in mid-air with the held item (or off-hand item). Fire-and-forget — does not wait for any animation to complete. Use for: throwing an ender pearl, throwing a splash/lingering potion, starting to charge a bow or crossbow, casting a fishing rod manually (prefer the `fish` skill). DO NOT use for eating food or drinking potions — use the `eat` skill instead, which handles the full activate-then-consume cycle.",
        {
          with: z.string().optional().describe("Item ID to equip first (e.g. 'ender_pearl', 'bow')"),
          offhand: z.boolean().optional().describe("Use the off-hand item instead of main-hand"),
        },
        async (args) => toToolResult(await runSkill(bot, "useItem", args, (p) => useItem(bot, p))),
      ),

      tool(
        "eat",
        "Eat food. Composite: equip the food → call bot.consume which handles the activate-then-finish cycle. When `item` is omitted, picks the best available food from inventory (cooked > raw, higher saturation first). Won't eat when food is already 20/20 unless an explicit `item` was passed.",
        {
          item: z.string().optional().describe("Specific food item; omit to auto-pick best from inventory"),
        },
        async (args) => toToolResult(await runSkill(bot, "eat", args, (p) => eat(bot, p))),
      ),

      tool(
        "fish",
        "Cast a fishing rod and wait for a bite. Requires fishing_rod in main-hand (equipItem first if needed) and water within casting range. Cancellable via the `stop` skill or the chat side-channel — reels in early on cancel. Times out after 5 minutes with no bite.",
        {},
        async () => toToolResult(await runSkill(bot, "fish", undefined, () => fish(bot))),
      ),

      tool(
        "sleepIn",
        "Sleep in a bed. Bed resolution: caller-supplied `pos` → nearest *_bed within 32 blocks → nearest remembered bed POI from world memory. Walks within reach, then calls bot.sleep. Vanilla preconditions apply: must be night (or thunderstorm), bed not obstructed; mineflayer's error messages surface as-is.",
        {
          pos: posSchema.optional().describe("Explicit bed position; omit to auto-find"),
        },
        async (args) => toToolResult(await runSkill(bot, "sleepIn", args, (p) => sleepIn(bot, p))),
      ),

      tool(
        "craft",
        "Craft ONE recipe (item × count). PREFER `craftMany` for any multi-recipe ask (full toolset, full armor set, sticks+planks+chest in one go) — that variant walks to a table at most once and runs each recipe in order. Reserve `craft` for true single-recipe asks.",
        {
          item: z.string().min(1).describe("Item ID, e.g. 'oak_planks', 'iron_pickaxe'"),
          count: z.number().int().min(1).max(64).optional(),
          tablePos: posSchema.optional().describe("Explicit crafting table position; omit to auto-find"),
        },
        async (args) => toToolResult(await runSkill(bot, "craft", args, (p) => craft(bot, p))),
      ),

      tool(
        "craftMany",
        "Craft SEVERAL recipes in one call. The table is resolved lazily — if every item has a 2×2 recipe, no table walk happens; otherwise the bot walks once on the first 3×3 recipe and stays there for the rest. ORDER MATTERS: earlier crafts consume ingredients later ones may need (sticks → pickaxe → sword is fine; sword → pickaxe → sticks isn't). On per-item failure (shortfall, no recipe, etc.) returns state.crafted[] + state.failedIndex so you can re-plan from that point.",
        {
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
        async (args) => toToolResult(await runSkill(bot, "craftMany", args, (p) => craftMany(bot, p))),
      ),

      tool(
        "smelt",
        "Smelt `count` of `input` in a furnace. Composite: resolve furnace (caller-supplied → nearby 32 blocks → nearest remembered furnace POI), walk to it, put input + fuel, wait for output, take it. Fuel is auto-picked from inventory when omitted (prefers coal → charcoal → coal_block → blaze_rod → dried_kelp_block). Closes the iron-armor loop: mine raw_iron → smelt → craft.",
        {
          input: z.string().min(1).describe("Item ID to smelt, e.g. 'raw_iron', 'raw_copper', 'sand', 'beef'"),
          fuel: z.string().optional().describe("Fuel item ID; omit to auto-pick best fuel from inventory"),
          count: z.number().int().min(1).max(64).optional().describe("How many to smelt (default 1)"),
          furnacePos: posSchema.optional().describe("Explicit furnace position; omit to auto-find"),
        },
        async (args) => toToolResult(await runSkill(bot, "smelt", args, (p) => smelt(bot, p))),
      ),

      tool(
        "attack",
        "Attack `entity` (a mob name like 'zombie' or a player username) in melee. Equips the best available weapon, paths into range, swings on cooldown. Blocking; exits when the target dies, leaves visibility, or cancellation is requested (player says 'stop' / `stop` skill).",
        { entity: z.string().min(1) },
        async (args) => toToolResult(await runSkill(bot, "attack", args, (p) => attack(bot, p))),
      ),

      tool(
        "flee",
        "Run away from `from` (a mob name or player username) until `dist` blocks of separation, or cancellation. Re-paths every ~1.5s so a chasing threat doesn't end up running alongside the bot.",
        {
          from: z.string().min(1),
          dist: z.number().int().min(1).max(64).optional().describe("Target separation in blocks (default 16)"),
        },
        async (args) => toToolResult(await runSkill(bot, "flee", args, (p) => flee(bot, p))),
      ),

      tool(
        "depositToChest",
        "Deposit ONE item type into a chest. PREFER `depositManyToChest` when stashing several item types into the same chest (post-mining haul, cleanup runs) — that variant opens the chest once and runs each deposit in sequence. Reserve `depositToChest` for true single-item stashes.",
        {
          item: z.string().min(1).describe("Item ID to deposit"),
          count: z.number().int().min(1).max(2304).optional(),
          pos: posSchema.optional().describe("Explicit chest position; omit to use nearest known container"),
        },
        async (args) =>
          toToolResult(await runSkill(bot, "depositToChest", args, (p) => depositToChest(bot, p))),
      ),

      tool(
        "depositManyToChest",
        "Deposit SEVERAL item types into one chest in a single trip. Walks + opens + closes once; each item's `count` defaults to every matching stack. Container auto-capture snapshots on close, so memory updates once per batch (not once per item). Stops at first per-item failure with state.deposited[] + state.failedIndex.",
        {
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
        async (args) =>
          toToolResult(await runSkill(bot, "depositManyToChest", args, (p) => depositManyToChest(bot, p))),
      ),

      tool(
        "withdrawFromChest",
        "Withdraw ONE item type from a chest. PREFER `withdrawManyFromChest` when pulling several item types out of the same chest. Reserve this for true single-item pulls.",
        {
          item: z.string().min(1).describe("Item ID to withdraw"),
          count: z.number().int().min(1).max(2304).optional(),
          pos: posSchema.optional().describe("Explicit chest position; omit to use nearest known container with the item"),
        },
        async (args) =>
          toToolResult(await runSkill(bot, "withdrawFromChest", args, (p) => withdrawFromChest(bot, p))),
      ),

      tool(
        "withdrawManyFromChest",
        "Withdraw SEVERAL item types from one chest in a single trip. Walks + opens + closes once. When `pos` is omitted, finds the chest by the FIRST requested item (so all items should live in the same chest — split into multiple calls if they span chests). Each per-item count is clamped to what's actually in the chest; partial pulls land in the success message rather than failing. Stops only on a per-item zero-stock or transfer error: state.withdrawn[] + state.failedIndex.",
        {
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
        async (args) =>
          toToolResult(await runSkill(bot, "withdrawManyFromChest", args, (p) => withdrawManyFromChest(bot, p))),
      ),

      tool(
        "remember",
        "Record a named place into the bot's durable world knowledge (data/orchestrator/memory/<bot>/world.json). Use when a player names a location: 'this is the base', 'call this the wheat farm'. Position defaults to the bot's current location. Idempotent on (type, position).",
        {
          type: z.string().min(1).describe("Classification: 'base', 'portal', 'bed', 'crafting_table', 'home', etc."),
          name: z.string().optional(),
          pos: posSchema.optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "remember", args, (p) => remember(bot, p))),
      ),

      tool(
        "setTaskQueue",
        "Declare a multi-step plan. The first task becomes the current task; the rest are queued. The current and remaining tasks appear in every `observeSurroundings` call, so you do not need to remember them from chat history. Use for chained requests: 'get wood, then iron, then come back'.",
        { tasks: z.array(z.string().min(1)).min(1) },
        async (args) =>
          toToolResult(await runSkill(bot, "setTaskQueue", args, (p) => setTaskQueue(bot, p))),
      ),

      tool(
        "advanceTaskQueue",
        "Mark the current task done and promote the next one. Returns 'task queue drained' when nothing remains. Call between steps of a `setTaskQueue` plan.",
        {},
        async () =>
          toToolResult(await runSkill(bot, "advanceTaskQueue", undefined, () => advanceTaskQueue(bot))),
      ),
    ],
  });
}

function toToolResult(result: SkillResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: result.ok,
          message: result.message,
          ...(result.state ? { state: result.state } : {}),
        }),
      },
    ],
    isError: !result.ok,
  };
}
