import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Window } from "prismarine-windows";
import { getAgent } from "../agent/npc-agent.js";
import {
  addDeath,
  addPois,
  type AddPoiInput,
  isUtilityBlockType,
  upsertContainer,
} from "../memory/world-knowledge.js";
import { noteRoutedChat, recordEvent } from "../observability/telemetry.js";
import {
  getCurrentConversationPartner,
  isAddressed,
  isStopCommand,
  registerOnlinePlayers,
  type ChatEvent,
} from "../orchestrator/chat-router.js";
import {
  defendTick,
  idleLookTick,
  inferHurtCause,
  maybeAutoEat,
  maybeEquipArmor,
  noteHurt,
  survivalTick,
  trackSurvivalState,
} from "../skills/auto-behaviors.js";
import { rememberSeenContainers } from "../skills/containers.js";
import { isFlying, stopFlyingNow } from "../skills/flight.js";
import { currentGameMode, type GameMode } from "../skills/game-mode.js";
import type { BotState } from "../state/index.js";

/**
 * Skills whose tick loop checks the cancellation flag. A "stop" message from
 * the current conversation partner while one of these is in flight flips the
 * flag so the skill exits promptly, without waiting for the chat to drain
 * through the queued agent loop.
 */
const CANCELLABLE_SKILLS = new Set([
  "followPlayer",
  "attack",
  "flee",
  "fish",
  "smelt",
  "goTo",
  "mineBlock",
  "mineBlocks",
  "placeBlocks",
  "pillarUp",
]);

const CONTAINER_BLOCK_TYPES = new Set([
  "chest",
  "trapped_chest",
  "barrel",
  "shulker_box",
  "white_shulker_box",
  "orange_shulker_box",
  "magenta_shulker_box",
  "light_blue_shulker_box",
  "yellow_shulker_box",
  "lime_shulker_box",
  "pink_shulker_box",
  "gray_shulker_box",
  "light_gray_shulker_box",
  "cyan_shulker_box",
  "purple_shulker_box",
  "blue_shulker_box",
  "brown_shulker_box",
  "green_shulker_box",
  "red_shulker_box",
  "black_shulker_box",
]);

const UTILITY_SCAN_INTERVAL_MS = 5_000;
/** Idle-look + defensive-swing cadence. Cheap: a few distance checks. */
const REFLEX_TICK_MS = 400;
/** Window after a death in which a "<bot> was slain by …" line is its cause. */
const DEATH_MESSAGE_WINDOW_MS = 3_000;
const UTILITY_SCAN_RADIUS = 8;
const CURSOR_REACH = 6;

/**
 * Per-bot hint set by chest skills before bot.openChest fires its window
 * event — the skill knows exactly which block it opened, which is more
 * reliable than the cursor heuristic when the chest is behind a wall or
 * the bot didn't lookAt it. The windowOpen hook consults this first, then
 * falls back to blockAtCursor.
 */
const pendingContainerOpen = new Map<string, { block: Block; at: number }>();
const PENDING_TTL_MS = 4_000;

export function noteContainerOpening(username: string, block: Block): void {
  pendingContainerOpen.set(username, { block, at: Date.now() });
}

/**
 * Wire mineflayer events into the per-bot state stores, the chat router,
 * and the agent. Registered on every new connection because the Bot is
 * rebuilt by the supervisor on reconnect.
 *
 * Flow per incoming chat/whisper:
 *   1. Log the raw line.
 *   2. Ask the chat router whether this bot is addressed (name-mention,
 *      whisper, @all, or 30s conversation continuation).
 *   3. If yes, push to the bot's NpcAgent. The agent's rate-limit cooldown
 *      decides whether to actually consume the message or drop it.
 */
