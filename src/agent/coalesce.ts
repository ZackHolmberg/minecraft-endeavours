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
  return /^\[job (finished|failed)\]/.test(message) || /they said your name;|sent to @all|^\[whisper from /.test(message);
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
