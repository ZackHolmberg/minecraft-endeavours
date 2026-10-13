/**
 * Early end of a per-task session after a terminal `say` (live-polish A, efficiency report rec. #1).
 *
 * The SDK always makes one more, text-only API call after the last tool result ("thinking: …" that nobody sees);
 * that was 44% of all calls. When the model's last API turn consisted only of speech plus background launchers,
 * every tool in it succeeded and at least one of them was a say/whisper, the model has nothing left to do: the
 * backend interrupts the query before that final call (the interrupt still yields a `result` with usage).
 *
 * The SDK streams a turn's content blocks one by one and runs each tool as soon as its block is complete, so a
 * tool result can arrive before the turn's later tool_use blocks exist. "No tool pending" therefore proves
 * nothing; the turn is only complete at `message_stop` (needs `includePartialMessages`). This tracker consumes
 * the raw SDK message stream (stream_event + user/tool_result) and answers "is the turn finished and terminal?".
 * Dependency-free so it unit-tests without the SDK.
 */

/**
 * Job launchers: background jobs that start and return at once ("reply briefly and end your turn"). A say next to a
 * successful launcher is the whole reply; the work happens without the model. `find` needs no follow-up: its result
 * says to end the turn and the answer arrives as a `[job finished]` task. `pixelArt` posts its own credit line.
 */
export const EARLY_END_LAUNCHERS: ReadonlySet<string> = new Set(["achieve", "build", "followPlayer", "surviveNight", "find", "pixelArt"]);

/** Tools that may share a turn with the say without needing a follow-up call (they start work or stop it and return). */
export const EARLY_END_COMPANIONS: ReadonlySet<string> = new Set([...EARLY_END_LAUNCHERS, "cancelJob", "stop", "remember"]);

/**
 * An acknowledgement ("on it", "sure, let me check", "I'll grab that", "omw") promises work that has not been started.
 * Without a launcher having run, more tool calls are probably coming, so the session must not end on it
 * (live-polish review M4).
 */
const ACK_START =
  /^(?:ok(?:ay)?|k|sure(?: thing)?|yep|yeah|yes|yup|alright|aight|got it|will do|on it|omw|brb|be right back|right away|one (?:sec|moment|second|min)|hang on|hold on|give me|gimme|just a (?:sec|moment|second)|let me|lemme|let's|i'?ll|i will|i'?m (?:going|gonna|about|on my way|heading|coming)|going to|gonna|heading|coming|on my way|sounds good|no problem|np|can do|doing)\b/i;
const ACK_ANYWHERE = /\b(?:on it|omw|brb|be right back|on my way|one sec(?:ond)?|right away)\b/i;

export function looksLikeAck(text: string): boolean {
  const t = text.trim().replace(/^[\s"'*_~.,!?-]+/, "");
  if (t.length === 0) return true;
  if (ACK_START.test(t)) return true;
  return t.length <= 60 && ACK_ANYWHERE.test(t);
}
const SPEECH: ReadonlySet<string> = new Set(["say", "whisper"]);

interface TurnState {
  tools: Map<string, string>; // tool_use id → short tool name
  blockIds: Map<number, string>; // content block index → tool_use id
  inputs: Map<string, string>; // tool_use id → streamed input JSON
  results: Map<string, boolean>; // tool_use id → ok
  stopReason: string | null;
  stopped: boolean;
}

function shortName(name: string): string {
  const idx = name.lastIndexOf("__");
  return idx >= 0 ? name.slice(idx + 2) : name;
}

type Loose = Record<string, unknown>;

/** The `message` of a say/whisper from its streamed input JSON; "" when unreadable (treated as an ack: don't end). */
function spokenText(json: string | undefined): string {
  if (!json) return "";
  try {
    const m = (JSON.parse(json) as Loose).message;
    return typeof m === "string" ? m : "";
  } catch {
    return "";
  }
}

export class EarlyEndTracker {
  private cur: TurnState | null = null;
  private fired = false;
  /** A launcher succeeded earlier in this task: the work is running without the model. */
  private launched = false;

  reset(): void {
    this.cur = null;
    this.fired = false;
    this.launched = false;
  }

  /** Feed one SDK message; true exactly once, when the session should be ended now. */
  feed(msg: unknown): boolean {
    if (this.fired || !msg || typeof msg !== "object") return false;
    const m = msg as Loose;
    if (m.type === "stream_event") {
      const ev = m.event as Loose | undefined;
      if (!ev) return false;
      switch (ev.type) {
        case "message_start":
          this.cur = { tools: new Map(), blockIds: new Map(), inputs: new Map(), results: new Map(), stopReason: null, stopped: false };
          return false;
        case "content_block_start": {
          const block = ev.content_block as Loose | undefined;
          if (this.cur && block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            this.cur.tools.set(block.id, shortName(block.name));
            if (typeof ev.index === "number") this.cur.blockIds.set(ev.index, block.id);
            if (block.input && typeof block.input === "object" && Object.keys(block.input).length > 0) this.cur.inputs.set(block.id, JSON.stringify(block.input));
          }
          return false;
        }
        case "content_block_delta": {
          const delta = ev.delta as Loose | undefined;
          const id = typeof ev.index === "number" ? this.cur?.blockIds.get(ev.index) : undefined;
          if (this.cur && id !== undefined && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            this.cur.inputs.set(id, (this.cur.inputs.get(id) ?? "") + delta.partial_json);
          }
          return false;
        }
        case "message_delta": {
          const delta = ev.delta as Loose | undefined;
          if (this.cur && typeof delta?.stop_reason === "string") this.cur.stopReason = delta.stop_reason;
          return false;
        }
        case "message_stop":
          if (this.cur) this.cur.stopped = true;
          return this.evaluate();
        default:
          return false;
      }
    }
    if (m.type === "user" && this.cur) {
      const content = (m.message as Loose | undefined)?.content;
      if (!Array.isArray(content)) return false;
      for (const b of content as Loose[]) {
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
          this.cur.results.set(b.tool_use_id, b.is_error !== true);
        }
      }
      return this.evaluate();
    }
    return false;
  }

  private evaluate(): boolean {
    const t = this.cur;
    if (!t || !t.stopped || t.stopReason !== "tool_use" || t.tools.size === 0) return false;
    let speech = false;
    let launched = this.launched;
    let ackOnly = true; // every spoken line looks like an acknowledgement
    for (const [id, name] of t.tools) {
      if (t.results.get(id) !== true) return false; // pending or failed: the model has to see the result
      if (SPEECH.has(name)) {
        speech = true;
        if (!looksLikeAck(spokenText(t.inputs.get(id)))) ackOnly = false;
      } else if (!EARLY_END_COMPANIONS.has(name)) return false;
      else if (EARLY_END_LAUNCHERS.has(name)) launched = true;
    }
    this.launched = launched;
    if (!speech) return false;
    // (a) a launcher ran: the say is the whole reply; (b) no work implied: the say is a real answer, not "on it"
    if (!launched && ackOnly) return false;
    this.fired = true;
    return true;
  }
}