export function attachBotEventHooks(
  bot: Bot,
  username: string,
  allBots: readonly string[],
  state: BotState,
): void {
  const tag = `[${username}]`;

  // Lets the router drop an alias a human is using as their own username.
  registerOnlinePlayers(username, () => Object.keys(bot.players ?? {}));

  bot.on("chat", (player, message) => {
    if (player === username) return;
    console.log(`${tag} chat <${player}> ${message}`);
    maybePreempt(tag, username, state, player, message);
    dispatch(tag, username, allBots, { channel: "chat", sender: player, message });
  });

  bot.on("whisper", (player, message) => {
    if (player === username) return;
    console.log(`${tag} whisper <${player}> ${message}`);
    maybePreempt(tag, username, state, player, message);
    dispatch(tag, username, allBots, { channel: "whisper", sender: player, message });
  });

  bot.on("playerJoined", (player) => {
    if (player.username === username) return;
    console.log(`${tag} player joined: ${player.username}`);
    state.presence.onJoin(player.username, snapshotPos(player));
  });

  bot.on("playerLeft", (player) => {
    if (player.username === username) return;
    console.log(`${tag} player left: ${player.username}`);
    state.presence.onLeave(player.username, snapshotPos(player));
  });

  // Container auto-capture. Track which block the bot is opening at
  // windowOpen time, then snapshot contents on windowClose. The skills
  // hint via noteContainerOpening; the cursor lookup is a fallback for
  // chests opened via `bot.activateBlock` or any other path.
  let openContext: { block: Block; type: string } | null = null;

  bot.on("windowOpen", (window: Window) => {
    const hint = pendingContainerOpen.get(username);
    pendingContainerOpen.delete(username);
    let block: Block | null = null;
    if (hint && Date.now() - hint.at < PENDING_TTL_MS) {
      block = hint.block;
    } else {
      const looked = bot.blockAtCursor(CURSOR_REACH);
      if (looked && CONTAINER_BLOCK_TYPES.has(looked.name)) block = looked;
    }
    if (!block) return;
    openContext = { block, type: block.name };
    void window; // contents may not be ready yet — capture on windowClose
  });

  bot.on("windowClose", (window: Window) => {
    if (!openContext) return;
    const { block, type } = openContext;
    openContext = null;
    try {
      const contents = window.containerItems().map((i) => ({ item: i.name, count: i.count }));
      void upsertContainer(username, {
        type,
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
        contents,
        openedBy: username,
      }).catch((err) => {
        console.warn(`${tag} container snapshot failed:`, err);
      });
    } catch (err) {
      console.warn(`${tag} container snapshot threw:`, err);
    }
  });

  // Utility-block proximity auto-capture. Periodic scan (vs per-tick move
  // events) so we don't burn CPU when the bot's mining or following — the
  // bot doesn't need a real-time POI update, just "remember this when you
  // pass by". Idempotent on (type, position) so re-scanning is free.
  const utilityIds = collectUtilityIds(bot);
  const utilityScan = setInterval(() => {
    void scanForUtilityBlocks(bot, username, tag, utilityIds);
    // Chests in plain sight are remembered too (seen-only, no contents): "put them in the chest" still works after walking off.
    rememberSeenContainers(bot).then(
      (n) => {
        if (n > 0) console.log(`${tag} auto-container: remembered ${n} seen container(s)`);
      },
      (err) => console.warn(`${tag} seen-container write failed:`, err),
    );
    // Retry armor upgrades picked up while a skill was busy.
    maybeEquipArmor(bot, state);
  }, UTILITY_SCAN_INTERVAL_MS);

  // Player-like reflexes (see skills/auto-behaviors.ts). All of them bail
  // while a skill is in flight, so they never fight the agent for control.
  const reflexTick = setInterval(() => {
    if (!bot.entity) return;
    // Breath / suffocation first: it preempts whatever skill is moving the bot.
    survivalTick(bot, state);
    defendTick(bot, state);
    idleLookTick(bot, state);
  }, REFLEX_TICK_MS);
  trackSurvivalState(bot);
  bot.on("health", () => maybeAutoEat(bot, state));
  bot.on("playerCollect", (collector) => {
    if (collector !== bot.entity) return;
    // Let the inventory slot update land before inspecting it.
    setTimeout(() => maybeEquipArmor(bot, state), 500);
  });

  // Game-mode changes (RCON `gamemode …` from the web panel) and respawns.
  // Skills read the mode live; this only (a) drops out of creative flight —
  // gravity must come back on a mode switch or respawn, or the bot floats —
  // and (b) logs the switch to the actions log so the per-task context shows
  // when it happened.
  let lastMode: GameMode | null = null;
  bot.on("game", () => {
    if (isFlying(bot)) stopFlyingNow(bot);
    const mode = currentGameMode(bot);
    if (lastMode !== null && mode !== lastMode) {
      console.log(`${tag} game mode changed: ${lastMode} → ${mode}`);
      state.actions.record(`game mode changed from ${lastMode} to ${mode}`);
    }
    lastMode = mode;
  });

  bot.on("entityHurt", (entity, source) => {
    if (entity !== bot.entity) return;
    noteHurt(bot, source);
    const who = source ? source.username ?? source.name ?? "something" : "something";
    const cause = inferHurtCause(bot, source);
    console.log(`${tag} hurt by ${source ? who : cause} (health ${Math.round(bot.health)}/20)`);
    recordEvent(username, {
      kind: "hurt",
      health: Math.round((bot.health ?? 0) * 10) / 10,
      by: source ? source.username ?? source.name ?? null : null,
      cause,
    });
  });

  // Death capture → world.json deaths[] + actions log, so the agent can
  // answer "where did you die?" / go back for its items. mineflayer has no
  // death cause, so we pair the event with the server's "<bot> was slain by
  // …" chat line if it arrives within a few seconds.
  let pendingDeath: { position: { x: number; y: number; z: number }; at: number; cause: string } | null = null;
  let deathFlush: NodeJS.Timeout | null = null;
  const flushDeath = (): void => {
    deathFlush = null;
    const d = pendingDeath;
    pendingDeath = null;
    if (!d) return;
    recordEvent(username, { kind: "death", at: d.at, pos: d.position, cause: d.cause.slice(0, 200) });
    const where = `(${d.position.x}, ${d.position.y}, ${d.position.z})`;
    state.actions.record(`died at ${where}: ${d.cause}; my items dropped there (they despawn after ~5 min)`);
    void addDeath(username, { position: d.position, cause: d.cause, timestamp: d.at }).catch((err) => {
      console.warn(`${tag} death capture failed:`, err);
    });
  };
  bot.on("death", () => {
    const p = bot.entity?.position;
    const position = p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : { x: 0, y: 0, z: 0 };
    pendingDeath = { position, at: Date.now(), cause: "unknown cause" };
    console.warn(`${tag} died at (${position.x}, ${position.y}, ${position.z})`);
    // Abort whatever was running — a mid-path goal or attack loop after
    // respawn would walk the bot somewhere nonsensical.
    state.cancellation.request("death");
    (bot as Bot & { pathfinder?: { stop(): void } }).pathfinder?.stop();
    deathFlush = setTimeout(flushDeath, DEATH_MESSAGE_WINDOW_MS);
  });
  bot.on("messagestr", (message) => {
    if (!pendingDeath || !message.startsWith(`${username} `)) return;
    pendingDeath.cause = message.slice(username.length + 1).trim();
    if (deathFlush) clearTimeout(deathFlush);
    flushDeath();
  });

  bot.once("end", () => {
    clearInterval(utilityScan);
    clearInterval(reflexTick);
    if (deathFlush) {
      clearTimeout(deathFlush);
      flushDeath();
    }
    pendingContainerOpen.delete(username);
  });
}

