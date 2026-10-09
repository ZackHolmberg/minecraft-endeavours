/**
 * Chat routing middleware. Decides which bot should wake up for a given chat
 * or whisper event before any Claude call — every routing decision that can
 * be made by a regex doesn't need an LLM.
 *
 * Per ARCHITECTURE.md "Player ↔ NPC interaction":
 *  - Name mention in public chat → that bot wakes.
 *  - `/msg <bot>` (mineflayer's `whisper` event) → that bot wakes.
 *  - `@all` → every bot wakes.
 *  - Name matching also accepts the "base" name with a trailing AI/Bot/NPC
 *    suffix stripped (`Steve_AI` answers to "steve") plus any `aliases:` from
 *    config/bots.yml (`Steve_v2` answers to "steve") — players address NPCs
 *    the way they'd address a friend, not by their full username.
 *  - Conversation continuity: if a bot recently asked a player a question
 *    (~45s window) and the same player chats again, route to that bot even
 *    without a name mention. Avoids the awkward "Steve, small" requirement.
 *  - Follow-up: for a shorter window after the bot says anything to a player,
 *    that player's next un-named chat also routes ("thanks!", "now make
 *    planks"). The agent is told the bot wasn't named and may stay silent if
 *    the chat clearly wasn't meant for it.
 *
 * Phase 3 only computes and logs routing decisions; the agent layer in
 * phase 4 picks them up and dispatches into per-bot Claude sessions.
 */

// 45s rather than 30s: typing an answer in Minecraft chat (open chat, type,
// maybe re-read the question) regularly takes longer than 30s.
const QUESTION_TTL_MS = 45 * 1000;
// Window after any bot reply in which the same player's un-named chat still
// routes back. Short on purpose — this is the most false-positive-prone path.
const FOLLOW_UP_TTL_MS = 20 * 1000;
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
const recentReplies = new Map<string, QuestionEntry>();

function questionKey(bot: string, player: string): string {
  return `${bot}|${player}`;
}

export type ChatChannel = "chat" | "whisper";

export interface ChatEvent {
  channel: ChatChannel;
  sender: string;
  message: string;
}

export type RouteReason =
  | "name-mention"
  | "all-mention"
  | "whisper"
  | "continuation"
  | "follow-up";

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

  if (hasRecentReply(botUsername, event.sender)) {
    return { channel: "chat", reason: "follow-up" };
  }

  return null;
}

/** Configured aliases (config/bots.yml `aliases:`), by bot username. */
const configuredAliases = new Map<string, string[]>();

/** Set a bot's configured aliases (called by loadConfig). Replaces any previous set. */
export function registerBotAliases(botUsername: string, aliases: readonly string[]): void {
  configuredAliases.set(botUsername, [...aliases]);
}

/**
 * Names a player might use for this bot: the full username, the base name
 * when it ends in an AI/Bot/NPC suffix (`Steve_AI` → `Steve`; the base must be
 * ≥3 chars so `AI_Bot`-style names don't collapse to noise), and any aliases
 * configured in bots.yml (`Steve_v2` + `aliases: [steve]`). Also used for the
 * "another bot is named → not for me" check, so aliases apply there too.
 */
export function nameAliases(botUsername: string): string[] {
  const aliases = [botUsername];
  const base = botUsername.replace(/[_-]?(?:ai|bot|npc)$/i, "");
  if (base !== botUsername && base.length >= 3) aliases.push(base);
  for (const extra of configuredAliases.get(botUsername) ?? []) {
    if (!aliases.some((a) => a.toLowerCase() === extra.toLowerCase())) aliases.push(extra);
  }
  return aliases;
}

function mentionsName(text: string, botUsername: string): boolean {
  // Word-boundary match, case-insensitive. Username characters are
  // restricted to `[A-Za-z0-9_]` (see config.ts), so word boundaries
  // behave intuitively against punctuation, spaces, and quotes.
  return nameAliases(botUsername).some((name) =>
    new RegExp(`\\b${escapeRegex(name)}\\b`, "i").test(text),
  );
}

/**
 * Is this chat a bare "stop what you're doing" command? Stricter than the
 * event-hooks side-channel regex (which matches "wait" anywhere): the bot's
 * names and punctuation are stripped, then the message must *start* with a
 * stop word and be short. "wait"/"hold on" only count on their own, since
 * "wait, also grab coal" is an addition, not a stop. "steve stop", "nvm",
 * "stop and come here" qualify; "wait for me" and "don't stop mining" don't.
 * Used to interrupt the agent's in-flight turn, so false positives cost a
 * task — keep it tight.
 */
export function isStopCommand(botUsername: string, text: string): boolean {
  let t = text.toLowerCase();
  for (const name of nameAliases(botUsername)) {
    t = t.replace(new RegExp(`\\b${escapeRegex(name.toLowerCase())}\\b`, "g"), " ");
  }
  t = t.replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length === 0 || t.split(" ").length > 5) return false;
  if (/^(?:wait|hold on|hold up)(?: up| a sec| a second| a minute)?$/.test(t)) return true;
  return /^(?:stop|halt|cancel|nvm|never ?mind|forget it|abort)\b/.test(t);
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

/** Record that the bot just said something to `playerName` (opens the follow-up window). */
export function noteBotRepliedTo(botUsername: string, playerName: string): void {
  recentReplies.set(questionKey(botUsername, playerName), { at: Date.now() });
}

export function hasRecentReply(botUsername: string, playerName: string): boolean {
  const entry = recentReplies.get(questionKey(botUsername, playerName));
  if (!entry) return false;
  if (Date.now() - entry.at > FOLLOW_UP_TTL_MS) {
    recentReplies.delete(questionKey(botUsername, playerName));
    return false;
  }
  return true;
}

/** Wipe all routing state. For tests. */
export function resetChatRouter(): void {
  lastAddressed.clear();
  recentQuestions.clear();
  recentReplies.clear();
  configuredAliases.clear();
}
