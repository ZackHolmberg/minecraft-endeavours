/**
 * Backend adapters — turn the neutral `SkillSpec[]` registry into
 * backend-specific tool definitions.
 *
 * Two adapters:
 *  - `toClaudeMcpServer` — Claude Agent SDK `tool()` defs (Phase A).
 *  - `toOpenAITools` — OpenAI-style function defs for the local backend, driven
 *    off the same neutral registry (Phase B).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "mineflayer";
import { z } from "zod";
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

/** An OpenAI-style function tool definition (what `mlx_lm.server` consumes). */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Turn the neutral specs into OpenAI function tools for `mlx_lm.server`.
 * Each spec's raw zod shape is wrapped in `z.object` and converted to JSON
 * Schema (draft-2020-12) via `z.toJSONSchema` — validated in the spikes,
 * including the `goTo` discriminated union (emits `oneOf`). The top-level
 * `$schema` key is stripped: mlx ignores it, but stricter servers may complain.
 */
export function toOpenAITools(specs: SkillSpec[]): OpenAITool[] {
  return specs.map((spec) => {
    const parameters = z.toJSONSchema(z.object(spec.schema), {
      io: "input",
    }) as Record<string, unknown>;
    delete parameters.$schema;
    return {
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters,
      },
    };
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
