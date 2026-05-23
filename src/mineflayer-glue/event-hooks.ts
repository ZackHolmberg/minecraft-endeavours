import type { Bot } from "mineflayer";
import { getAgent } from "../agent/npc-agent.js";
import {
  getCurrentConversationPartner,
  isAddressed,
  type ChatEvent,
} from "../orchestrator/chat-router.js";
import type { BotState } from "../state/index.js";

/**
 * Skills whose tick loop checks the cancellation flag. A "stop" message from
 * the current conversation partner while one of these is in flight flips the
 * flag so the skill exits promptly, without waiting for the chat to drain
 * through the queued agent loop.
 */
const CANCELLABLE_SKILLS = new Set(["followPlayer", "attack", "flee"]);
const STOP_REGEX = /\b(stop|halt|wait)\b/i;

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
  if (!STOP_REGEX.test(message)) return;
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
  if (!match) return;
  console.log(`${tag} ROUTE ${event.channel}→${username} reason=${match.reason}`);
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
