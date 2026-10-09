/**
 * Live game-mode reads. The owner flips the bot between survival and creative
 * at runtime (RCON `gamemode creative <bot>` from the web panel), and
 * mineflayer updates `bot.game.gameMode` on the `game_state_change` packet and
 * emits `game`. Every creative branch in the skill layer calls these on each
 * use — never cache the mode, or a mid-session switch is missed.
 */

import type { Bot } from "mineflayer";

export type GameMode = "survival" | "creative" | "adventure" | "spectator" | "unknown";

export function currentGameMode(bot: Bot): GameMode {
  const m: unknown = bot.game?.gameMode;
  return m === "survival" || m === "creative" || m === "adventure" || m === "spectator" ? m : "unknown";
}

export function isCreative(bot: Bot): boolean {
  return bot.game?.gameMode === "creative";
}
