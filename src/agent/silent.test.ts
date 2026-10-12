import { describe, expect, it } from "vitest";
import { expectsReply, isDirectAddress, silentNudgeText } from "./coalesce.js";
import { formatUserMessage } from "./npc-agent.js";

describe("silent-turn backstop: which messages demand a reply", () => {
  it("direct addresses and job results do; soft follow-ups and unrelated chat don't", () => {
    expect(isDirectAddress("[public chat] <Alex> steve build a house\n(they said your name; reply with say.)")).toBe(true);
    expect(isDirectAddress("[whisper from Alex] hi\n(reply with whisper to Alex.)")).toBe(true);
    expect(isDirectAddress("[public chat] <Alex> @all hi\n(sent to @all (every bot); reply with say.)")).toBe(true);
    expect(isDirectAddress("[job finished] build house — done in 3m")).toBe(true);
    expect(isDirectAddress("[job failed] achieve x — failure: died")).toBe(true);
    expect(isDirectAddress("[public chat] <Alex> lol\n(not named — you were just talking with them. If it's clearly not meant for you, end your turn without calling any tool; otherwise reply with say.)")).toBe(false);
    expect(isDirectAddress("[orchestrator note — not a player message] ...")).toBe(false);
  });
});

describe("silent-turn nudge wording (M8)", () => {
  it("forbids claiming work that has not started and is not itself a direct address", () => {
    const t = silentNudgeText("say");
    expect(t).toMatch(/TRUE/);
    expect(t).toMatch(/NOT started anything/);
    expect(t).toMatch(/Never claim work that hasn't begun/);
    expect(isDirectAddress(t)).toBe(false);
  });
});

describe("un-named answers demand a reply too (live review item 1)", () => {
  it("a continuation, and a follow-up from the current partner, expect a reply; other follow-ups don't", () => {
    expect(expectsReply("continuation", "Alex", null)).toBe(true);
    expect(expectsReply("follow-up", "Alex", "Alex")).toBe(true);
    expect(expectsReply("follow-up", "Bob", "Alex")).toBe(false);
    expect(expectsReply("follow-up", "Alex", null)).toBe(false);
    expect(expectsReply("job-requester", "Alex", "Alex")).toBe(false);
    expect(expectsReply("name-mention", "Alex", "Alex")).toBe(false); // handled by isDirectAddress
    expect(expectsReply(undefined, undefined, "Alex")).toBe(false);
  });

  it("the continuation routing note says they are answering the bot's question", () => {
    const m = formatUserMessage({ channel: "chat", sender: "Alex", message: "the logo" }, { channel: "chat", reason: "continuation" }, false);
    expect(m).toMatch(/answering your question/);
    expect(m).toMatch(/reply with say and act/);
  });

  it("the nudge names the unanswered line and forbids repeating old news", () => {
    const t = silentNudgeText("say", ["[public chat] <Alex> sounds perfect\n(they're answering your question — reply with say.)"]);
    expect(t).toContain("<Alex> sounds perfect");
    expect(t).toMatch(/don't repeat anything you already told them/);
    expect(isDirectAddress(t)).toBe(false);
  });
});
