import type { Bot } from "mineflayer";
import {
  getCurrentConversationPartner,
  noteBotQuestionedPlayer,
} from "../orchestrator/chat-router.js";
import { getBotState } from "../state/index.js";
import type { SkillResult } from "./types.js";

/**
 * Skills whose result message is too noisy or chatty to be useful in the
 * 5-minute action log surfaced via `observeSurroundings`.
 */
const ACTION_LOG_DENYLIST = new Set([
  "observeSurroundings",
  "say",
  "whisper",
  "stopMovement",
]);

/**
 * Wrap a skill in a try/catch so unexpected exceptions become
 * `{ ok: false, message }` results instead of taking down the bot, and
 * record successful results to the bot's recent-actions log.
 *
 * Callers (the manual chat trigger now, the Claude tool dispatcher later)
 * should always go through this rather than invoking skill functions raw —
 * skill modules deliberately stay free of cross-cutting concerns so they
 * remain unit-testable as plain async functions.
 */
export async function runSkill<P, R extends SkillResult>(
  bot: Bot,
  name: string,
  params: P,
  fn: (params: P) => Promise<R>,
): Promise<SkillResult> {
  let result: SkillResult;
  try {
    result = await fn(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[skill ${name}] threw:`, err);
    result = { ok: false, message: `${name} crashed: ${message}` };
  }

  if (result.ok && !ACTION_LOG_DENYLIST.has(name)) {
    const state = getBotState(bot.username);
    state?.actions.record(result.message);
  }

  if (result.ok && (name === "say" || name === "whisper")) {
    maybeNoteQuestion(bot, name, params, result);
  }

  return result;
}

/**
 * Conversation-continuity heuristic: when the bot says or whispers a line
 * ending in `?`, flag the target player for 30 seconds so their next chat
 * routes back to this bot without requiring another name-mention. Pure
 * middleware — see ARCHITECTURE.md "Conversation continuity".
 */
function maybeNoteQuestion(bot: Bot, name: string, params: unknown, result: SkillResult): void {
  const sent = (result.state as { sent?: string } | undefined)?.sent?.trim();
  if (!sent || !sent.endsWith("?")) return;

  const target =
    name === "whisper"
      ? (params as { player?: string }).player
      : getCurrentConversationPartner(bot.username);
  if (!target) return;

  noteBotQuestionedPlayer(bot.username, target);
}
