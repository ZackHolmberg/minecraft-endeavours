import type { Bot } from "mineflayer";
import pathfinderPkg, { type Pathfinder } from "mineflayer-pathfinder";

const { goals, Movements } = pathfinderPkg;
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { readWorldKnowledge } from "../memory/world-knowledge.js";
import { getBotState } from "../state/index.js";
import { equipItem } from "./inventory.js";
import { resolveItem } from "./item-naming.js";
import type { Coords, SkillResult } from "./types.js";

interface BotWithPathfinder extends Bot {
  pathfinder: Pathfinder;
}

const BED_SEARCH_RADIUS = 32;
const BED_REACH = 2;
const FISH_TICK_MS = 250;
const FISH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — fish often take a while to bite

/**
 * Food preference: prefer the highest-saturation cooked / processed foods
 * first, falling back through raw and fillers. Numbers here are vanilla
 * hunger restored; saturation roughly tracks the same ordering. The bot
 * eats whatever is highest on this list that's actually in inventory.
 */
const FOOD_PREFERENCE: ReadonlyArray<string> = [
  "cooked_beef",
  "cooked_porkchop",
  "cooked_mutton",
  "cooked_salmon",
  "cooked_chicken",
  "cooked_rabbit",
  "cooked_cod",
  "baked_potato",
  "bread",
  "mushroom_stew",
  "rabbit_stew",
  "beetroot_soup",
  "pumpkin_pie",
  "cookie",
  "apple",
  "carrot",
  "melon_slice",
  "sweet_berries",
  "glow_berries",
  "dried_kelp",
  // Raw / lesser fallbacks
  "beef",
  "porkchop",
  "mutton",
  "salmon",
  "chicken",
  "rabbit",
  "cod",
  "potato",
  "beetroot",
  "rotten_flesh", // last resort
];

export interface EatParams {
  /** Specific food item to eat. Auto-picks the best available from inventory if omitted. */
  item?: string;
}

/**
 * Eat the held / best-available food. Composite: pick food → equip → call
 * `bot.consume()` which handles the whole activate-and-finish cycle. If
 * `item` is omitted, walks the FOOD_PREFERENCE list and picks the first
 * one actually in inventory.
 *
 * Won't eat when food is already full (bot.food === 20) unless an explicit
 * `item` was passed — the model shouldn't waste food on a full bot, but
 * an explicit request honors player intent (e.g. for the saturation
 * buffer or golden-apple effects).
 */
export async function eat(bot: Bot, { item }: EatParams = {}): Promise<SkillResult> {
  let foodName: string;
  if (item) {
    const r = resolveItem(bot, item);
    if (!r.ok) return { ok: false, message: `item ${r.message}` };
    foodName = r.normalized;
    const have = bot.inventory.count(r.data.id, null);
    if (have === 0) {
      return { ok: false, message: `no ${foodName} in inventory to eat` };
    }
  } else {
    if (bot.food >= 20) {
      return {
        ok: false,
        message: `food is full (${bot.food}/20) — pass an explicit item if you want to eat anyway`,
      };
    }
    const picked = pickBestFood(bot);
    if (!picked) {
      return {
        ok: false,
        message: `no food in inventory; tried ${FOOD_PREFERENCE.slice(0, 6).join(", ")} (+${FOOD_PREFERENCE.length - 6} more)`,
      };
    }
    foodName = picked;
  }

  const equip = await equipItem(bot, { item: foodName, slot: "hand" });
  if (!equip.ok) return { ok: false, message: `cannot eat ${foodName}: ${equip.message}` };

  const foodBefore = bot.food;
  try {
    await bot.consume();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `eating ${foodName} failed: ${message}` };
  }

  const restored = bot.food - foodBefore;
  return {
    ok: true,
    message: `ate ${foodName} (food: ${foodBefore} → ${bot.food}${restored > 0 ? `, +${restored}` : ""})`,
    state: { ate: foodName, foodBefore, foodAfter: bot.food },
  };
}

function pickBestFood(bot: Bot): string | null {
  const items = bot.inventory.items();
  const have = new Set(items.map((i) => i.name));
  for (const candidate of FOOD_PREFERENCE) {
    if (have.has(candidate)) return candidate;
  }
  return null;
}

export interface FishParams {
  // No params. Pass an explicit fishing_rod equip via equipItem first if
  // the bot doesn't already have one in hand.
}

/**
 * Cast a fishing rod and wait for a bite. Wraps `bot.fish()`, which handles
 * the cast / wait / reel cycle internally. Cancellable: race the fish
 * promise against the per-bot cancellation flag, so "stop fishing" via
 * the side-channel preempt or the `stop` skill actually reels in early.
 *
 * Requires a fishing_rod in the main hand and water within casting range
 * of where the bot is looking. mineflayer's bot.fish() throws a specific
 * error if those preconditions aren't met — surfaced as-is.
 */
