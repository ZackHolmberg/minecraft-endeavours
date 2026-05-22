/**
 * Chat routing middleware. Decides which bot should wake up for a given chat
 * or whisper event before any Claude call — every routing decision that can
 * be made by a regex doesn't need an LLM.
 *
 * Per ARCHITECTURE.md "Player ↔ NPC interaction":
 *  - Name mention in public chat → that bot wakes.
 *  - `/msg <bot>` (mineflayer's `whisper` event) → that bot wakes.
 *  - `@all` → every bot wakes.
 *  - Conversation continuity: if a bot recently asked a player a question
 *    (~30s window) and the same player chats again, route to that bot even
 *    without a name mention. Avoids the awkward "Steve, small" requirement.
 *
 * Phase 3 only computes and logs routing decisions; the agent layer in
 * phase 4 picks them up and dispatches into per-bot Claude sessions.
 */

const QUESTION_TTL_MS = 30 * 1000;
const ADDRESSED_TTL_MS = 5 * 60 * 1000;

interface AddressedEntry {
  player: string;
  at: number;
}

interface QuestionEntry {
  at: number;
}

const lastAddressed = new Map<string, AddressedEntry>();
const recentQuestions = new Map<string, QuestionEntry>();

function questionKey(bot: string, player: string): string {
  return `${bot}|${player}`;
}

export type ChatChannel = "chat" | "whisper";

export interface ChatEvent {
  channel: ChatChannel;
  sender: string;
  message: string;
}

export type RouteReason = "name-mention" | "all-mention" | "whisper" | "continuation";

export interface RouteMatch {
  channel: ChatChannel;
  reason: RouteReason;
}

/**
 * Decide whether `botUsername` should handle `event`. Returns the channel
 * the bot should reply on plus the reason it was selected, or `null` when
 * the chat isn't directed at this bot.
 *
 * Also notes the player as this bot's most-recent conversation partner on
 * match — so a subsequent `say(?)` from this bot knows whose
 * conversation-continuity flag to flip.
 */
export function isAddressed(
  botUsername: string,
  allBots: readonly string[],
  event: ChatEvent,
): RouteMatch | null {
  if (event.sender === botUsername) return null;

  const match = computeMatch(botUsername, allBots, event);
  if (match) {
    noteBotAddressed(botUsername, event.sender);
  }
  return match;
}

function computeMatch(
  botUsername: string,
  allBots: readonly string[],
  event: ChatEvent,
): RouteMatch | null {
  // Whisper events are routed by mineflayer to the addressed bot, so the
  // fact that this bot's handler fired *is* the routing decision.
  if (event.channel === "whisper") {
    return { channel: "whisper", reason: "whisper" };
  }

  const text = event.message;

  if (/\B@all\b/i.test(text)) {
    return { channel: "chat", reason: "all-mention" };
  }

  if (mentionsName(text, botUsername)) {
    return { channel: "chat", reason: "name-mention" };
  }

  // If a different bot is named, don't fall through to continuation — the
  // chat is directed at the other bot.
  for (const other of allBots) {
    if (other === botUsername) continue;
    if (mentionsName(text, other)) return null;
  }

  if (hasRecentQuestion(botUsername, event.sender)) {
    return { channel: "chat", reason: "continuation" };
  }

  return null;
}

function mentionsName(text: string, botUsername: string): boolean {
  // Word-boundary match, case-insensitive. Username characters are
  // restricted to `[A-Za-z0-9_]` (see config.ts), so word boundaries
  // behave intuitively against punctuation, spaces, and quotes.
  const re = new RegExp(`\\b${escapeRegex(botUsername)}\\b`, "i");
  return re.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function noteBotAddressed(botUsername: string, playerName: string): void {
  lastAddressed.set(botUsername, { player: playerName, at: Date.now() });
}

/**
 * Who most recently addressed this bot, if anyone within the address-TTL?
 * Used by the say/whisper question hook in `runSkill` to attribute a
 * public-chat question to a specific player — for whispers the target is
 * known from the skill params, but `say` is unaddressed by itself.
 */
export function getCurrentConversationPartner(botUsername: string): string | null {
  const entry = lastAddressed.get(botUsername);
  if (!entry) return null;
  if (Date.now() - entry.at > ADDRESSED_TTL_MS) {
    lastAddressed.delete(botUsername);
    return null;
  }
  return entry.player;
}

export function noteBotQuestionedPlayer(botUsername: string, playerName: string): void {
  recentQuestions.set(questionKey(botUsername, playerName), { at: Date.now() });
}

export function hasRecentQuestion(botUsername: string, playerName: string): boolean {
  const entry = recentQuestions.get(questionKey(botUsername, playerName));
  if (!entry) return false;
  if (Date.now() - entry.at > QUESTION_TTL_MS) {
    recentQuestions.delete(questionKey(botUsername, playerName));
    return false;
  }
  return true;
}

/** Wipe all routing state. For tests. */
export function resetChatRouter(): void {
  lastAddressed.clear();
  recentQuestions.clear();
}
