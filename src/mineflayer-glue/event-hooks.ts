import type { Bot } from "mineflayer";
import type { BotState } from "../state/index.js";

/**
 * Wire mineflayer events into the per-bot state stores (and a little chat
 * logging while we're at it). Registered on every new connection because the
 * Bot is rebuilt by the supervisor on reconnect.
 */
export function attachBotEventHooks(bot: Bot, username: string, state: BotState): void {
  const tag = `[${username}]`;

  bot.on("chat", (player, message) => {
    if (player === username) return;
    console.log(`${tag} chat <${player}> ${message}`);
  });

  bot.on("whisper", (player, message) => {
    console.log(`${tag} whisper <${player}> ${message}`);
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
