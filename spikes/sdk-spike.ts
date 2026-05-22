/**
 * SDK spike — pin down the @anthropic-ai/claude-agent-sdk surface BEFORE
 * building the orchestrator on top of it.
 *
 * Goals:
 *   1. Tool-definition shape  → use `tool(...)` + `createSdkMcpServer(...)`
 *   2. Model selection        → `options.model: 'claude-sonnet-4-6'`
 *   3. Session state          → one `query()` call returns an AsyncGenerator
 *                               of SDKMessage; streaming-input mode lets us
 *                               feed multiple user turns into one query
 *   4. Caching                → SDKResultSuccess.usage shows cache_*_tokens
 *   5. Rate-limit signal      → SDKRateLimitEvent in the stream + the
 *                               'rate_limit' value of SDKAssistantMessageError
 *
 * Run with:  npx tsx spikes/sdk-spike.ts
 *
 * Auth: relies on the user's existing Claude Code login on this machine
 * (Pro subscription). No ANTHROPIC_API_KEY needed.
 *
 * Findings are summarised in spikes/SDK_NOTES.md so future-you doesn't have
 * to re-read 5800 lines of .d.ts.
 */

import {
  query,
  tool,
  createSdkMcpServer,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Define a stub tool shaped like our real `observeSurroundings` skill.
//    Returns canned data so the model can describe what the bot "sees" —
//    proves the round-trip without needing mineflayer / a running MC server.
// ─────────────────────────────────────────────────────────────────────────────

const observeSurroundingsStub = tool(
  "observeSurroundings",
  "Look at the bot's immediate surroundings. Returns nearby blocks (grouped by type), entities, and the bot's status.",
  {
    radius: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe("Search radius in blocks (default 16)"),
  },
  async ({ radius = 16 }) => {
    const cannedState = {
      position: { x: 100, y: 64, z: -200 },
      facing: "north",
      time: { timeOfDay: 1200, phase: "day" },
      weather: "clear",
      status: { health: 20, food: 18 },
      nearbyBlocks: [
        { type: "oak_log", count: 7, nearest: { x: 104, y: 65, z: -198, dist: 4.5 } },
        { type: "chest", count: 1, nearest: { x: 99, y: 64, z: -201, dist: 1.4 } },
      ],
      nearbyEntities: [
        { type: "player", name: "Zack", dist: 3.2 },
        { type: "passive", name: "cow", dist: 8.7 },
      ],
      radiusUsed: radius,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(cannedState) }],
    };
  },
);

const skillsServer = createSdkMcpServer({
  name: "minecraft-skills",
  tools: [observeSurroundingsStub],
});

// MCP tool names are namespaced as `mcp__<server-name>__<tool-name>`.
const OBSERVE_TOOL_NAME = "mcp__minecraft-skills__observeSurroundings";

