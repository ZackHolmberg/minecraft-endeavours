/** One-line summary of the SDK session `system/init` message (dependency-free so it can be unit-tested). */

const MCP_SERVER_NAME = "minecraft-skills"; // = skill-tools.ts MCP_SERVER_NAME

/** The subset of the SDK `system/init` message we summarise. */
export interface InitLike {
  tools?: string[];
  mcp_servers?: Array<{ name: string; status?: string }>;
  plugins?: unknown[];
  skills?: string[];
  slash_commands?: string[];
  agents?: string[];
  cwd?: string;
}

/**
 * Compact one-line summary of what an SDK session loaded: tool count (and any tool NOT from our
 * skill MCP server, which would mean user settings leaked in), MCP servers, plugins, skills, slash commands.
 */
export function summarizeInit(m: InitLike): string {
  const tools = m.tools ?? [];
  const foreign = tools.filter((t) => !t.startsWith(`mcp__${MCP_SERVER_NAME}__`));
  const mcp = (m.mcp_servers ?? []).map((s) => `${s.name}${s.status && s.status !== "connected" ? `(${s.status})` : ""}`);
  const slash = m.slash_commands ?? [];
  return (
    `tools=${tools.length} foreign=${foreign.length}${foreign.length ? `[${foreign.slice(0, 6).join(",")}]` : ""}` +
    ` mcp=[${mcp.join(",")}] plugins=${(m.plugins ?? []).length} skills=${(m.skills ?? []).length}` +
    ` slash=${slash.length}${slash.length ? `[${slash.slice(0, 5).join(",")}]` : ""} agents=${(m.agents ?? []).length}`
  );
}
