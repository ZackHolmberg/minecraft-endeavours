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
  depositToChest,
  dropItem,
  equipItem,
  flee,
  followPlayer,
  giveItemTo,
  goTo,
  mineBlock,
  observeSurroundings,
  pickUpNearby,
  placeBlock,
  remember,
  say,
  setTaskQueue,
  smelt,
  stop,
  useOnEntity,
  whisper,
  withdrawFromChest,
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
  "placeBlock",
  "pickUpNearby",
  "dropItem",
  "giveItemTo",
  "equipItem",
  "activateBlock",
  "useOnEntity",
  "craft",
  "smelt",
  "attack",
  "flee",
  "depositToChest",
  "withdrawFromChest",
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
        "Look around. Returns nearby blocks (grouped by type with counts and nearest coords), nearby entities (players, mobs, dropped items), the bot's status (health, food, position, facing, time of day, weather), known storage from world memory, recent skill activity, recently-seen players, and the current task queue.",
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
        "Mine N blocks of a specific type. Composite: find → path → equip best tool → dig → sweep dropped items. Fails fast (before any movement) if the required tool tier isn't in inventory. Partial progress is reported in state.mined on failure.",
        {
          type: z.string().min(1).describe("Block ID, e.g. 'oak_log', 'stone', 'iron_ore'"),
          count: z.number().int().min(1).max(64).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "mineBlock", args, (p) => mineBlock(bot, p))),
      ),

      tool(
        "placeBlock",
        "Place a block of the given type at the target position. Requires the item in inventory and a solid neighbor at one of the six adjacent positions to click against. Fails with a specific message if either is missing.",
        {
          type: z.string().min(1).describe("Block item ID, e.g. 'cobblestone', 'oak_planks'"),
          position: posSchema,
        },
        async (args) => toToolResult(await runSkill(bot, "placeBlock", args, (p) => placeBlock(bot, p))),
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
        "Walk within drop range of a player, face them, and toss the item so the natural pickup radius pulls it in. Composite: goTo(player) → lookAt → dropItem. Fails if the player isn't visible, can't be reached, or the bot doesn't have the item.",
        {
          player: z.string().min(1),
          item: z.string().min(1),
          count: z.number().int().min(1).max(2304).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "giveItemTo", args, (p) => giveItemTo(bot, p))),
      ),

      tool(
        "checkInventory",
        "Read-only inventory report. Returns a grouped list of every item in main inventory + hotbar + armor + off-hand, with stack counts, durability for tools, and equipped-slot annotations. Call this BEFORE trying to use a specific tool — observeSurroundings only shows the currently-held item, not what else is available.",
        {},
        async () => toToolResult(await runSkill(bot, "checkInventory", undefined, () => checkInventory(bot))),
      ),

      tool(
        "equipItem",
        "Equip an item from inventory to a slot. Slot defaults to 'hand'. Most item-use skills (activateBlock, useOnEntity) accept an optional `with` parameter that calls this internally — use equipItem directly when you need to equip armor or off-hand items, or to set up before a sequence of skills that all use the same tool.",
        {
          item: z.string().min(1).describe("Item ID, e.g. 'iron_pickaxe', 'shears', 'iron_helmet'"),
          slot: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"]).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "equipItem", args, (p) => equipItem(bot, p))),
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
        "craft",
        "Craft `count` of `item`. Composite: resolve a recipe, walk to a crafting table if the recipe needs one (2×2 recipes use inventory; 3×3 need a table), call bot.craft. Table resolution order: caller-supplied `tablePos` → crafting_table within 32 blocks → nearest remembered crafting_table from world memory. Failure messages name the missing ingredient and shortfall count.",
        {
          item: z.string().min(1).describe("Item ID, e.g. 'oak_planks', 'iron_pickaxe'"),
          count: z.number().int().min(1).max(64).optional(),
          tablePos: posSchema.optional().describe("Explicit crafting table position; omit to auto-find"),
        },
        async (args) => toToolResult(await runSkill(bot, "craft", args, (p) => craft(bot, p))),
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
        "Walk to a chest and deposit items. When `pos` is omitted, picks the nearest known container from world memory. When `count` is omitted, deposits every matching stack in inventory. Container auto-capture snapshots the chest's new contents into world memory automatically.",
        {
          item: z.string().min(1).describe("Item ID to deposit"),
          count: z.number().int().min(1).max(2304).optional(),
          pos: posSchema.optional().describe("Explicit chest position; omit to use nearest known container"),
        },
        async (args) =>
          toToolResult(await runSkill(bot, "depositToChest", args, (p) => depositToChest(bot, p))),
      ),

      tool(
        "withdrawFromChest",
        "Walk to a chest and withdraw items. When `pos` is omitted, picks the nearest known container whose remembered contents include the requested item. Verifies the chest actually has the item on open and adjusts the take count if memory was stale.",
        {
          item: z.string().min(1).describe("Item ID to withdraw"),
          count: z.number().int().min(1).max(2304).optional(),
          pos: posSchema.optional().describe("Explicit chest position; omit to use nearest known container with the item"),
        },
        async (args) =>
          toToolResult(await runSkill(bot, "withdrawFromChest", args, (p) => withdrawFromChest(bot, p))),
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