function collectUtilityIds(bot: Bot): number[] {
  const ids: number[] = [];
  for (const block of bot.registry.blocksArray) {
    if (isUtilityBlockType(block.name)) ids.push(block.id);
  }
  return ids;
}

async function scanForUtilityBlocks(bot: Bot, username: string, tag: string, ids: number[]): Promise<void> {
  if (!bot.entity) return;
  if (ids.length === 0) return;
  const positions = bot.findBlocks({
    point: bot.entity.position,
    matching: ids,
    maxDistance: UTILITY_SCAN_RADIUS,
    count: 32,
  });
  const inputs: AddPoiInput[] = [];
  for (const p of positions) {
    const block = bot.blockAt(p);
    if (!block) continue;
    inputs.push({ type: block.name, position: { x: p.x, y: p.y, z: p.z }, source: "auto" as const });
  }
  if (inputs.length === 0) return;
  try {
    // One read + at most one write per scan (was one per block).
    const results = await addPois(username, inputs);
    results.forEach((r, i) => {
      if (!r.added) return;
      const { type, position: q } = inputs[i]!;
      console.log(`${tag} auto-poi: ${type} at (${q.x}, ${q.y}, ${q.z})`);
    });
  } catch (err) {
    console.warn(`${tag} auto-poi write failed:`, err);
  }
}

/**
 * Side-channel for player-side preempt. If a cancellable skill is in flight
 * and the current conversation partner sends a "stop"-style message, flip
 * the cancellation flag immediately so the skill exits without waiting for
 * the message to traverse the agent queue. The message still flows through
 * the normal dispatch path so Claude sees it on the next turn.
 */
function maybePreempt(
  tag: string,
  username: string,
  state: BotState,
  sender: string,
  message: string,
): void {
  const tool = state.currentTool.current();
  if (!tool || !CANCELLABLE_SKILLS.has(tool.name)) return;
  // Strict whole-message match: "wait, also grab coal" must not preempt.
  if (!isStopCommand(username, message)) return;
  const partner = getCurrentConversationPartner(username);
  if (partner !== sender) return;
  state.cancellation.request();
  console.log(`${tag} preempt: cancellation requested from ${sender} (in-flight: ${tool.name})`);
}

function dispatch(
  tag: string,
  username: string,
  allBots: readonly string[],
  event: ChatEvent,
): void {
  const match = isAddressed(username, allBots, event);
  recordEvent(username, {
    kind: "chat_in",
    player: event.sender,
    routed: match !== null,
    route: match?.reason ?? null,
    isStop: isStopCommand(username, event.message),
  });
  if (!match) return;
  console.log(`${tag} ROUTE ${event.channel}→${username} reason=${match.reason}`);
  noteRoutedChat(username, { player: event.sender, route: match.reason, at: Date.now() });
  const agent = getAgent(username);
  if (!agent) {
    console.warn(`${tag} no agent registered; chat from ${event.sender} dropped`);
    return;
  }
  agent.pushChat(event, match);
}

function snapshotPos(player: { entity?: { position?: { x: number; y: number; z: number } } }): { x: number; y: number; z: number } | null {
  const p = player.entity?.position;
  if (!p) return null;
  return { x: p.x, y: p.y, z: p.z };
}
