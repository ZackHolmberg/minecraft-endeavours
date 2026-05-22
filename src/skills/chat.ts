import type { Bot } from "mineflayer";
import type { SkillResult } from "./types.js";

const MAX_CHAT_LEN = 256;

export interface SayParams {
  message: string;
}

export async function say(bot: Bot, { message }: SayParams): Promise<SkillResult> {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "empty message" };
  }
  const sent = trimmed.length > MAX_CHAT_LEN ? trimmed.slice(0, MAX_CHAT_LEN) : trimmed;
  bot.chat(sent);
  return {
    ok: true,
    message: `said "${sent}"`,
    state: { sent, truncated: sent.length < trimmed.length },
  };
}

export interface WhisperParams {
  player: string;
  message: string;
}

export async function whisper(
  bot: Bot,
  { player, message }: WhisperParams,
): Promise<SkillResult> {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "empty message" };
  }
  if (!bot.players[player]) {
    return { ok: false, message: `player "${player}" is not online` };
  }
  const sent = trimmed.length > MAX_CHAT_LEN ? trimmed.slice(0, MAX_CHAT_LEN) : trimmed;
  bot.whisper(player, sent);
  return {
    ok: true,
    message: `whispered to ${player}`,
    state: { sent, truncated: sent.length < trimmed.length },
  };
}
