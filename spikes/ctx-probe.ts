/**
 * Prefix-size probe (live-polish A). Opens one bot-shaped SDK session (real system prompt, real tool definitions,
 * the bot's isolation options), lets it answer once, then prints Query.getContextUsage() ("full"): system prompt /
 * MCP tools / messages tokens. Variants (argv[2], combinable): tiny (system prompt "x"), notools, agents, cwd, oldcwd.
 *   PROBE_MSG='say hi' npx tsx spikes/ctx-probe.ts base
 * Costs a few cents of subscription usage; says nothing in-game (stub bot).
 */
import "../src/agent/npc-agent.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildSkillsServer, MCP_SERVER_NAME, ALLOWED_TOOL_NAMES } from "../src/agent/skill-tools.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { sdkIsolation } from "../src/agent/backend/sdk-isolation.js";

const variant = process.argv[2] ?? "base";
const bot = { username: "Steve_AI" } as never;
async function* input() {
  yield { type: "user" as const, message: { role: "user" as const, content: process.env.PROBE_MSG ?? "[public chat] <Alex> steve, say hi\n(they said your name; reply with say.)" }, parent_tool_use_id: null };
  await new Promise((r) => setTimeout(r, 60000));
}
const extra: Record<string, unknown> = {};
if (variant.includes("agents")) extra.agents = {};
if (variant.includes("cwd")) extra.cwd = "/tmp/emptycwd";
if (variant.includes("plugins")) extra.plugins = [];
const iso = sdkIsolation(); if (variant.includes("oldcwd")) (iso as any).cwd = process.cwd();
if (variant.includes("env")) Object.assign(iso.env, { CLAUDE_CODE_DISABLE_BUILTIN_AGENTS: "1", CLAUDE_CODE_DISABLE_SLASH_COMMANDS: "1", CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1" });
const q = query({
  prompt: input(),
  options: {
    model: "claude-haiku-5-5",
    thinking: { type: "adaptive" }, effort: "medium",
    systemPrompt: variant.includes("tiny") ? "x" : buildSystemPrompt("Steve_AI"),
    mcpServers: variant.includes("notools") ? {} : { [MCP_SERVER_NAME]: buildSkillsServer(bot) },
    strictMcpConfig: true,
    ...iso,
    tools: [],
    allowedTools: variant.includes("notools") ? [] : [...ALLOWED_TOOL_NAMES],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    maxTurns: 3,
    ...extra,
  } as never,
});
for await (const m of q) {
  if (m.type === "assistant") console.log("ASSISTANT", JSON.stringify((m as any).message.content.filter((b:any)=>b.type==="text")));
  if (m.type === "system" && (m as any).subtype === "init") {
    const i = m as any;
    console.log("INIT", JSON.stringify({ tools: i.tools.length, plugins: i.plugins, skills: i.skills, slash: i.slash_commands.length, agents: i.agents }));
  }
  if (m.type === "result") {
    console.log("RESULT usage", JSON.stringify((m as any).usage));
    try {
      const u = await q.getContextUsage({ detail: "full" });
      console.log("CTX total", u.totalTokens, "api", JSON.stringify(u.apiUsage));
      console.log(JSON.stringify(u.categories.map((c) => [c.name, c.tokens, c.kind])));
      console.log("MB", JSON.stringify(u.messageBreakdown)); console.log("sysSections", JSON.stringify(u.systemPromptSections));
      console.log("systemTools", JSON.stringify(u.systemTools));
      console.log("agents", JSON.stringify(u.agents), "slash", JSON.stringify(u.slashCommands), "skills", JSON.stringify(u.skills?.totalSkills), u.skills?.tokens);
      console.log("memory", JSON.stringify(u.memoryFiles), "mcp tokens", u.mcpTools.reduce((a, t) => a + t.tokens, 0), u.mcpTools.length);
    } catch (e) { console.log("ctx err", e); }
    q.close();
    break;
  }
}
process.exit(0);
