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

/**
 * A long line that restates one just sent (same words, same numbers) within this window is dropped too. Seen live:
 * "Done, the CH logo is up. Blue background, red C, white H, 15 wide…" then, from a later nudged turn, "The CH logo
 * is finished: blue background, red C, white H, about 15 wide. Want any changes?". Deliberately narrow: both lines
 * need >= NEAR_DUP_MIN_WORDS words, so short replies ("on it", "done, 16 oak logs") are never touched, and every
 * number of the shorter line must reappear, so "16 oak logs" vs "8 oak logs" stays distinct.
 */
const NEAR_DUPLICATE_WINDOW_MS = 120_000;
const NEAR_DUP_MIN_WORDS = 8;
const NEAR_DUP_OVERLAP = 0.7;

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 0));
}

/** True when `a` essentially restates `b` (see NEAR_DUP_*). Pure; exported for tests. */
export function isNearDuplicate(a: string, b: string): boolean {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (wa.size < NEAR_DUP_MIN_WORDS || wb.size < NEAR_DUP_MIN_WORDS) return false;
  // every number in the shorter line must appear in the longer one
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  for (const w of small) if (/\d/.test(w) && !big.has(w)) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size) >= NEAR_DUP_OVERLAP;
}

/**
 * Bots whose CURRENT task is an orchestrator-generated one (silent-turn nudge, [job ...] report): those run without
 * the player's message in front of them and are where a restated completion line came from. A reply to a real player
 * message may legitimately restate the proposal it confirms ("sure, on it: 5x5 oak house…"), so it is never dropped.
 */
export type NearDupMode = "off" | "nudge" | "report";
const nearDupMode = new Map<string, NearDupMode>();
/**
 * "nudge": the current task is a silent-turn nudge: its line is checked against earlier lines sent by orchestrator
 * tasks (nudge / job report) only. "report": a [job ...] report task: its lines are recorded for that comparison but
 * NEVER dropped, so a job's completion line can't be swallowed (live-polish review L6). "off": a player task; nothing
 * it says is dropped and nothing it said (acks, proposals) is compared against.
 */
export function setNearDuplicateGuard(botUsername: string, mode: NearDupMode): void {
  if (mode === "off") nearDupMode.delete(botUsername);
  else nearDupMode.set(botUsername, mode);
}

const lastSent = new Map<string, { text: string; at: number }>();
const recentSent = new Map<string, Array<{ text: string; at: number; orch: boolean }>>();

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
  const recent = (recentSent.get(bot.username) ?? []).filter((r) => now - r.at < NEAR_DUPLICATE_WINDOW_MS);
  const mode = nearDupMode.get(bot.username) ?? "off";
  if (mode === "nudge" && recent.some((r) => r.orch && isNearDuplicate(r.text, text))) {
    recentSent.set(bot.username, recent);
    return { sent: text, truncated, duplicate: true };
  }
  recent.push({ text, at: now, orch: mode !== "off" });
  recentSent.set(bot.username, recent.slice(-6));
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
