import type { Bot } from "mineflayer";
import { recordEvent } from "../observability/telemetry.js";
import type { SkillResult } from "./types.js";

const MAX_CHAT_LEN = 256;
/**
 * Minimum gap between outgoing lines. Vanilla/Paper kicks for spam at ~10
 * rapid messages, and back-to-back lines read as robotic anyway.
 */
const MIN_CHAT_GAP_MS = 700;
/** Identical line repeated within this window is dropped (model double-send). */
const DUPLICATE_WINDOW_MS = 10_000;

// bot.chat would execute a leading "/" as a server command.
const SLASH_REFUSAL = "refused: messages can't start with \"/\" (that would run a server command); rephrase without it";

const lastSent = new Map<string, { text: string; at: number }>();

/** Shared send-side hygiene: suppress exact repeats and pace lines. */
async function prepareLine(bot: Bot, raw: string): Promise<{ sent: string; truncated: boolean; duplicate: boolean }> {
  let text = raw.trim();
  const truncated = text.length > MAX_CHAT_LEN;
  if (truncated) text = text.slice(0, MAX_CHAT_LEN);
  const prev = lastSent.get(bot.username);
  const now = Date.now();
  if (prev && prev.text === text && now - prev.at < DUPLICATE_WINDOW_MS) {
    return { sent: text, truncated, duplicate: true };
  }
  if (prev && now - prev.at < MIN_CHAT_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_CHAT_GAP_MS - (now - prev.at)));
  }
  lastSent.set(bot.username, { text, at: Date.now() });
  return { sent: text, truncated, duplicate: false };
}

export interface SayParams {
  message: string;
}

export async function say(bot: Bot, { message }: SayParams): Promise<SkillResult> {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "empty message" };
  }
  if (trimmed.startsWith("/")) return { ok: false, message: SLASH_REFUSAL };
  const { sent, truncated, duplicate } = await prepareLine(bot, trimmed);
  if (sent.length === 0) return { ok: false, message: "empty message" };
  if (duplicate) return { ok: true, message: `already said "${sent}" just now — not repeating`, state: { sent, duplicate } };
  bot.chat(sent);
  recordEvent(bot.username, { kind: "chat_out", channel: "say", chars: sent.length });
  return {
    ok: true,
    message: `said "${sent}"`,
    state: { sent, truncated },
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
  if (trimmed.startsWith("/")) return { ok: false, message: SLASH_REFUSAL };
  if (!bot.players[player]) {
    return { ok: false, message: `player "${player}" is not online` };
  }
  const { sent, truncated, duplicate } = await prepareLine(bot, trimmed);
  if (sent.length === 0) return { ok: false, message: "empty message" };
  if (duplicate) return { ok: true, message: `already whispered that to ${player} just now — not repeating`, state: { sent, duplicate } };
  bot.whisper(player, sent);
  recordEvent(bot.username, { kind: "chat_out", channel: "whisper", chars: sent.length });
  return {
    ok: true,
    message: `whispered to ${player}: "${sent}"`,
    state: { sent, truncated },
  };
}
