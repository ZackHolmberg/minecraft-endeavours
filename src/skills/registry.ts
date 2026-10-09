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
 *  - `claude`   — exposed to ClaudeBackend (all 36; preserves today's surface).
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
  getItems,
  giveItemsTo,
  giveItemTo,
  goTo,
  mineBlock,
  mineBlocks,
  observeSurroundings,
  pillarUp,
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
  /** Exposed to ClaudeBackend. All 36 today — preserves current behavior. */
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
      "Full look around: nearby blocks (by type, with counts and nearest coords), entities (players, mobs, dropped items), your status (health, food, position, time, weather), known storage / utility blocks / waypoints, recent actions, and the task queue. A summary of this is already attached to every player message — call this only after you've moved or changed things and need fresh data, or need a wider radius.",
    schema: {
      radius: z.number().int().min(1).max(64).optional().describe("Search radius in blocks (default 16)"),
    },
    run: withParams("observeSurroundings", observeSurroundings),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "checkInventory",
    description:
      "Detailed inventory: every item with counts, tool durability, and what's equipped in armor / off-hand slots. Item counts are already in the world snapshot on each message; call this when you need durability or equipment details, or fresh counts after a lot of crafting/mining.",
    schema: {},
    run: noParams("checkInventory", checkInventory),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "getItems",
    description:
      "CREATIVE MODE ONLY: instantly take items from the creative inventory — how you get building materials, tools, food, anything, in creative. Tops up to at least `count` of each (default one full stack; 64 for most blocks), hotbar first. One call for a whole build's palette, e.g. [{ name: 'oak_planks', count: 192 }, { name: 'glass_pane' }, { name: 'oak_door', count: 1 }]. Fails in survival — gather or craft there instead. If the inventory fills up, returns ok:false with state.missing.",
    schema: {
      items: z
        .array(
          z.object({
            name: z.string().min(1).describe("Item ID, e.g. 'stone_bricks', 'oak_door'"),
            count: z.number().int().min(1).max(2304).optional().describe("Total you want to hold (default one stack)"),
          }),
        )
        .min(1)
        .max(36),
    },
    run: withParams("getItems", getItems),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "say",
    description:
      "Say something in public chat — the ONLY way players hear you (besides whisper). Use it to reply to public-chat messages. Write like a friendly player: one short casual line, plain text, no markdown. Don't narrate each step of a task; ack, then report the result. Max 256 chars.",
    schema: { message: z.string().min(1) },
    run: withParams("say", say),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "whisper",
    description:
      "Private message to one player. Use it to reply when a player whispered you (/msg). Same style as say: one short casual line. Fails if the player is offline.",
    schema: { player: z.string().min(1), message: z.string().min(1) },
    run: withParams("whisper", whisper),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "goTo",
    description:
      "Walk to a target. Target is one of: { kind: 'coords', coords: { x, y, z } } | { kind: 'entity', entity: '<player or mob name>' } | { kind: 'block', block: '<block id>' }. Optional `reach` (default 1) is the stop distance. Wooden doors, fence gates and the like open automatically on the way (iron doors and trapdoors don't). It never digs through blocks and never places any (no bridging, no stairs, no towering up): if the only way is over a gap, up a cliff or through a wall, you get a no-path error, returning state.position. Gives up within ~20s if stuck. If you can't reach a spot inside a building, goTo its door or ask the player — never mine or place blocks to get in.",
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
      "Stop moving and cancel whatever is running (following, fighting, fleeing, fishing, walking, mining, placing, smelting, pillaring). Safe anytime. Use when a player says stop or to abandon a task.",
    schema: {},
    run: noParams("stop", stop),
    surfaces: EXECUTOR,
  },
  {
    name: "followPlayer",
    description:
      "Follow a player at `dist` blocks (default 3), indefinitely, until they say stop (or you call stop). It doesn't return until then, so use it only when the player asked you to follow them — for 'come here' use goTo with the player as the target instead.",
    schema: {
      player: z.string().min(1),
      dist: z.number().int().min(1).max(16).optional().describe("Follow distance in blocks (default 3)"),
    },
    run: withParams("followPlayer", followPlayer),
    surfaces: EXECUTOR,
  },
  {
    name: "mineBlock",
    description:
      "Gather `count` blocks of ONE natural block type (nearest first) and pick up the drops. Success is counted by what actually lands in your inventory: it keeps going until you have `count` of the drop (or nothing reachable is left) and reports e.g. 'collected 10 oak_log (mined 11)'; use that number. It stands on the ground and takes only blocks within arm's reach (about 4 high), skipping unreachable ones (e.g. the top of a tall tree) and moving to the next; it may tunnel a short way through natural blocks to a buried target, never through player-built ones. For cobblestone, mine 'stone'. Blocks that look player-built are left alone (reported in the result) — don't retry with allowStructures unless a player asked you to demolish that thing. For several ore types in one trip use mineBlocks. In creative it only clears blocks (instant, no drops) — use getItems for materials.",
    schema: {
      type: z.string().min(1).describe("Block ID, e.g. 'oak_log', 'stone', 'iron_ore'"),
      count: z.number().int().min(1).max(64).optional(),
      allowStructures: z
        .boolean()
        .optional()
        .describe(
          "Also mine blocks that look player-built (house walls, doors, glass). ONLY when a player explicitly asked you to demolish/remove them.",
        ),
    },
    run: withParams("mineBlock", mineBlock),
    surfaces: EXECUTOR,
  },
  {
    name: "mineBlocks",
    description:
      "Mine several natural block types in one sweep, nearest first, until `maxCount` total is collected or nothing reachable is left in range — e.g. ['iron_ore', 'coal_ore', 'diamond_ore'] for 'mine any ores you find'. Types your tools can't harvest are skipped and reported in state.skipped (not fatal). Like mineBlock it counts what actually lands in your inventory (the drop, e.g. iron_ore gives raw_iron) until `maxCount` total, and returns state.collected, state.gained (by item), state.mined (blocks dug) and state.byType. It leaves player-built blocks alone unless allowStructures is set (demolition requests only).",
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
      allowStructures: z
        .boolean()
        .optional()
        .describe(
          "Also mine blocks that look player-built (house walls, doors, glass). ONLY when a player explicitly asked you to demolish/remove them.",
        ),
    },
    run: withParams("mineBlocks", mineBlocks),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "placeBlock",
    description:
      "Place ONE block at a position (needs the item in inventory and a solid block next to the target to place against). Use for one-offs like a door, torch or crafting table. For anything bigger use placeBlocks — one block per call is very slow.",
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
      "Place up to 64 blocks in one call — use it for any structure (floor, wall course, roof, staircase, path). Make sure you have enough of each block first. Order matters: list blocks so each one has something solid next to it (ground up). On the first failure returns ok:false with state.placed (how many landed) and state.failedIndex — fix the problem and continue from there; don't re-place what landed. In creative it takes missing blocks from the creative inventory and flies to spots out of reach.",
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
    name: "pillarUp",
    description:
      "Climb straight up by jump-placing filler blocks (cobblestone/dirt/stone) under yourself — to get out of a hole, onto a ledge, or up to a tree top. Needs filler in inventory, solid ground, headroom. Cancellable. Returns state.placed and the final position. Only when genuinely needed — never as a way to travel; walk or build stairs instead.",
    schema: {
      height: z.number().int().min(1).max(32),
    },
    run: withParams("pillarUp", pillarUp),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "pickUpNearby",
    description:
      "Walk over and pick up dropped items within `maxDist` blocks (e.g. after a fight). mineBlock / mineBlocks already collect their drops (and report what they collected), so you rarely need this after mining; it reports the items actually picked up.",
    schema: {
      maxDist: z.number().int().min(1).max(32).optional().describe("Search radius in blocks (default 8)"),
    },
    run: withParams("pickUpNearby", pickUpNearby),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "dropItem",
    description:
      "Drop `count` of `item` at your feet (all of it if `count` is omitted). To hand items to a player, use giveItemsTo instead — it walks to them first.",
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
      "Walk to a player and toss them ONE item type. For several item types use giveItemsTo (one walk).",
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
      "Walk to a player once and toss them several items ('give me a full iron set', 'bring me food and a pickaxe'). Each `count` defaults to all you have of that item. Stops at the first failure with state.given and state.failedIndex.",
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
      "Equip ONE item to a slot (default 'hand'). For several slots at once (armor set, sword + shield) use equipLoadout. activateBlock / useOnEntity / useItem take a `with` param that equips for you, so you rarely need this for tools.",
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
      "Equip several slots in one call — any of head, torso, legs, feet, hand, offHand; omitted slots are untouched. Use for putting on armor or a sword + shield. Stops at the first failure with state.equipped and state.failedSlot.",
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
      "Right-click a block. With `with` it equips that item first. Uses: hoe on dirt → farmland; seeds on farmland → plant; bone_meal on a crop; bucket on water/lava → fill; water_bucket → place water; flint_and_steel → light fire; no `with` on a door/trapdoor/gate/lever/button → open, close or toggle it.",
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
      "Right-click a mob or player. With `with` it equips that item first. Uses: shears on sheep → wool (no killing); bucket on cow → milk; lead, name_tag, saddle, dye on the right animal.",
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
      "Right-click in the air with the held (or off-hand) item — only for throwables and bows: ender pearls, splash/lingering potions, charging a bow. Never for food (use eat) or fishing (use fish).",
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
      "Eat food. Omit `item` to pick the best food you have (cooked first). Won't eat at full hunger unless you name an item. You also auto-eat when hungry; call this only when asked or before a fight.",
    schema: {
      item: z.string().optional().describe("Specific food item; omit to auto-pick best from inventory"),
    },
    run: withParams("eat", eat),
    surfaces: EXECUTOR,
  },
  {
    name: "fish",
    description:
      "Cast and wait for one catch. Needs a fishing_rod in hand (equipItem it first) and water in front of you. Stops early if a player says stop; gives up after 5 minutes.",
    schema: {},
    run: noParams("fish", fish),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "sleepIn",
    description:
      "Sleep in a bed: the one at `pos`, else the nearest bed within 32 blocks, else a remembered bed. Walks there first. Only works at night or in a thunderstorm.",
    schema: {
      pos: posSchema.optional().describe("Explicit bed position; omit to auto-find"),
    },
    run: withParams("sleepIn", sleepIn),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "craft",
    description:
      "Craft ONE recipe. Ingredients must be in your inventory; it finds and walks to a crafting table itself (nearby or remembered) when the recipe needs one. `count` is the number of items wanted; rounded up to the recipe's batch size (e.g. planks come in 4s). If no crafting_table is within 32 blocks, places one from inventory or crafts one from 4 planks automatically. On failure the message says what's missing — gather it, then retry. For several recipes use craftMany. In creative, use getItems instead.",
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
      "Craft several recipes in order, in one call — e.g. [oak_planks, stick, crafting_table, wooden_pickaxe]. ORDER MATTERS: list ingredients before the things made from them (planks → sticks → pickaxe). Walks to a crafting table at most once. `count` is the number of items wanted; rounded up to the recipe's batch size (e.g. planks come in 4s). If no crafting_table is within 32 blocks, places one from inventory or crafts one from 4 planks automatically. On failure returns state.crafted and state.failedIndex with what was missing — fix that and continue from there.",
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
      "Smelt `count` of `input` (e.g. raw_iron → iron_ingot, beef → cooked_beef, sand → glass). Finds a furnace (nearby or remembered), walks there, waits, and takes the output. Picks a furnace type that fits the input (smoker = food, blast_furnace = ores) and places a carried furnace if none is nearby. Leave `fuel` out — it picks coal/charcoal first and falls back to planks/logs; prefer mining coal_ore over burning wood. Max 64 per call. Cancellable via stop.",
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
      "Melee-attack `entity` (a mob type like 'zombie', or a player name) with your best weapon until it dies, gets away, or a player says stop. Gives up after 90s, or after 20s unable to reach the target; breaks off vs mobs at ≤6 health. Only attack players, pets or villagers if a player explicitly asked.",
    schema: { entity: z.string().min(1) },
    run: withParams("attack", attack),
    surfaces: EXECUTOR,
  },
  {
    name: "flee",
    description:
      "Run from `from` (a mob type or player name) until `dist` blocks away. Use when health is low or a fight is hopeless. Gives up after 45s if it can't get away.",
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
      "Put ONE item type into a chest (nearest known one unless `pos` is given). For several item types use depositManyToChest. Without `pos`, uses the nearest chest within 16 blocks or a remembered one.",
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
      "Put several item types into one chest in a single trip; each `count` defaults to all you have. Stops at the first failure with state.deposited and state.failedIndex. Without `pos`, uses the nearest chest within 16 blocks or a remembered one.",
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
      "Take ONE item type out of a chest (the known chest holding it unless `pos` is given). For several item types use withdrawManyFromChest. Without `pos`, uses the nearest chest within 16 blocks or a remembered one.",
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
      "Take several item types out of ONE chest in a single trip. Without `pos` the chest is chosen by the FIRST item, so only group items stored in the same chest. Counts are capped at what's there (partial pulls succeed). Stops if an item is missing entirely: state.withdrawn and state.failedIndex. Without `pos`, uses the nearest chest within 16 blocks or a remembered one.",
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
      "Remember a named place permanently (it appears under known waypoints/utilities from then on). Use when a player names a spot ('this is the base', 'call this the wheat farm') and at the surface before going underground (type 'mine_entrance'). Position defaults to where you stand.",
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
      "Set a plan of short, concrete steps with counts (e.g. ['mine 16 oak_log', 'craft wooden_pickaxe', 'mine 8 stone', 'give pickaxe to Alex']). Replaces any existing plan. The current and remaining steps show up in your world snapshot every message. Use for any job with 3+ steps.",
    schema: { tasks: z.array(z.string().min(1)).min(1) },
    run: withParams("setTaskQueue", setTaskQueue),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "advanceTaskQueue",
    description:
      "Mark the current plan step done and move to the next. Call right after finishing each step. When it reports the queue is drained, tell the player you're done.",
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
