import { describe, expect, it } from "vitest";
import { isDirectAddress, silentNudgeText } from "./coalesce.js";

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
