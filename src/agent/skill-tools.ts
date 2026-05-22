/**
 * Expose the skill layer to the Claude Agent SDK as MCP tools.
 *
 * One MCP server per bot — closures over the bot give each tool handler a
 * fixed bot reference without changing the underlying skill signatures.
 * Tool execution still goes through `runSkill` so exceptions become
 * `{ ok: false, message }` results and successful calls feed the
 * actions log + conversation-continuity tracker.
 *
 * The SDK auto-namespaces these names to `mcp__minecraft-skills__<tool>`;
 * the agent's `allowedTools` list uses that fully-qualified form.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "mineflayer";
import { z } from "zod";
import {
  advanceTaskQueue,
  goTo,
  mineBlock,
  observeSurroundings,
  remember,
  say,
  setTaskQueue,
  whisper,
} from "../skills/index.js";
import { runSkill } from "../skills/harness.js";
import type { SkillResult } from "../skills/types.js";

export const MCP_SERVER_NAME = "minecraft-skills";

const SKILL_NAMES = [
  "observeSurroundings",
  "say",
  "whisper",
  "goTo",
  "mineBlock",
  "remember",
  "setTaskQueue",
  "advanceTaskQueue",
] as const;

export const ALLOWED_TOOL_NAMES: readonly string[] = SKILL_NAMES.map(
  (n) => `mcp__${MCP_SERVER_NAME}__${n}`,
);

const goToTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coords"),
    coords: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  }),
  z.object({ kind: z.literal("entity"), entity: z.string() }),
  z.object({ kind: z.literal("block"), block: z.string() }),
]);

const posSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

export function buildSkillsServer(bot: Bot): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    tools: [
      tool(
        "observeSurroundings",
        "Look around. Returns nearby blocks (grouped by type with counts and nearest coords), nearby entities (players, mobs, dropped items), the bot's status (health, food, position, facing, time of day, weather), known storage from world memory, recent skill activity, recently-seen players, and the current task queue.",
        { radius: z.number().int().min(1).max(64).optional().describe("Search radius in blocks (default 16)") },
        async (args) => {
          const result = await runSkill(bot, "observeSurroundings", args, (p) =>
            observeSurroundings(bot, p),
          );
          return toToolResult(result);
        },
      ),

      tool(
        "say",
        "Send a message to public chat. Use this to reply to players who addressed you on public chat, and to narrate what you're doing during multi-step tasks. Keep messages short (one or two sentences). Messages over 256 chars are truncated.",
        { message: z.string().min(1) },
        async (args) => toToolResult(await runSkill(bot, "say", args, (p) => say(bot, p))),
      ),

      tool(
        "whisper",
        "Send a private message to a single player. Use this to reply to players who whispered you via /msg. Same length rules as `say`. Fails if the player is not currently online.",
        { player: z.string().min(1), message: z.string().min(1) },
        async (args) => toToolResult(await runSkill(bot, "whisper", args, (p) => whisper(bot, p))),
      ),

      tool(
        "goTo",
        "Pathfind to a target. Pre-checks reachability and fails fast (without committing to a doomed walk) if no path exists. Target is one of: { kind: 'coords', coords: { x, y, z } } | { kind: 'entity', entity: '<player or mob name>' } | { kind: 'block', block: '<block id>' }. Optional `reach` (default 1) sets stop distance in blocks.",
        {
          target: goToTargetSchema,
          reach: z.number().int().min(0).max(16).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "goTo", args, (p) => goTo(bot, p))),
      ),

      tool(
        "mineBlock",
        "Mine N blocks of a specific type. Composite: find → path → equip best tool → dig → wait for pickup. Fails fast (before any movement) if the required tool tier isn't in inventory. Partial progress is reported in state.mined on failure.",
        {
          type: z.string().min(1).describe("Block ID, e.g. 'oak_log', 'stone', 'iron_ore'"),
          count: z.number().int().min(1).max(64).optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "mineBlock", args, (p) => mineBlock(bot, p))),
      ),

      tool(
        "remember",
        "Record a named place into the bot's durable world knowledge (data/orchestrator/memory/<bot>/world.json). Use when a player names a location: 'this is the base', 'call this the wheat farm'. Position defaults to the bot's current location. Idempotent on (type, position).",
        {
          type: z.string().min(1).describe("Classification: 'base', 'portal', 'bed', 'crafting_table', 'home', etc."),
          name: z.string().optional(),
          pos: posSchema.optional(),
        },
        async (args) => toToolResult(await runSkill(bot, "remember", args, (p) => remember(bot, p))),
      ),

      tool(
        "setTaskQueue",
        "Declare a multi-step plan. The first task becomes the current task; the rest are queued. The current and remaining tasks appear in every `observeSurroundings` call, so you do not need to remember them from chat history. Use for chained requests: 'get wood, then iron, then come back'.",
        { tasks: z.array(z.string().min(1)).min(1) },
        async (args) =>
          toToolResult(await runSkill(bot, "setTaskQueue", args, (p) => setTaskQueue(bot, p))),
      ),

      tool(
        "advanceTaskQueue",
        "Mark the current task done and promote the next one. Returns 'task queue drained' when nothing remains. Call between steps of a `setTaskQueue` plan.",
        {},
        async () =>
          toToolResult(await runSkill(bot, "advanceTaskQueue", undefined, () => advanceTaskQueue(bot))),
      ),
    ],
  });
}

function toToolResult(result: SkillResult): {
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
