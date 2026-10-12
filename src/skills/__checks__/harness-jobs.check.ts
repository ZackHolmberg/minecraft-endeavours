/**
 * Offline check for the v2 slice-2b fixes in the skill harness:
 *  - runSkill `readOnly` neither clears the stop flag nor touches current-tool;
 *  - runSkill `watchdogMs` override (short watchdog fires; `null` disables it);
 *  - watchdog stops reach `onRequest` listeners with reason "watchdog";
 *  - withPacedClicks nesting restores the original clickWindow (no leaked wrapper).
 *
 * Run from a scratch cwd (state persistence writes under ./data/):
 *   cd $(mktemp -d) && BOT_TELEMETRY_DIR=$PWD/tele \
 *     /path/to/repo/node_modules/.bin/tsx /path/to/repo/src/skills/__checks__/harness-jobs.check.ts
 */
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import { createBotState, registerBotState, getBotState } from "../../state/index.js";
import { runSkill } from "../harness.js";
import { withPacedClicks } from "../paced-clicks.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  registerBotState("h1", createBotState());
  const bot = { username: "h1", entity: { onGround: true }, game: { gameMode: "survival" } } as unknown as Bot;
  const st = getBotState("h1")!;

  // 1. readOnly: a latched stop flag and the in-flight tool entry survive a read-only call.
  {
    const tok = st.currentTool.begin("mineBlocks");
    st.cancellation.request();
    const r = await runSkill(bot, "checkInventory", undefined, async () => ({ ok: true, message: "inv" }), { readOnly: true });
    assert.equal(r.ok, true);
    assert.equal(st.cancellation.isRequested(), true, "read-only call must not clear the stop flag");
    assert.equal(st.currentTool.current()?.name, "mineBlocks", "read-only call must not clobber currentTool");
    st.currentTool.end(tok);
    // a normal skill does reset both
    await runSkill(bot, "goTo", undefined, async () => ({ ok: true, message: "x" }));
    assert.equal(st.cancellation.isRequested(), false);
    assert.equal(st.currentTool.current(), null);
    console.log("  1: readOnly leaves flag + currentTool alone");
  }

  // 2. watchdog override: short watchdog fires with reason "watchdog"; null disables it.
  {
    const reasons: string[] = [];
    const off = st.cancellation.onRequest((r) => reasons.push(r));
    const r = await runSkill(bot, "slow", undefined, () => new Promise<never>(() => {}), { watchdogMs: 40 });
    assert.equal(r.ok, false);
    assert.match(r.message, /timed out/);
    assert.deepEqual(reasons, ["watchdog"]);
    const r2 = await runSkill(bot, "slow2", undefined, async () => { await sleep(120); return { ok: true, message: "finished" }; }, { watchdogMs: null });
    assert.equal(r2.ok, true);
    assert.deepEqual(reasons, ["watchdog"], "no watchdog stop when disabled");
    off();
    console.log("  2: watchdog override + reason ok");
  }

  // 3. withPacedClicks: out-of-order overlapping calls restore the original.
  {
    const original = async () => "clicked";
    const b = { clickWindow: original } as unknown as Bot;
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const a = withPacedClicks(b, async () => { await gateA; }, 5);
    const c = withPacedClicks(b, async () => { await sleep(10); }, 5);
    await c; // B finishes first (wrapper must stay for A)
    assert.notEqual((b as any).clickWindow, original, "still patched while A runs");
    releaseA();
    await a;
    assert.equal((b as any).clickWindow, original, "original restored after both finish");
    const t0 = Date.now();
    await (b as any).clickWindow();
    assert.ok(Date.now() - t0 < 4, "no leaked pacing");
    console.log("  3: paced-clicks nesting ok");
  }

  console.log("harness-jobs: all assertions passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
