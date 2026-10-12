/** Live-polish A scenarios (conversation efficiency). Kept in their own file so parallel slices don't collide. */
import type { Scenario } from "../types.js";

/**
 * The live review (2026-10-11): 8 of 28 tasks ended mute because the player answered the bot's own question without
 * saying its name ("the CH logo", "sounds perfect") and the silent-turn nudge only covered name-addressed chat.
 * The bot asks (or at least opens an exchange); the Tester answers WITHOUT the name; the bot must reply or act.
 */
export const unnamedAnswer: Scenario = {
  id: "conv.unnamed_answer",
  tier: 2,
  category: "conversation",
  title: "Un-named answer to the bot's own question gets a reply",
  timeoutMs: 4 * 60_000,
  site: "plains",
  async setup() {},
  async run(ctx) {
    await ctx.say("steve, build something nice for me here");
    const question = await ctx.waitForBotChat(undefined, 30_000);
    ctx.scratch.asked = question !== null && question.includes("?");
    if (question === null) return; // no first reply at all: nothing to answer (check fails)
    await ctx.sleep(2500); // typing time
    // No name, no @all: only the continuation / follow-up route can carry this to the bot.
    await ctx.say("a small oak house is perfect, just pick a spot yourself");
    const reply = await ctx.waitForBotChat(undefined, 25_000);
    ctx.scratch.replied = reply !== null;
    // Don't pay for the whole build: stop whatever started (named, so it routes regardless).
    await ctx.say("steve, stop");
    await ctx.waitForDone({ quietMs: 4000 });
  },
  async check(ctx) {
    if (ctx.scratch.replied === undefined) return { ok: false, detail: "answer not given yet" };
    const replied = ctx.scratch.replied === true;
    return {
      ok: replied,
      score: replied ? 1 : 0,
      detail: `bot ${replied ? "replied to" : "ignored"} the un-named answer within 25s (it ${ctx.scratch.asked ? "asked a question first" : "did not ask a question first"})`,
    };
  },
  dryWin: async (ctx) => {
    ctx.scratch.asked = true;
    ctx.scratch.replied = true;
  },
};

export const polishA: Scenario[] = [unnamedAnswer];
