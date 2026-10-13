import { describe, expect, it } from "vitest";
import { EarlyEndTracker, looksLikeAck } from "./early-end.js";

const P = "mcp__minecraft-skills__";
const start = { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } };
let nextIndex = 0;
const tool = (id: string, name: string, input?: Record<string, unknown>) => {
  const index = nextIndex++;
  const out: unknown[] = [{ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name: P + name } } }];
  if (input) out.push({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } });
  return out;
};
/** A say with text. */
const say = (id: string, message: string) => tool(id, "say", { message });
const stop = (reason = "tool_use") => [
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: reason } } },
  { type: "stream_event", event: { type: "message_stop" } },
];
const result = (id: string, ok = true) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !ok, content: "x" }] },
});
const run = (msgs: unknown[]): boolean[] => {
  nextIndex = 0;
  const t = new EarlyEndTracker();
  return msgs.flat().map((m) => t.feed(m));
};

const ANSWER = "you have 12 oak logs and a stone pickaxe";

describe("EarlyEndTracker", () => {
  it("ends after a lone successful non-ack say once the turn is complete", () => {
    const out = run([start, say("a", ANSWER), result("a"), ...stop()]);
    expect(out.slice(0, -1).every((x) => !x)).toBe(true);
    expect(out[out.length - 1]).toBe(true);
  });

  it("works when the result lands after message_stop", () => {
    const out = run([start, say("a", ANSWER), ...stop(), result("a")]);
    expect(out[out.length - 1]).toBe(true);
    expect(out.slice(0, -1).every((x) => !x)).toBe(true);
  });

  it("does not fire on an early tool result before the later blocks exist (streaming execution)", () => {
    const out = run([start, say("a", ANSWER), result("a"), tool("b", "goTo"), result("b"), ...stop()]);
    expect(out.some(Boolean)).toBe(false);
  });

  it("say + background launcher ends; launcher alone or any foreground tool does not", () => {
    expect(run([start, say("a", "on it"), tool("b", "achieve"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(true);
    expect(run([start, tool("b", "achieve"), say("a", "on it"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(true);
    expect(run([start, tool("b", "achieve"), result("b"), ...stop()]).some(Boolean)).toBe(false);
    expect(run([start, say("a", ANSWER), tool("b", "mineBlocks"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(false);
    expect(run([start, say("a", ANSWER), tool("b", "goTo"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(false);
  });

  it("every launcher counts, including find and pixelArt (they post/answer without the model)", () => {
    for (const l of ["build", "followPlayer", "surviveNight", "find", "pixelArt"]) {
      expect(run([start, say("a", "sure, on it"), tool("b", l), result("a"), result("b"), ...stop()]).some(Boolean), l).toBe(true);
    }
  });

  it("an ack-only say with no launcher never ends the session (more tool calls are coming)", () => {
    for (const msg of ["on it", "Sure!", "omw", "be right back", "let me check", "I'll grab some logs", "ok, one sec", "heading over now"]) {
      expect(run([start, say("a", msg), result("a"), ...stop()]).some(Boolean), msg).toBe(false);
    }
    // an unreadable / empty say is treated as an ack too
    expect(run([start, tool("a", "say"), result("a"), ...stop()]).some(Boolean)).toBe(false);
    // ack + cancel/remember (non-launchers) does not end either
    expect(run([start, say("a", "on it"), tool("b", "remember"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(false);
  });

  it("a real answer next to stop/cancelJob/remember ends", () => {
    expect(run([start, say("a", "stopped, I'm back at the base"), tool("b", "cancelJob"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(true);
    expect(run([start, say("a", "noted, the chest is at the base"), tool("b", "remember"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(true);
  });

  it("a launcher that ran earlier in the task lets a later ack-only say end it", () => {
    const t = new EarlyEndTracker();
    nextIndex = 0;
    const feed = (...ms: unknown[]) => ms.flat().map((m) => t.feed(m)).some(Boolean);
    expect(feed(start, tool("a", "build"), result("a"), ...stop())).toBe(false);
    expect(feed(start, say("b", "on it, building now"), result("b"), ...stop())).toBe(true);
  });

  it("does not end when a tool failed (the model must react) or the turn ended without tools", () => {
    expect(run([start, say("a", "on it"), tool("b", "achieve"), result("a"), result("b", false), ...stop()]).some(Boolean)).toBe(false);
    expect(run([start, tool("a", "whisper", { player: "x", message: ANSWER }), result("a", false), ...stop()]).some(Boolean)).toBe(false);
    expect(run([start, ...stop("end_turn")]).some(Boolean)).toBe(false);
  });

  it("evaluates each API turn separately and fires once", () => {
    const t = new EarlyEndTracker();
    nextIndex = 0;
    const feed = (...ms: unknown[]) => ms.flat().map((m) => t.feed(m)).some(Boolean);
    expect(feed(start, say("a", ANSWER), tool("b", "goTo"), result("a"), result("b"), ...stop())).toBe(false);
    expect(feed(start, say("c", ANSWER), result("c"), ...stop())).toBe(true);
    expect(feed(result("c"), ...stop())).toBe(false); // already fired
    t.reset();
    expect(feed(start, say("d", ANSWER), result("d"), ...stop())).toBe(true);
  });
});

describe("looksLikeAck", () => {
  it("flags acknowledgements, not answers", () => {
    for (const m of ["on it", "Sure, let me look", "I'll be right there", "omw!", "one second", "let me check your inventory", "Okay, heading to the forest", "..."]) expect(looksLikeAck(m), m).toBe(true);
    for (const m of ["you have 12 oak logs", "I can't reach the chest, it's under water", "The house is done, door on the south side", "what size do you want?", "no, I don't have a pickaxe"]) expect(looksLikeAck(m), m).toBe(false);
  });
});
