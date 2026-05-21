import type { Bot } from "mineflayer";

/**
 * Stub event wiring. For v0.2 slice 1, just prints chat the bot can hear to
 * the console so we can confirm the bot is connected and listening. Future
 * slices will replace this with the chat router → NPC agent dispatch.
 */
export function attachStubEventHooks(bot: Bot, username: string): void {
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
  });

  bot.on("playerLeft", (player) => {
    if (player.username === username) return;
    console.log(`${tag} player left: ${player.username}`);
  });
}
