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

/** Tools that may share a turn with the say without needing a follow-up call (they start work or stop it and return). */
export const EARLY_END_COMPANIONS: ReadonlySet<string> = new Set([
  "achieve",
  "build",
  "followPlayer",
  "surviveNight",
  "cancelJob",
  "stop",
  "remember",
]);
const SPEECH: ReadonlySet<string> = new Set(["say", "whisper"]);

interface TurnState {
  tools: Map<string, string>; // tool_use id → short tool name
  results: Map<string, boolean>; // tool_use id → ok
  stopReason: string | null;
  stopped: boolean;
}

function shortName(name: string): string {
  const idx = name.lastIndexOf("__");
  return idx >= 0 ? name.slice(idx + 2) : name;
}

type Loose = Record<string, unknown>;

export class EarlyEndTracker {
  private cur: TurnState | null = null;
  private fired = false;

  reset(): void {
    this.cur = null;
    this.fired = false;
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
          this.cur = { tools: new Map(), results: new Map(), stopReason: null, stopped: false };
          return false;
        case "content_block_start": {
          const block = ev.content_block as Loose | undefined;
          if (this.cur && block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            this.cur.tools.set(block.id, shortName(block.name));
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
    for (const [id, name] of t.tools) {
      if (t.results.get(id) !== true) return false; // pending or failed: the model has to see the result
      if (SPEECH.has(name)) speech = true;
      else if (!EARLY_END_COMPANIONS.has(name)) return false;
    }
    if (!speech) return false;
    this.fired = true;
    return true;
  }
}
