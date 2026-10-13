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
import { achieve, build, cancelJob, find, followPlayer as followPlayerJob, surviveNight } from "../jobs/tools.js";
import { pixelArt } from "../pixelart/skill.js";
import { runSkill, type RunSkillOptions } from "./harness.js";
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
  opts?: RunSkillOptions,
): (bot: Bot, args: unknown) => Promise<SkillResult> {
  return (bot, args) => runSkill(bot, name, args, (p) => fn(bot, p as P), opts);
}

function noParams(
  name: string,
  fn: (bot: Bot) => Promise<SkillResult>,
  opts?: RunSkillOptions,
): (bot: Bot, args: unknown) => Promise<SkillResult> {
  return (bot) => runSkill(bot, name, undefined, () => fn(bot), opts);
}

/**
 * Read-only / conversational / job-control tools: they never clear the stop
 * flag or overwrite the current-tool slot, so they are safe to call while a
 * v2 job step runs (keep in sync with JOB_EXEMPT_TOOLS in jobs/tools.ts).
 */
const READ_ONLY: RunSkillOptions = { readOnly: true };

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
    run: withParams("observeSurroundings", observeSurroundings, READ_ONLY),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "checkInventory",
    description:
      "Detailed inventory: every item with counts, tool durability, and what's equipped in armor / off-hand slots. Item counts are already in the world snapshot on each message; call this when you need durability or equipment details, or fresh counts after a lot of crafting/mining.",
    schema: {},
    run: noParams("checkInventory", checkInventory, READ_ONLY),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "getItems",
    description:
      "CREATIVE ONLY (fails in survival): take items from the creative inventory. Tops up to at least `count` of each (default one stack), hotbar first. One call for a whole palette, e.g. [{ name: 'oak_planks', count: 192 }, { name: 'glass_pane' }]. If the inventory fills up, returns ok:false with state.missing.",
    schema: {
      items: z
        .array(
          z.object({
            name: z.string().min(1).describe("Item ID, e.g. 'stone_bricks', 'oak_door'"),
            count: z.number().int().min(1).max(2304).optional().describe("Amount to hold (default one stack)"),
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
      "Say something in public chat: the ONLY way players hear you (besides whisper). One short casual line, plain text, no markdown. Ack, then report the result; don't narrate steps. Max 256 chars.",
    schema: { message: z.string().min(1) },
    run: withParams("say", say, READ_ONLY),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "whisper",
    description:
      "Private message to one player, for replying to a whisper (/msg). Same style as say. Fails if they're offline.",
    schema: { player: z.string().min(1), message: z.string().min(1) },
    run: withParams("whisper", whisper, READ_ONLY),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "goTo",
    description:
      "Walk to a target: { kind: 'coords', coords: {x,y,z} } | { kind: 'entity', entity: '<player or mob>' } | { kind: 'block', block: '<block id>' }. `reach` (default 1) is the stop distance. Wooden doors and fence gates open on the way (iron doors/trapdoors don't). Never digs or places blocks (no bridging, stairs or towering): over a gap, cliff or wall you get a no-path error with state.position. Gives up after ~20s if stuck. To get into a building, goTo its door or ask the player.",
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
      "Stop moving and cancel whatever is running (following, fighting, walking, mining, placing, smelting, jobs). Safe anytime; use when a player says stop.",
    schema: {},
    run: noParams("stop", stop),
    surfaces: EXECUTOR,
  },
  {
    name: "followPlayer",
    description:
      "Follow a player at `dist` blocks (default 3) until they say stop (or you call stop/cancelJob), max 30 minutes. Background job: returns at once, so reply briefly and end your turn. It keeps running while they chat: answer with say/whisper only (movement/mining/crafting tools cancel it). If they leave view it searches ~45s, then sends [job failed]. Only when asked to follow; for 'come here' use goTo.",
    schema: {
      player: z.string().min(1),
      dist: z.number().int().min(1).max(16).optional().describe("Follow distance in blocks (default 3)"),
    },
    run: withParams("followPlayer", followPlayerJob, READ_ONLY),
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
        .describe("Also mine player-built blocks. ONLY when a player explicitly asked to demolish them."),
    },
    run: withParams("mineBlock", mineBlock),
    surfaces: EXECUTOR,
  },
  {
    name: "mineBlocks",
    description:
      "Mine natural blocks, nearest first, until `maxCount` total (default 32, max 128) is in your inventory or nothing reachable is left. `types` is one block ('oak_log'; mine 'stone' for cobblestone) or several for 'any ores' trips (['iron_ore','coal_ore']). Counts what actually lands in your inventory (e.g. 'collected 10 oak_log (mined 11)'): trust that number; also returns state.collected, gained, mined, byType. Takes only blocks within arm's reach from the ground (about 4 up a tree), may tunnel a short way through natural blocks, skips types your tools can't harvest (state.skipped). Leaves player-built blocks alone unless allowStructures (demolition requests only). Creative: only clears blocks, use getItems.",
    schema: {
      types: z
        .array(z.string().min(1))
        .min(1)
        .describe("Block IDs, e.g. ['oak_log'] or ['iron_ore', 'coal_ore']"),
      maxCount: z
        .number()
        .int()
        .min(1)
        .max(128)
        .optional()
        .describe("Total across all types (default 32)"),
      maxDistance: z
        .number()
        .int()
        .min(1)
        .max(128)
        .optional()
        .describe("Search radius (default 64)"),
      allowStructures: z
        .boolean()
        .optional()
        .describe("Also mine player-built blocks. ONLY when a player explicitly asked to demolish them."),
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
      "Place up to 64 blocks in one call (a single block too): floors, wall courses, roofs, stairs, paths. You must hold enough of each block. List them ground-up so each has something solid beside it. On the first failure returns ok:false with state.placed and state.failedIndex: fix it and continue from there. Creative: takes missing blocks itself and flies to out-of-reach spots.",
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
      "Climb straight up by jump-placing filler blocks (cobblestone/dirt/stone) under you: out of a hole, onto a ledge, up to a tree top. Needs filler, solid ground, headroom. Cancellable. Only when genuinely needed, never to travel.",
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
      "Drop `count` of `item` at your feet (all if omitted). To hand items to a player use giveItemsTo.",
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
      "Walk to a player once and toss them one or several items ('give me a full iron set'). Each `count` defaults to all you have. Stops at the first failure with state.given and state.failedIndex.",
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
      "Equip ONE item to a slot (default 'hand'). activateBlock/useOnEntity/useItem take a `with` param that equips for you, so you rarely need this for tools.",
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
      "Right-click a block; `with` equips that item first. Hoe on dirt → farmland; seeds on farmland → plant; bone_meal on a crop; bucket on water/lava → fill; water_bucket → place water; flint_and_steel → light fire; no `with` on a door/trapdoor/gate/lever/button → toggle it.",
    schema: {
      position: posSchema,
      with: z.string().optional().describe("Item to equip first (e.g. 'iron_hoe')"),
    },
    run: withParams("activateBlock", activateBlock),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "useOnEntity",
    description:
      "Right-click a mob or player; `with` equips that item first. Shears on sheep → wool (no killing); bucket on cow → milk; lead, name_tag, saddle, dye.",
    schema: {
      entity: z.string().min(1).describe("Mob type ('sheep', 'cow', 'pig') or player username"),
      with: z.string().optional().describe("Item to equip first (e.g. 'shears')"),
    },
    run: withParams("useOnEntity", useOnEntity),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "useItem",
    description:
      "Right-click in the air with the held (or off-hand) item: only throwables and bows (ender pearls, splash potions, charging a bow). Never for food (eat) or fishing (fish).",
    schema: {
      with: z.string().optional().describe("Item to equip first"),
      offhand: z.boolean().optional().describe("Use the off-hand item instead of main-hand"),
    },
    run: withParams("useItem", useItem),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "eat",
    description:
      "Eat food; omit `item` to pick the best you have. Won't eat at full hunger unless you name an item. You auto-eat when hungry, so call this only when asked or before a fight.",
    schema: {
      item: z.string().optional().describe("Food item (default: best you have)"),
    },
    run: withParams("eat", eat),
    surfaces: EXECUTOR,
  },
  {
    name: "fish",
    description:
      "Cast and wait for one catch. Needs a fishing_rod in hand (equipItem it) and water ahead. Stops if a player says stop; gives up after 5 minutes.",
    schema: {},
    run: noParams("fish", fish),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "sleepIn",
    description:
      "Sleep in a bed: the one at `pos`, else the nearest within 32 blocks, else a remembered one. Walks there first. Only at night or in a thunderstorm.",
    schema: {
      pos: posSchema.optional().describe("Bed position (default: auto-find)"),
    },
    run: withParams("sleepIn", sleepIn),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "craft",
    description:
      "Craft ONE recipe from your inventory; finds (or places/crafts) a crafting table itself when the recipe needs one. `count` = items wanted, rounded up to the recipe batch (planks come in 4s). On failure the message says what's missing: gather it, then retry. Creative: use getItems.",
    schema: {
      item: z.string().min(1).describe("Item ID, e.g. 'oak_planks', 'iron_pickaxe'"),
      count: z.number().int().min(1).max(64).optional(),
      tablePos: posSchema.optional().describe("Crafting table position (default: auto-find)"),
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
      tablePos: posSchema.optional().describe("Crafting table position (default: auto-find)"),
    },
    run: withParams("craftMany", craftMany),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "smelt",
    description:
      "Smelt `count` (max 64) of `input` (raw_iron → iron_ingot, beef → cooked_beef, sand → glass). Finds or places a furnace, waits, takes the output; picks the furnace type (smoker = food, blast_furnace = ores). Leave `fuel` out: it uses coal/charcoal, then planks/logs. Cancellable via stop.",
    schema: {
      input: z.string().min(1).describe("Item to smelt, e.g. 'raw_iron', 'sand'"),
      fuel: z.string().optional().describe("Fuel (default: auto)"),
      count: z.number().int().min(1).max(64).optional().describe("How many to smelt (default 1)"),
      furnacePos: posSchema.optional().describe("Furnace position (default: auto-find)"),
    },
    run: withParams("smelt", smelt),
    surfaces: EXECUTOR,
  },
  {
    name: "attack",
    description:
      "Melee-attack `entity` (mob type like 'zombie', or a player name) with your best weapon until it dies, escapes or a player says stop. Gives up after 90s, or 20s unable to reach it; breaks off vs mobs at 6 health or less. Players, pets, villagers only if a player explicitly asked.",
    schema: { entity: z.string().min(1) },
    run: withParams("attack", attack),
    surfaces: EXECUTOR,
  },
  {
    name: "flee",
    description:
      "Run from `from` (mob type or player name) until `dist` blocks away. For low health or a hopeless fight. Gives up after 45s.",
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
      pos: posSchema.optional().describe("Chest position (default: nearest known)"),
    },
    run: withParams("depositToChest", depositToChest),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "depositManyToChest",
    description:
      "Put one or several item types into one chest in a single trip; each `count` defaults to all you have. Without `pos`: nearest chest within 16 blocks, else a remembered one. Stops at the first failure with state.deposited and state.failedIndex.",
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
      pos: posSchema.optional().describe("Chest position (default: nearest known)"),
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
      "Take one or several item types out of ONE chest in a single trip. Without `pos` the chest is chosen by the FIRST item, so group only items stored together (nearest within 16 blocks, else remembered). Counts cap at what's there. Stops if an item is missing entirely: state.withdrawn and state.failedIndex.",
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
      pos: posSchema.optional().describe("Chest position (default: via the first item)"),
    },
    run: withParams("withdrawManyFromChest", withdrawManyFromChest),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "remember",
    description:
      "Remember a named place permanently (shows under known waypoints/utilities). Use when a player names a spot ('this is the base') and at the surface before going underground (type 'mine_entrance'). Position defaults to where you stand.",
    schema: {
      type: z.string().min(1).describe("'base', 'portal', 'bed', 'home', …"),
      name: z.string().optional(),
      pos: posSchema.optional(),
    },
    run: withParams("remember", remember, READ_ONLY),
    surfaces: PLANNER_ONLY,
  },
  {
    name: "setTaskQueue",
    description:
      "Set a plan of short, concrete steps with counts (e.g. ['mine 16 oak_log', 'craft wooden_pickaxe', 'mine 8 stone', 'give pickaxe to Alex']). Replaces any existing plan. The current and remaining steps show up in your world snapshot every message. Use for any job with 3+ steps.",
    schema: { tasks: z.array(z.string().min(1)).min(1) },
    run: withParams("setTaskQueue", setTaskQueue, READ_ONLY),
    surfaces: EXEC_AND_PLAN,
  },
  {
    name: "advanceTaskQueue",
    description:
      "Mark the current plan step done and move to the next. Call right after finishing each step. When it reports the queue is drained, tell the player you're done.",
    schema: {},
    run: noParams("advanceTaskQueue", advanceTaskQueue, READ_ONLY),
    // Executor needs this to drain a planner-authored queue (spikes/mlx-exec-spike.ts);
    // it sits outside the routing-spike curated-15, to be re-validated in Phase B.
    surfaces: EXECUTOR,
  },
  {
    name: "achieve",
    description:
      "Get items. Plans the whole chain (gather, craft, smelt, place a table/furnace) and runs it as a background job; returns at once with the plan. Pass ALL requested items in ONE call. Item = exact snake_case ID, or a tag when any kind will do: '#log', '#planks', '#wool', '#stone_tool_material', '#coal', '#sand' ('chop 10 logs' = { item: '#log', count: 10 }; mixed species count together). Also THE way to collect N of anything: it runs in the background so you can keep chatting. If the player wants the items in their hands ('give me', 'get me', 'bring me'), set deliverTo to their name: the job walks to them and hands them over (creative: takes them with getItems; max 2 stacks per item, never operator items). After it starts, reply briefly and end your turn; you get '[job finished]' or '[job failed]'. Movement/mining/crafting tools called meanwhile cancel it. Fails with a reason if the item is unknown or has no source. Creative: only works with deliverTo.",
    schema: {
      goals: z
        .array(
          z.object({
            item: z.string().min(1).describe("Item ID or tag ('#log', '#planks', …)"),
            count: z.number().int().min(1).max(2304).describe("How many you should end up holding"),
          }),
        )
        .min(1)
        .max(8),
      deliverTo: z.string().min(1).optional().describe("Player to hand the items to (must be nearby)"),
    },
    run: withParams("achieve", achieve, READ_ONLY),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "find",
    description:
      "Go find a block (usually an ore) as a background job and return at once; works in survival and creative. It uses what is already known, scans everything loaded, then explores: for deep ores (diamond, iron, gold, redstone, lapis) it digs a staircase down to the ore's depth and a branch tunnel (never straight down), for surface blocks (logs, coal, sand, ...) it walks a spiral, moving away from water first; max ~250 blocks out and ~10 minutes. action 'point' (default): stand next to it and tell where, without mining it ('find diamonds but don't mine them'); 'mine': mine `count` of it (survival needs the right pickaxe; creative drops nothing); 'report': only give the coordinates. block = a block id (diamond_ore, iron_ore, oak_log) or an ore word (diamond). After it starts reply briefly and end your turn; you get '[job finished]' (with coordinates) or '[job failed]'. Don't call movement/mining tools while it runs (that cancels it).",
    schema: {
      block: z.string().min(1).describe("Block id or ore word, e.g. 'diamond_ore', 'diamond', 'iron_ore', 'oak_log'"),
      action: z.enum(["point", "mine", "report"]).optional().describe("point = stand next to it and say where (default); mine = mine it; report = just the coordinates"),
      count: z.number().int().min(1).max(16).optional().describe("action mine: how many (default 1)"),
    },
    run: withParams("find", find, READ_ONLY),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "build",
    description:
      "Build a house, nether portal or wheat farm as a background job; returns at once. Picks a level site next to the player (never on a build), gets missing materials (survival: gathers/crafts; creative: getItems), places bottom-up with scaffolding and the door last, then verifies the block count. 'house': width/depth 5-9, height 3-4, wall/roof/floor block ids (default: the planks you hold), windows 0-8, door. 'portal': 10 obsidian + flint_and_steel. 'farm': size 3-9, needs hoe + seeds, water within 4 or a water bucket. at: 'here' (default) or {x,y,z}. After it starts, reply briefly and end your turn; you get '[job finished]' or '[job failed]'. Movement/building tools called meanwhile cancel it.",
    schema: {
      blueprint: z.enum(["house", "portal", "farm"]),
      params: z
        .object({
          width: z.number().int().min(5).max(9).optional(),
          depth: z.number().int().min(5).max(9).optional(),
          height: z.number().int().min(3).max(4).optional().describe("Rows incl. roof (3 = 2-high interior)"),
          wall: z.string().optional().describe("Wall block id, e.g. oak_planks, cobblestone"),
          roof: z.string().optional().describe("Roof block id (default: same as wall)"),
          floor: z.string().optional().describe("Optional floor block id"),
          door: z.boolean().optional(),
          windows: z.number().int().min(0).max(8).optional(),
          size: z.number().int().min(3).max(9).optional().describe("Farm plot size"),
        })
        .optional(),
      at: z.union([z.literal("here"), posSchema]).optional().describe("'here' = beside the player (default)"),
    },
    run: withParams("build", build, READ_ONLY),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "pixelArt",
    description:
      "Build a picture, logo or flag out of coloured blocks (pixel art) as a background job; returns at once like build. Give source.name (an image to look up on Wikimedia Commons, e.g. 'Montreal Canadiens logo') or source.url (a direct https image link the player pasted). Code fetches, resizes and picks the blocks; never hand-draw it unless no image can be found (then source.grid rows + source.palette char->block, concrete/wool/terracotta colours only). width = blocks across (default 32, max 128); scale multiplies it ('triple size' = scale 3); height follows the picture; total max 6000 blocks. palette: concrete (default) | wool | terracotta. orientation: wall (default; stands upright facing the player; creative needed for tall ones) | flat (laid on the ground). The image credit is posted to chat for you: don't repeat or invent one. Don't call movement/building tools while it runs (that cancels it).",
    schema: {
      source: z.object({
        name: z.string().min(2).max(100).optional().describe("Image to look up on Wikimedia Commons"),
        url: z.string().max(2048).optional().describe("Direct https link to a PNG/JPEG/GIF/WebP image"),
        grid: z.array(z.string().max(48)).min(1).max(48).optional().describe("Last resort: rows of equal width, '.' = empty"),
        palette: z.record(z.string().max(1), z.string().max(40)).optional().describe("With grid: character -> block, e.g. { R: 'red_concrete' }"),
      }),
      width: z.number().int().min(4).max(128).optional().describe("Blocks across before scale (default 32)"),
      scale: z.number().int().min(1).max(4).optional().describe("Size multiplier (triple size = 3)"),
      palette: z.enum(["concrete", "wool", "terracotta"]).optional(),
      orientation: z.enum(["wall", "flat"]).optional(),
      at: z.union([z.literal("here"), posSchema]).optional().describe("'here' = near the requesting player (default)"),
      dither: z.boolean().optional().describe("Photos only; leave off for logos and flags"),
      maxColors: z.number().int().min(2).max(16).optional().describe("Distinct colours kept (default 6)"),
    },
    run: withParams("pixelArt", pixelArt, READ_ONLY),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "surviveNight",
    description:
      "Survive the night (at dusk, or 'survive the night', 'it's getting dark'). Background job: sleeps in a bed if one is near, else digs a sealed 1x2 pocket into the ground or hillside and waits until dawn; with no safe spot it builds a 3x3 hut next to the player. useBed:false skips the bed; shelter:'hut' skips digging in. After it starts, reply briefly and end your turn; you get '[job finished]' at dawn or '[job failed]'. Movement/building tools called meanwhile cancel it. Not for creative.",
    schema: {
      useBed: z.boolean().optional().describe("false = build a shelter even if a bed is at hand"),
      shelter: z.enum(["dig", "hut"]).optional().describe("hut = build the 3x3 hut instead of digging in (default dig)"),
    },
    run: withParams("surviveNight", surviveNight, READ_ONLY),
    surfaces: CLAUDE_ONLY,
  },
  {
    name: "cancelJob",
    description:
      "Cancel the running job (if any). Use when the player changes their mind; a new achieve call also replaces it.",
    schema: {},
    run: noParams("cancelJob", cancelJob, READ_ONLY),
    surfaces: CLAUDE_ONLY,
  },
];

