import { describe, expect, it } from "vitest";
import {
  GoalFailureLedger,
  JobEventLimiter,
  eventLimiterFor,
  goalSignature,
  ledgerFor,
  noteExternalChat,
} from "./ledger.js";

const MIN = 60_000;

describe("goalSignature", () => {
  it("normalizes order and merges duplicates", () => {
    const a = goalSignature([{ item: "stick", count: 4 }, { item: "iron_pickaxe", count: 1 }]);
    const b = goalSignature([{ item: "iron_pickaxe", count: 1 }, { item: "stick", count: 1 }, { item: "stick", count: 3 }]);
    expect(a).toBe("iron_pickaxe:1,stick:4");
    expect(b).toBe(a);
    expect(goalSignature([{ item: "iron_pickaxe", count: 2 }])).not.toBe(goalSignature([{ item: "iron_pickaxe", count: 1 }]));
  });
});

describe("GoalFailureLedger", () => {
  const g = [{ item: "diamond_pickaxe", count: 1 }];
  it("allows one failure, refuses after two within the window, naming the kinds", () => {
    const l = new GoalFailureLedger();
    expect(l.refusal(g, 0)).toBeNull();
    l.recordFailure(g, "no_source", 0);
    expect(l.refusal(g, 1)).toBeNull();
    l.recordFailure(g, "timeout", 5 * MIN);
    const msg = l.refusal(g, 6 * MIN)!;
    expect(msg).toContain("no_source, timeout");
    expect(msg).toMatch(/ask|player/);
  });
  it("is keyed by the normalized goal set (other goals unaffected)", () => {
    const l = new GoalFailureLedger();
    l.recordFailure(g, "no_source", 0);
    l.recordFailure([{ item: "diamond_pickaxe", count: 1 }], "no_source", 1);
    expect(l.refusal([{ item: "iron_pickaxe", count: 1 }], 2)).toBeNull();
    expect(l.refusal(g, 2)).not.toBeNull();
  });
  it("forgets failures older than the window", () => {
    const l = new GoalFailureLedger();
    l.recordFailure(g, "no_source", 0);
    l.recordFailure(g, "no_source", 1 * MIN);
    expect(l.refusal(g, 2 * MIN)).not.toBeNull();
    expect(l.refusal(g, 32 * MIN)).toBeNull();
  });
  it("a success or a player message clears it", () => {
    const l = new GoalFailureLedger();
    l.recordFailure(g, "no_source", 0);
    l.recordFailure(g, "no_source", 1);
    l.recordSuccess(g);
    expect(l.refusal(g, 2)).toBeNull();
    l.recordFailure(g, "no_source", 3);
    l.recordFailure(g, "no_source", 4);
    l.clear();
    expect(l.refusal(g, 5)).toBeNull();
  });
});

describe("JobEventLimiter", () => {
  it("allows 3 per 10 minutes then drops, and recovers as the window slides", () => {
    const l = new JobEventLimiter();
    expect([0, 1, 2].map((t) => l.allow(t * MIN))).toEqual([true, true, true]);
    expect(l.allow(3 * MIN)).toBe(false);
    expect(l.allow(9 * MIN)).toBe(false);
    expect(l.allow(10.5 * MIN)).toBe(true); // the first stamp (t=0) expired
  });
});

describe("per-bot registry", () => {
  it("noteExternalChat resets that bot's ledger and event cap only", () => {
    const g = [{ item: "x", count: 1 }];
    ledgerFor("a").recordFailure(g, "no_source");
    ledgerFor("a").recordFailure(g, "no_source");
    ledgerFor("b").recordFailure(g, "no_source");
    ledgerFor("b").recordFailure(g, "no_source");
    for (let i = 0; i < 3; i++) eventLimiterFor("a").allow();
    expect(eventLimiterFor("a").allow()).toBe(false);
    noteExternalChat("a");
    expect(ledgerFor("a").refusal(g)).toBeNull();
    expect(eventLimiterFor("a").allow()).toBe(true);
    expect(ledgerFor("b").refusal(g)).not.toBeNull();
  });
});
