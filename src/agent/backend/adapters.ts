/**
 * Backend adapters — turn the neutral `SkillSpec[]` registry into
 * backend-specific tool definitions.
 *
 * Phase A ships only the Claude adapter (`toClaudeMcpServer`). The OpenAI
 * adapter (`toOpenAITools`) for the local backend lands in Phase B, when it's
 * actually exercised.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "mineflayer";
import type { SkillSpec } from "../../skills/registry.js";
import type { SkillResult } from "../../skills/types.js";

/**
 * Build the per-bot MCP server the Claude Agent SDK consumes, rebuilding one
 * `tool()` per spec. Each handler closes over `bot` and dispatches through
 * `spec.run` (which wraps `runSkill`), so the SDK validates args against the
 * spec's zod shape, then our cross-cutting concerns run unchanged.
 */
export function toClaudeMcpServer(
  name: string,
  bot: Bot,
  specs: SkillSpec[],
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name,
    tools: specs.map((spec) =>
      tool(spec.name, spec.description, spec.schema, async (args) =>
        toToolResult(await spec.run(bot, args)),
      ),
    ),
  });
}

/** Format a `SkillResult` as the MCP tool-call result the SDK expects. */
export function toToolResult(result: SkillResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: result.ok,
          message: result.message,
          ...(result.state ? { state: result.state } : {}),
        }),
      },
    ],
    isError: !result.ok,
  };
}
