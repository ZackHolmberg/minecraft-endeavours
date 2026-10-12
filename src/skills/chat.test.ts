import { describe, expect, it } from "vitest";
import { isNearDuplicate } from "./chat.js";

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
