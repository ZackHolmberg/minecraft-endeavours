import { describe, expect, it } from "vitest";
import type { Bot } from "mineflayer";
import { isNearDuplicate, say, setNearDuplicateGuard } from "./chat.js";

describe("isNearDuplicate (completion-message dedupe)", () => {
  it("catches the live double: 'Done, the CH logo is up…' then 'The CH logo is finished…'", () => {
    const a = "Done, the CH logo is up. Blue background, red C, white H, 15 wide and 9 deep. The ground here is uneven sand so I laid it one block up, at the level just above the sand. Want me to change anything?";
    const b = "The CH logo is finished: blue background, red C, white H, about 15 wide. Want any changes?";
    expect(isNearDuplicate(a, b)).toBe(true);
    expect(isNearDuplicate(b, a)).toBe(true);
  });

  it("leaves short replies and differing numbers alone", () => {
    expect(isNearDuplicate("on it", "on it, grabbing the wood")).toBe(false);
    expect(isNearDuplicate("done, 16 oak logs. want planks too?", "done, 16 birch logs. want planks too?")).toBe(false);
    const a = "I put 16 oak logs in the chest next to the house, want me to grab more wood now";
    const b = "I put 8 oak logs in the chest next to the house, want me to grab more wood now";
    expect(isNearDuplicate(a, b)).toBe(false);
  });

  it("does not flag unrelated long lines", () => {
    expect(
      isNearDuplicate(
        "sure, I can build a five by five oak hut next to that tree, sound good to you?",
        "heading to the mine now, I'll grab some coal and iron and be back in a few minutes",
      ),
    ).toBe(false);
  });
});

describe("say near-duplicate guard scope (completion lines are never dropped)", () => {
  const ACK = "building the five by five oak house with a door and two windows now";
  const DONE = "the five by five oak house is up with a door and two windows";
  const mk = (name: string): { bot: Bot; sent: string[] } => {
    const sent: string[] = [];
    return { bot: { username: name, chat: (m: string) => sent.push(m) } as unknown as Bot, sent };
  };

  it("a job report line is sent even right after a similar ack", async () => {
    const { bot, sent } = mk("DupA");
    setNearDuplicateGuard("DupA", "off");
    await say(bot, { message: ACK });
    setNearDuplicateGuard("DupA", "report");
    const r = await say(bot, { message: DONE });
    expect((r.state as { duplicate?: boolean } | undefined)?.duplicate).toBeFalsy();
    expect(sent).toEqual([ACK, DONE]);
  });

  it("a nudged turn is not compared against the player-task ack", async () => {
    const { bot, sent } = mk("DupB");
    setNearDuplicateGuard("DupB", "off");
    await say(bot, { message: ACK });
    setNearDuplicateGuard("DupB", "nudge");
    await say(bot, { message: DONE });
    expect(sent).toHaveLength(2);
  });

  it("a nudged turn that restates the job report is still dropped", async () => {
    const { bot, sent } = mk("DupC");
    setNearDuplicateGuard("DupC", "report");
    await say(bot, { message: DONE });
    setNearDuplicateGuard("DupC", "nudge");
    const r = await say(bot, { message: "the five by five oak house is finished with a door and two windows" });
    expect((r.state as { duplicate?: boolean } | undefined)?.duplicate).toBe(true);
    expect(sent).toEqual([DONE]);
  });
});
