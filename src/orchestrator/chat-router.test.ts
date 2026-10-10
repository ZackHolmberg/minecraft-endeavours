import { afterEach, describe, expect, it } from "vitest";
import { isAddressed, registerJobRequesterProbe, resetChatRouter } from "./chat-router.js";

const ev = (sender: string, message: string) => ({ channel: "chat" as const, sender, message });

describe("job-requester routing (live test 2026-10-10)", () => {
  afterEach(() => resetChatRouter());

  it("routes the job requester's un-named chat while the job runs", () => {
    registerJobRequesterProbe("Steve_v2", () => "LordoftheBlock");
    expect(isAddressed("Steve_v2", ["Steve_v2"], ev("LordoftheBlock", "are you stuck?"))?.reason).toBe("job-requester");
  });

  it("ignores other players and idle bots", () => {
    registerJobRequesterProbe("Steve_v2", () => "LordoftheBlock");
    expect(isAddressed("Steve_v2", ["Steve_v2"], ev("Someone", "are you stuck?"))).toBeNull();
    registerJobRequesterProbe("Steve_v2", () => null);
    expect(isAddressed("Steve_v2", ["Steve_v2"], ev("LordoftheBlock", "are you stuck?"))).toBeNull();
  });
});