export async function fish(bot: Bot, _params: FishParams = {}): Promise<SkillResult> {
  void _params;
  if (bot.heldItem?.name !== "fishing_rod") {
    return { ok: false, message: "must be holding a fishing_rod to fish; equip one first" };
  }

  const state = getBotState(bot.username);
  state?.cancellation.begin();

  const start = Date.now();
  const fishPromise = bot.fish().then(() => "caught" as const).catch((err: unknown) => {
    const m = err instanceof Error ? err.message : String(err);
    return { error: m } as const;
  });

  // Cancellation poller — resolves when cancellation is requested or the
  // overall timeout fires. We can't truly cancel bot.fish() from outside;
  // the best we can do is detach the wait so the agent loop returns.
  const cancelPromise = new Promise<"cancelled" | "timeout">((resolve) => {
    const tick = setInterval(() => {
      if (state?.cancellation.isRequested()) {
        clearInterval(tick);
        resolve("cancelled");
      } else if (Date.now() - start > FISH_TIMEOUT_MS) {
        clearInterval(tick);
        resolve("timeout");
      }
    }, FISH_TICK_MS);
  });

  const winner = await Promise.race([fishPromise, cancelPromise]);

  if (winner === "caught") {
    return { ok: true, message: "caught a fish" };
  }
  if (winner === "cancelled") {
    // bot.fish() is still resolving in the background; reel in by activating
    // the rod again. Fire-and-forget.
    try {
      bot.activateItem();
    } catch {
      // best-effort reel-in
    }
    return { ok: true, message: "stopped fishing" };
  }
  if (winner === "timeout") {
    try {
      bot.activateItem();
    } catch {
      /* best-effort reel-in */
    }
    return { ok: false, message: `fishing timed out after ${Math.round(FISH_TIMEOUT_MS / 60_000)} minutes with no bite` };
  }
  // winner is the { error } object from a fish rejection
  return { ok: false, message: `fishing failed: ${winner.error}` };
}

export interface SleepInParams {
  /** Optional bed position. When omitted, auto-resolves: nearest *_bed within 32 → nearest remembered bed POI. */
  pos?: Coords;
}

/**
 * Sleep in a bed. Wraps `bot.sleep`. Bed resolution mirrors the
 * craft/smelt fallback ladder so the bot can return to a remembered bed
 * at base from wherever it is. Bed POIs are auto-captured by the
 * proximity scan in `event-hooks.ts` (any `*_bed` variant counts).
 *
 * Vanilla preconditions: night (or thunderstorm), bed not obstructed,
 * within ~2 blocks of the bed. mineflayer's bot.sleep throws specific
 * errors for these — surfaced as-is so Claude can adapt ("not possible
 * here", "you can only sleep at night", etc.).
 */
export async function sleepIn(bot: Bot, { pos }: SleepInParams = {}): Promise<SkillResult> {
  const resolved = await resolveBed(bot, pos);
  if (!resolved.ok) return resolved;
  const { block, source } = resolved;

  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);
  try {
    await pBot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, BED_REACH));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `couldn't reach ${block.name} at ${fmt(block.position)} (${source}): ${message}` };
  }

  try {
    await bot.sleep(block);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `sleep in ${block.name} at ${fmt(block.position)} failed: ${message}` };
  }

  return {
    ok: true,
    message: `sleeping in ${block.name} at ${fmt(block.position)} (${source})`,
    state: { bed: block.name, pos: { x: block.position.x, y: block.position.y, z: block.position.z } },
  };
}

type BedResolution =
  | { ok: true; block: Block; source: "caller" | "nearby" | "remembered" }
  | { ok: false; message: string };

async function resolveBed(bot: Bot, pos?: Coords): Promise<BedResolution> {
  if (pos) {
    const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) {
      return { ok: false, message: `chunk at ${fmt(new Vec3(pos.x, pos.y, pos.z))} isn't loaded — walk closer first` };
    }
    if (!block.name.endsWith("_bed")) {
      return { ok: false, message: `block at ${fmt(block.position)} is ${block.name}, not a bed` };
    }
    return { ok: true, block, source: "caller" };
  }

  // Live-search any bed color within radius.
  const bedIds = bot.registry.blocksArray
    .filter((b) => b.name.endsWith("_bed"))
    .map((b) => b.id);
  if (bedIds.length > 0) {
    const nearby = bot.findBlock({
      point: bot.entity.position,
      matching: bedIds,
      maxDistance: BED_SEARCH_RADIUS,
    });
    if (nearby) return { ok: true, block: nearby, source: "nearby" };
  }

  // Remembered bed POI.
  const world = await readWorldKnowledge(bot.username);
  const remembered = world.pois
    .filter((p) => p.type.endsWith("_bed"))
    .map((p) => ({
      p,
      dist: bot.entity.position.distanceTo(new Vec3(p.position.x, p.position.y, p.position.z)),
    }))
    .sort((a, b) => a.dist - b.dist)[0];

  if (remembered) {
    const block = bot.blockAt(new Vec3(remembered.p.position.x, remembered.p.position.y, remembered.p.position.z));
    if (block && block.name.endsWith("_bed")) {
      return { ok: true, block, source: "remembered" };
    }
    return {
      ok: false,
      message: `nearest remembered ${remembered.p.type} is at ${fmt(new Vec3(remembered.p.position.x, remembered.p.position.y, remembered.p.position.z))} (~${Math.round(remembered.dist)} blocks) but the chunk isn't loaded — walk closer first`,
    };
  }

  return {
    ok: false,
    message: `no bed within ${BED_SEARCH_RADIUS} blocks and none remembered in world memory`,
  };
}

function ensureMovements(bot: BotWithPathfinder): void {
  if (!bot.pathfinder.movements || bot.pathfinder.movements.bot !== bot) {
    bot.pathfinder.setMovements(new Movements(bot));
  }
}

function fmt(v: { x: number; y: number; z: number }): string {
  return `(${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)})`;
}