/**
 * Live-polish A (efficiency report rec. #6): tools the Claude bot no longer sees. Each is redundant or superseded
 * (the world snapshot carries inventory + surroundings; `mineBlocks` / `placeBlocks` / `giveItemsTo` /
 * `depositManyToChest` / `withdrawManyFromChest` take one-item lists; `achieve` crafts chains; the task queue is
 * replaced by jobs). They stay in the registry and as plain skills (jobs, the local/hybrid backends and tests call
 * them); only the `claude` surface drops them: 41 -> 29 tool definitions, ~3k fewer prompt tokens per API call.
 * See SKILLS.md "Hidden from the model".
 */
export const HIDDEN_FROM_CLAUDE: ReadonlySet<string> = new Set([
  "observeSurroundings",
  "checkInventory",
  "setTaskQueue",
  "advanceTaskQueue",
  "pickUpNearby",
  "mineBlock",
  "craftMany",
  "placeBlock",
  "depositToChest",
  "withdrawFromChest",
  "giveItemTo",
  "equipLoadout",
]);
for (const spec of SKILL_SPECS) {
  if (HIDDEN_FROM_CLAUDE.has(spec.name)) spec.surfaces = { ...spec.surfaces, claude: false };
}

export const SKILL_SPECS_BY_NAME: ReadonlyMap<string, SkillSpec> = new Map(
  SKILL_SPECS.map((s) => [s.name, s]),
);
