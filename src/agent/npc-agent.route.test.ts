import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../skills/harness.js", () => ({ runSkill: vi.fn(async () => ({ ok: true, message: "" })) }));
vi.mock("../skills/index.js", () => ({ stop: vi.fn() }));
vi.mock("../memory/conversation-log.js", () => ({ recordConversation: vi.fn(async () => {}) }));
vi.mock("../jobs/ledger.js", () => ({ eventLimiterFor: vi.fn(), noteExternalChat: vi.fn() }));
vi.mock("./backend/claude-backend.js", () => ({ ClaudeBackend: class {} }));
vi.mock("./backend/hybrid-backend.js", () => ({ HybridBackend: class {} }));
vi.mock("./backend/local-backend.js", () => ({ LocalBackend: class {} }));

import { runSkill } from "../skills/harness.js";
import { registerJobRunner, unregisterJobRunner } from "../jobs/registry.js";
import type { JobRunner } from "../jobs/runner.js";
import { NpcAgent, formatUserMessage } from "./npc-agent.js";

const BOT = "Steve_v2";
const chat = (sender: string, message: string) => ({ channel: "chat" as const, sender, message });

describe("job-requester route (promotion review M2)", () => {
  const cancel = vi.fn(async () => {});
  let pushed: string[];
  let agent: NpcAgent;

  beforeEach(async () => {
    cancel.mockClear();
    vi.mocked(runSkill).mockClear();
    pushed = [];
    const backend = { isRateLimited: () => false, pushUserMessage: (m: string) => pushed.push(m), isBusy: () => false };
    agent = Object.create(NpcAgent.prototype) as NpcAgent;
    Object.assign(agent, { backend, opts: { bot: { username: BOT }, botConfig: {} } });
    const runner = { isRunning: () => true, cancel, dispose: async () => {} } as unknown as JobRunner;
    await registerJobRunner(BOT, runner);
  });
  afterEach(async () => {
    await unregisterJobRunner(BOT);
  });

  it("tells Haiku to stay silent when the line isn't for it", () => {
    const msg = formatUserMessage(chat("Bob", "lol nice"), { channel: "chat", reason: "job-requester" }, false);
    expect(msg).toContain("working with you");
    expect(msg).toMatch(/may be addressed to someone else/);
    expect(msg).toMatch(/end your turn without calling any tool/);
  });

  it("an un-named 'wait' via job-requester does NOT cancel the job", () => {
    agent.pushChat(chat("Bob", "wait"), { channel: "chat", reason: "job-requester" });
    expect(cancel).not.toHaveBeenCalled();
    expect(runSkill).not.toHaveBeenCalled();
    expect(pushed).toHaveLength(1); // Haiku still sees it
  });

  it("a name-addressed stop, or stop via follow-up / continuation, still cancels", () => {
    agent.pushChat(chat("Bob", "Steve_v2 stop"), { channel: "chat", reason: "name-mention" });
    expect(cancel).toHaveBeenCalledTimes(1);
    agent.pushChat(chat("Bob", "stop"), { channel: "chat", reason: "follow-up" });
    expect(cancel).toHaveBeenCalledTimes(2);
    agent.pushChat(chat("Bob", "wait"), { channel: "chat", reason: "continuation" });
    expect(cancel).toHaveBeenCalledTimes(3);
    agent.pushChat(chat("Bob", "stop"), { channel: "whisper", reason: "whisper" });
    expect(cancel).toHaveBeenCalledTimes(4);
  });
});
