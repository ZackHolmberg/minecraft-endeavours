import { describe, expect, it } from "vitest";
import { summarizeInit } from "./init-summary.js";

describe("summarizeInit", () => {
  it("is one compact line and flags foreign tools", () => {
    const clean = summarizeInit({ tools: ["mcp__minecraft-skills__say", "mcp__minecraft-skills__goTo"], mcp_servers: [{ name: "minecraft-skills", status: "connected" }], plugins: [], skills: [], slash_commands: [] });
    expect(clean).toBe("tools=2 foreign=0 mcp=[minecraft-skills] plugins=0 skills=0 slash=0 agents=0");
    const leaky = summarizeInit({ tools: ["mcp__minecraft-skills__say", "Bash", "mcp__claude_ai_Docs__batch"], mcp_servers: [{ name: "claude_ai_Docs", status: "failed" }], plugins: [{}], skills: ["pdf"], slash_commands: ["init", "review"] });
    expect(leaky).toContain("foreign=2[Bash,mcp__claude_ai_Docs__batch]");
    expect(leaky).toContain("claude_ai_Docs(failed)");
    expect(leaky).not.toContain("\n");
  });
});

import { sdkIsolation } from "./sdk-isolation.js";
describe("sdkIsolation", () => {
  it("disables settings, skills, auto-memory and CLAUDE.md, keeping the rest of the env", () => {
    const o = sdkIsolation({ PATH: "/bin", HOME: "/h" });
    expect(o.settingSources).toEqual([]);
    expect(o.skills).toEqual([]);
    expect(o.settings).toEqual({ autoMemoryEnabled: false });
    expect(o.env).toMatchObject({ PATH: "/bin", HOME: "/h", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
  });
});
