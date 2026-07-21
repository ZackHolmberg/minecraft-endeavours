/**
 * Claude-facing view of the skill layer.
 *
 * The skill definitions (name / description / zod shape / dispatch) now live in
 * the neutral registry (`src/skills/registry.ts`). This module is the thin
 * Claude adapter over that registry: it filters to the `claude` surface (all 35
 * today, preserving the current behavior), builds the per-bot MCP server via
 * `toClaudeMcpServer`, and exposes the fully-qualified allowed-tool names.
 *
 * The SDK auto-namespaces these names to `mcp__minecraft-skills__<tool>`;
 * the agent's `allowedTools` list uses that fully-qualified form.
 */

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "mineflayer";
import { SKILL_SPECS } from "../skills/registry.js";
import { toClaudeMcpServer } from "./backend/adapters.js";

export const MCP_SERVER_NAME = "minecraft-skills";

const CLAUDE_SPECS = SKILL_SPECS.filter((s) => s.surfaces.claude);

export const ALLOWED_TOOL_NAMES: readonly string[] = CLAUDE_SPECS.map(
  (s) => `mcp__${MCP_SERVER_NAME}__${s.name}`,
);

export function buildSkillsServer(bot: Bot): McpSdkServerConfigWithInstance {
  return toClaudeMcpServer(MCP_SERVER_NAME, bot, CLAUDE_SPECS);
}
