import type { Bot } from "mineflayer";
import { isAddressed } from "../orchestrator/chat-router.js";
import type { BotState } from "../state/index.js";

/**
 * Wire mineflayer events into the per-bot state stores and the chat
 * router. Registered on every new connection because the Bot is rebuilt
 * by the supervisor on reconnect.
 *
 * Phase 3 only *logs* routing decisions; phase 4 hooks them up to the
 * Claude agent loop.
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
    const match = isAddressed(username, allBots, { channel: "chat", sender: player, message });
    if (match) {
      console.log(`${tag} ROUTE chat→${username} reason=${match.reason} reply-on=${match.channel}`);
    }
  });

  bot.on("whisper", (player, message) => {
    if (player === username) return;
    console.log(`${tag} whisper <${player}> ${message}`);
    const match = isAddressed(username, allBots, { channel: "whisper", sender: player, message });
    if (match) {
      console.log(`${tag} ROUTE whisper→${username} reason=${match.reason} reply-on=${match.channel}`);
    }
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

function snapshotPos(player: { entity?: { position?: { x: number; y: number; z: number } } }): { x: number; y: number; z: number } | null {
  const p = player.entity?.position;
  if (!p) return null;
  return { x: p.x, y: p.y, z: p.z };
}
