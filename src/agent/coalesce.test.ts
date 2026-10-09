import { describe, expect, it } from "vitest";
import { coalesceMessages, isSyntheticMessage } from "./coalesce.js";

const chat = (m: string) => `[public chat] <Alex> ${m}\n(they said your name; reply with say.)`;
const done = "[job finished] achieve iron_pickaxe x1 — done in 4m. Reply with one short line.";

describe("coalesceMessages", () => {
  it("passes a single message through untouched", () => {
    expect(coalesceMessages([done])).toBe(done);
  });
  it("puts player chats first in their own section, notices separately, even when the notice came last", () => {
    const body = coalesceMessages([chat("get me a furnace"), done]);
    const iPlayers = body.indexOf("Player messages");
    const iNotices = body.indexOf("System notices");
    expect(iPlayers).toBeGreaterThan(-1);
    expect(iNotices).toBeGreaterThan(iPlayers);
    expect(body.indexOf("get me a furnace")).toBeLessThan(iNotices);
    expect(body.indexOf("[job finished]")).toBeGreaterThan(iNotices);
    expect(body).toMatch(/NOT a player's request/);
    expect(body).not.toMatch(/latest intent wins:\n\n.*\[job finished\]/s);
  });
  it("latest-intent-wins applies only among player messages", () => {
    const body = coalesceMessages([chat("a"), chat("b"), done]);
    expect(body).toContain("latest intent wins");
    expect(body.indexOf("latest intent wins")).toBeLessThan(body.indexOf("System notices"));
  });
  it("notices alone get just the notices section", () => {
    const body = coalesceMessages([done, "[job failed] achieve x — failure: died"]);
    expect(body).not.toContain("Player messages");
    expect(body).toContain("System notices");
  });
  it("detects synthetic job messages only", () => {
    expect(isSyntheticMessage("[job failed] x")).toBe(true);
    expect(isSyntheticMessage("[public chat] <A> [job x]")).toBe(false);
  });
});
