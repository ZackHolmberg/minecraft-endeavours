/**
 * Body of a coalesced task: several messages queued while the agent was busy.
 *
 * Player messages and synthetic orchestrator notices (`[job finished]`,
 * `[job failed]`) are kept in separate labeled sections, players first. A
 * notice is never a request, so it must not be able to bury a player's ask as
 * "older intent" (review finding M7).
 */

/** True for orchestrator-generated messages (not typed by a player). */
export function isSyntheticMessage(text: string): boolean {
  return text.startsWith("[job ");
}

export function coalesceMessages(batch: readonly string[]): string {
  if (batch.length === 1) return batch[0]!;
  const players = batch.filter((m) => !isSyntheticMessage(m));
  const notices = batch.filter(isSyntheticMessage);
  const parts: string[] = [`${batch.length} messages came in while you were busy.`];
  if (players.length > 0) {
    parts.push(
      `Player messages (oldest first${players.length > 1 ? " — handle them together, latest intent wins" : ""}):\n\n${players.join("\n\n")}`,
    );
  }
  if (notices.length > 0) {
    parts.push(
      `System notices (automatic, NOT a player's request — they never override or replace what a player asked${players.length > 0 ? "; deal with the player's request first, and mention a notice only if it matters to them" : ""}):\n\n${notices.join("\n\n")}`,
    );
  }
  return parts.join("\n\n");
}

/** Messages a player aimed at the bot (or a job result for it): the routing note says "reply" without the soft follow-up escape. */
export function isDirectAddress(message: string): boolean {
  if (/^\[job (finished|failed)\]/.test(message) || /^\[whisper from /.test(message)) return true;
  // Only the routing-note line (after the header) counts: a player typing "they said your name;" must not force the direct path.
  const note = message.split("\n").slice(1).join("\n");
  return /^\(they said your name;|^\(sent to @all/.test(note);
}


/**
 * The one-shot nudge sent when a directly-addressed task ended with no say/whisper. It runs as a fresh
 * task with no memory of the silent turn, so the wording must not invite a claim of work that never
 * started (review M8): say only what the tool results / context block show.
 */
export function silentNudgeText(how: string): string {
  return (
    `[orchestrator note — not a player message] Nobody heard anything from you on the last message: plain text is invisible, only the say/whisper tools reach players. ` +
    `Using only ${how}, answer them now in one short line. Say only what is TRUE according to the status in your context and your tool results: ` +
    `if no job is running and no tool call succeeded, you have NOT started anything, so don't say you are doing it or "on it". ` +
    `Instead say what you can do, give your proposal, or ask your one question. Never claim work that hasn't begun. Don't call any other tool this turn.`
  );
}

const REQUEST_VERBS = "get|grab|chop|mine|make|craft|build|bring|give|collect|fetch|go|come|follow|put|place|kill|attack|stop|wait|find|dig|smelt|cook|also|please|help|do|stay|hold|drop|take";

// Words that make a message a request/suggestion rather than a pure status question, wherever they appear.
const REQUEST_CUES =
  /\b(instead|how about|what about|why don'?t|let'?s|please|also|then|should|maybe|rather|first|(?:get|grab|chop|mine|make|craft|build|bring|give|collect|fetch|go|come|follow|put|place|kill|attack|stop|wait|find|dig|smelt|cook|drop|stay|hold|help|switch|change|start|try|use|take me)\b)/;

// Positive status shapes. A "?" alone is NOT enough ("grab coal instead?" is a request, review M1).
const STATUS_SHAPES: RegExp[] = [
  /^how(?:'s|s| is| are)\s+(?:it|that|things|the\s+\w+|you|your\s+\w+)\b/, // how's it going / how are you / how's the mining going
  /^how\s+(?:far|long|much\s+(?:longer|more|left)|many\b.*\b(?:do you have|have you (?:got|gotten)|are left|left|so far|do you got)|much\b.*\b(?:do you have|have you (?:got|gotten)|left|so far))/,
  /^what(?:'s|s| is| are|'re)\s+(?:you|u)\s+(?:doing|up to|making|building|mining|working on|carrying|holding)\b/,
  /^what(?:'s|s| is)\s+(?:the\s+|your\s+)?(?:status|progress|plan|update|going on)\b/,
  /^what(?:'s|s| is| do you have| have you got)\b.*\b(?:inventory|on you|in your)\b/,
  /^what\s+do\s+you\s+(?:have|got|carry)\b/,
  /^where\s+(?:are|r)\s+(?:you|u)\b/,
  /^(?:are|r)\s+(?:you|u)\s+(?:almost|nearly|still|done|finished|stuck|ok|okay|alright|ready|busy|there|alive|close|getting)\b/,
  /^is\s+(?:that|it|this)\s+(?:all|done|finished|everything|enough|working)\b/,
  /^(?:got|have you (?:got|gotten|found|finished))\b.*\byet\b/,
  /^(?:status|progress|update)\b/,
  /^can\s+(?:you|u)\s+(?:see|tell me|hear)\b/,
];

/**
 * A routed chat that is a pure question about progress / state ("how's it going?", "what are you doing",
 * "are you almost done?"), as opposed to a request ("can you also grab coal?", "grab coal instead?", "what about iron?").
 * `message` is the formatted user message (`[public chat] <Alex> steve, how's it going?\n(note)`).
 * Used to answer mid-task with a quick side reply that is NOT queued, so this must be conservative: it needs a
 * positive status shape AND no request cue anywhere; anything else is queued as a normal task (review M1).
 */
export function isStatusQuestion(message: string): boolean {
  const first = (message.split("\n")[0] ?? "").trim();
  const text = first.replace(/^\[[^\]]*\]\s*(<[^>]*>\s*)?/, "").trim().toLowerCase();
  if (text.length === 0) return false;
  const body = text.replace(/^[\w]+[,:]\s*/, "").replace(/^(?:hey|yo|um|uh|so|ok|okay)[, ]+/, "").trim();
  if (new RegExp(`^(can|could|would|will)\\s+(you|u)\\s+(${REQUEST_VERBS})\\b`).test(body)) return false;
  if (/^(do|could|can)\s+you\s+mind\b/.test(body)) return false;
  if (REQUEST_CUES.test(body)) return false;
  return STATUS_SHAPES.some((re) => re.test(body));
}
