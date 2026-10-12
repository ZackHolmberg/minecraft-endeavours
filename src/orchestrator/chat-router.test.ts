import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAddressed,
  MAX_FOLLOWUP_CHAIN,
  noteBotRepliedTo,
  peekRoute,
  registerJobRequesterProbe,
  resetChatRouter,
  UNNAMED_CAP_PER_MIN,
} from "./chat-router.js";

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

describe("un-named route cap and follow-up chain (promotion review M2 / L2)", () => {
  afterEach(() => {
    resetChatRouter();
    vi.useRealTimers();
  });

  it("caps routed un-named chats per player per minute, then recovers", () => {
    vi.useFakeTimers();
    registerJobRequesterProbe("Steve_v2", () => "Bob");
    const route = () => isAddressed("Steve_v2", ["Steve_v2"], ev("Bob", "lol nice"));
    for (let i = 0; i < UNNAMED_CAP_PER_MIN; i++) expect(route()?.reason).toBe("job-requester");
    expect(route()).toBeNull();
    // name-addressed chat is never capped
    expect(isAddressed("Steve_v2", ["Steve_v2"], ev("Bob", "Steve_v2, status?"))?.reason).toBe("name-mention");
    // another player has their own budget
    registerJobRequesterProbe("Steve_v2", () => "Cy");
    expect(isAddressed("Steve_v2", ["Steve_v2"], ev("Cy", "hi"))?.reason).toBe("job-requester");
    registerJobRequesterProbe("Steve_v2", () => "Bob");
    vi.advanceTimersByTime(61_000);
    expect(route()?.reason).toBe("job-requester");
  });

  it("a bare stop through the follow-up route is never capped", () => {
    noteBotRepliedTo("Steve_v2", "Bob");
    for (let i = 0; i < UNNAMED_CAP_PER_MIN; i++) isAddressed("Steve_v2", ["Steve_v2"], ev("Bob", "ok cool"));
    expect(isAddressed("Steve_v2", ["Steve_v2"], ev("Bob", "ok cool"))).toBeNull();
    expect(isAddressed("Steve_v2", ["Steve_v2"], ev("Bob", "stop"))?.reason).toBe("follow-up");
  });

  it("peekRoute has no side effects (no cap use, no partner)", () => {
    registerJobRequesterProbe("Steve_v2", () => "Bob");
    for (let i = 0; i < 20; i++) expect(peekRoute("Steve_v2", ["Steve_v2"], ev("Bob", "wait"))?.reason).toBe("job-requester");
    expect(isAddressed("Steve_v2", ["Steve_v2"], ev("Bob", "wait"))?.reason).toBe("job-requester");
  });

  it("stops renewing the follow-up window after MAX_FOLLOWUP_CHAIN consecutive follow-ups", () => {
    vi.useFakeTimers();
    const me = "Steve_v2";
    noteBotRepliedTo(me, "Bot9"); // window opened by a (named) exchange
    for (let i = 1; i <= MAX_FOLLOWUP_CHAIN; i++) {
      vi.advanceTimersByTime(30_000);
      expect(isAddressed(me, [me], ev("Bot9", "auto reply " + i))?.reason).toBe("follow-up");
      noteBotRepliedTo(me, "Bot9"); // renewed
    }
    vi.advanceTimersByTime(30_000);
    expect(isAddressed(me, [me], ev("Bot9", "auto reply 4"))?.reason).toBe("follow-up"); // chain = 4
    noteBotRepliedTo(me, "Bot9"); // NOT renewed
    vi.advanceTimersByTime(35_000); // 65 s after the 3rd renewal
    expect(isAddressed(me, [me], ev("Bot9", "auto reply 5"))).toBeNull();
  });

  it("a name mention resets the chain", () => {
    vi.useFakeTimers();
    const me = "Steve_v2";
    noteBotRepliedTo(me, "Al");
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000);
      isAddressed(me, [me], ev("Al", "hm"));
      if (i === 2) isAddressed(me, [me], ev("Al", "Steve_v2, ok"));
      noteBotRepliedTo(me, "Al");
    }
    vi.advanceTimersByTime(50_000);
    expect(isAddressed(me, [me], ev("Al", "thanks"))?.reason).toBe("follow-up");
  });
});
