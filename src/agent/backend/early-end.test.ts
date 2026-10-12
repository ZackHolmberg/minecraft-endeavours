import { describe, expect, it } from "vitest";
import { EarlyEndTracker } from "./early-end.js";

const P = "mcp__minecraft-skills__";
const start = { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } };
const tool = (id: string, name: string) => ({
  type: "stream_event",
  event: { type: "content_block_start", content_block: { type: "tool_use", id, name: P + name } },
});
const stop = (reason = "tool_use") => [
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: reason } } },
  { type: "stream_event", event: { type: "message_stop" } },
];
const result = (id: string, ok = true) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !ok, content: "x" }] },
});
const run = (msgs: unknown[]): boolean[] => {
  const t = new EarlyEndTracker();
  return msgs.map((m) => t.feed(m));
};

describe("EarlyEndTracker", () => {
  it("ends after a lone successful say once the turn is complete", () => {
    const out = run([start, tool("a", "say"), result("a"), ...stop()]);
    expect(out).toEqual([false, false, false, false, true]);
  });

  it("works when the result lands after message_stop", () => {
    const out = run([start, tool("a", "say"), ...stop(), result("a")]);
    expect(out[out.length - 1]).toBe(true);
    expect(out.slice(0, -1).every((x) => !x)).toBe(true);
  });

  it("does not fire on an early tool result before the later blocks exist (streaming execution)", () => {
    // say's result arrives before the second block (goTo) is even announced
    const out = run([start, tool("a", "say"), result("a"), tool("b", "goTo"), result("b"), ...stop()]);
    expect(out.some(Boolean)).toBe(false);
  });

  it("say + background launcher ends; launcher alone or any foreground tool does not", () => {
    expect(run([start, tool("a", "say"), tool("b", "achieve"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(true);
    expect(run([start, tool("b", "achieve"), tool("a", "say"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(true);
    expect(run([start, tool("b", "achieve"), result("b"), ...stop()]).some(Boolean)).toBe(false);
    expect(run([start, tool("a", "say"), tool("b", "mineBlocks"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(false);
    expect(run([start, tool("a", "say"), tool("b", "goTo"), result("a"), result("b"), ...stop()]).some(Boolean)).toBe(false);
  });

  it("does not end when a tool failed (the model must react) or the turn ended without tools", () => {
    expect(run([start, tool("a", "say"), tool("b", "achieve"), result("a"), result("b", false), ...stop()]).some(Boolean)).toBe(false);
    expect(run([start, tool("a", "whisper"), result("a", false), ...stop()]).some(Boolean)).toBe(false);
    expect(run([start, ...stop("end_turn")]).some(Boolean)).toBe(false);
  });

  it("evaluates each API turn separately and fires once", () => {
    const t = new EarlyEndTracker();
    const feed = (...ms: unknown[]) => ms.map((m) => t.feed(m)).some(Boolean);
    expect(feed(start, tool("a", "say"), tool("b", "goTo"), result("a"), result("b"), ...stop())).toBe(false);
    expect(feed(start, tool("c", "say"), result("c"), ...stop())).toBe(true);
    expect(feed(result("c"), ...stop())).toBe(false); // already fired
    t.reset();
    expect(feed(start, tool("d", "say"), result("d"), ...stop())).toBe(true);
  });
});
