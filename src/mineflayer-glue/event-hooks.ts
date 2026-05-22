import type { Bot } from "mineflayer";
import { getAgent } from "../agent/npc-agent.js";
import { isAddressed, type ChatEvent } from "../orchestrator/chat-router.js";
import type { BotState } from "../state/index.js";

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
    dispatch(tag, username, allBots, { channel: "chat", sender: player, message });
  });

  bot.on("whisper", (player, message) => {
    if (player === username) return;
    console.log(`${tag} whisper <${player}> ${message}`);
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