// ─────────────────────────────────────────────────────────────────────────────
// 2. System prompt — minimal NPC framing. Real slice-4 system-prompt.ts will
//    be richer; this is just enough to make the model want to call the tool.
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an NPC in a Minecraft server, named Steve_AI.
A player is chatting with you. To find out what's around you, call the
observeSurroundings tool. After you have observed, reply in one short sentence
describing what you see.`;

// ─────────────────────────────────────────────────────────────────────────────
// 3. Run a query and trace every message that flows through the stream.
//    Highlights: tool_use round-trip, cache hits in usage, rate-limit events.
// ─────────────────────────────────────────────────────────────────────────────

interface TraceSummary {
  messageTypes: Record<string, number>;
  toolCalls: Array<{ name: string; input: unknown }>;
  toolResults: Array<{ name?: string; preview: string }>;
  finalText: string | null;
  usage: unknown;
  rateLimitEvents: unknown[];
  errors: string[];
}

async function runQuery(prompt: string, label: string): Promise<TraceSummary> {
  console.log(`\n━━━ ${label} ━━━`);
  console.log(`prompt: ${prompt}`);

  const summary: TraceSummary = {
    messageTypes: {},
    toolCalls: [],
    toolResults: [],
    finalText: null,
    usage: null,
    rateLimitEvents: [],
    errors: [],
  };

  const stream = query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "minecraft-skills": skillsServer },
      // Disable Claude Code built-in tools — our NPC only sees skill tools.
      tools: [],
      // Auto-allow our skill tools so the agent runs unattended.
      allowedTools: [OBSERVE_TOOL_NAME],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
    },
  });

  for await (const message of stream) {
    bumpCount(summary.messageTypes, message.type);
    inspectMessage(message, summary);
  }

  printSummary(summary);
  return summary;
}

function inspectMessage(message: SDKMessage, summary: TraceSummary): void {
  switch (message.type) {
    case "assistant": {
      const blocks = message.message?.content ?? [];
      for (const block of blocks as Array<{ type: string; text?: string; name?: string; input?: unknown }>) {
        if (block.type === "text" && typeof block.text === "string") {
          summary.finalText = block.text;
        }
        if (block.type === "tool_use") {
          summary.toolCalls.push({ name: block.name ?? "?", input: block.input });
        }
      }
      if (message.error) {
        summary.errors.push(`assistant error: ${message.error}`);
      }
      break;
    }
    case "user": {
      const blocks = (message.message?.content ?? []) as Array<{ type: string; content?: unknown; tool_use_id?: string }>;
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const preview = JSON.stringify(block.content).slice(0, 120);
          summary.toolResults.push({ preview });
        }
      }
      break;
    }
    case "result": {
      summary.usage = (message as { usage?: unknown }).usage ?? null;
      break;
    }
    case "rate_limit_event": {
      summary.rateLimitEvents.push((message as { rate_limit_info?: unknown }).rate_limit_info);
      break;
    }
    default:
      // system, partial, hook, status, etc. — counted but not deeply inspected
      break;
  }
}

function printSummary(s: TraceSummary): void {
  console.log("\nmessage type counts:");
  for (const [k, v] of Object.entries(s.messageTypes)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`tool calls: ${s.toolCalls.length}`);
  for (const c of s.toolCalls) {
    console.log(`  → ${c.name}(${JSON.stringify(c.input)})`);
  }
  console.log(`tool results: ${s.toolResults.length}`);
  for (const r of s.toolResults) {
    console.log(`  ← ${r.preview}${r.preview.length >= 120 ? "…" : ""}`);
  }
  if (s.rateLimitEvents.length) {
    console.log(`rate-limit events: ${s.rateLimitEvents.length}`);
    for (const e of s.rateLimitEvents) console.log(`  ${JSON.stringify(e)}`);
  }
  if (s.errors.length) {
    console.log(`errors: ${JSON.stringify(s.errors)}`);
  }
  console.log(`\nfinal assistant text:\n  ${s.finalText ?? "(none)"}`);
  console.log(`\nusage: ${JSON.stringify(s.usage, null, 2)}`);
}

function bumpCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Main — run two queries to verify caching across turns.
//    First call: cache miss (cache_creation_input_tokens > 0).
//    Second call: cache hit (cache_read_input_tokens > 0) — proves the
//    system prompt + tool defs survive between independent `query()` calls.
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const first = await runQuery(
    "Look around and tell me what you see.",
    "Turn 1 — cold cache",
  );
  const second = await runQuery(
    "Take another look. Anything different?",
    "Turn 2 — warm cache (should show cache_read_input_tokens > 0)",
  );

  console.log("\n━━━ caching delta ━━━");
  console.log(`turn 1 usage: ${JSON.stringify(first.usage)}`);
  console.log(`turn 2 usage: ${JSON.stringify(second.usage)}`);
}

main().catch((err) => {
  console.error("spike crashed:", err);
  process.exit(1);
});
