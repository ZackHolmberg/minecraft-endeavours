import { describe, expect, it } from "vitest";
import { isStatusQuestion } from "./coalesce.js";

const msg = (t: string) => `[public chat] <Tester> ${t}\n(they said your name; reply with say.)`;

describe("isStatusQuestion", () => {
  it.each([
    "steve, how's it going?",
    "Steve_v2, how's it going?",
    "how many logs do you have",
    "what are you doing",
    "where are you",
    "are you almost done",
    "is that all of them?",
    "steve, got any iron yet?",
    "can you see the village from there",
  ])("answers %s", (t) => expect(isStatusQuestion(msg(t))).toBe(true));

  it.each([
    "steve, chop 10 logs",
    "steve, can you also grab some coal?",
    "could you please build a house?",
    "steve, would you stop mining?",
    "wait, also grab some sticks",
    "thanks",
    "steve, come here",
  ])("leaves %s to a real task", (t) => expect(isStatusQuestion(msg(t))).toBe(false));

  it("works on whispers", () => {
    expect(isStatusQuestion("[whisper from Tester] how are you doing?\n(reply with whisper to Tester.)")).toBe(true);
  });
});
