import type { Bot } from "mineflayer";
import { runSkill } from "./harness.js";
import { say } from "./chat.js";
import { observeSurroundings } from "./perception.js";
import { goTo, stopMovement } from "./movement.js";
import { mineBlock } from "./world.js";
import { advanceTaskQueue, remember, setTaskQueue } from "./meta.js";
import { getAgent } from "../agent/npc-agent.js";
import type { GoToTarget, SkillResult } from "./types.js";

/**
 * Manual driver: listens for `!cmd args` from any player and invokes the
 * matching skill. Lets us exercise the skill layer end-to-end before the
 * Claude loop is wired in slice 3. Echoes results in chat so the tester can
 * see what happened without watching the console.
 *
 * Supported commands:
 *   !say <message>
 *   !observe [radius]
 *   !goto <player|mob> | !goto <x> <y> <z> | !goto block <name>
 *   !mine <block> [count]
 *   !stop
 *   !queue <task1>; <task2>; ...   (calls the setTaskQueue meta skill)
 *   !advance                        (calls the advanceTaskQueue meta skill)
 *   !remember <type> [name]         (calls the remember meta skill — uses current pos)
 *   !ask <message>                  (pushes a synthetic chat into the NPC agent's queue)
 */
export function attachChatTriggerHarness(bot: Bot, username: string): void {
  const tag = `[${username}]`;
  let busy = false;

  const handle = async (sender: string, raw: string, channel: "chat" | "whisper") => {
    if (sender === username) return;
    if (!raw.startsWith("!")) return;
    const [cmd, ...args] = raw.slice(1).trim().split(/\s+/);
    if (!cmd) return;

    if (busy && cmd !== "stop") {
      reply(bot, sender, channel, `busy — say !stop to cancel`);
      return;
    }

    console.log(`${tag} chat-trigger from ${sender}: ${raw}`);
    busy = cmd !== "stop";
    try {
      const result = await dispatch(bot, sender, cmd, args, raw);
      reply(bot, sender, channel, formatResult(cmd, result));
    } finally {
      busy = false;
    }
  };

  bot.on("chat", (sender, message) => void handle(sender, message, "chat"));
  bot.on("whisper", (sender, message) => void handle(sender, message, "whisper"));
}

async function dispatch(
  bot: Bot,
  sender: string,
  cmd: string,
  args: string[],
  raw: string,
): Promise<SkillResult> {
  switch (cmd) {
    case "say":
      return runSkill(bot, "say", { message: args.join(" ") }, (p) => say(bot, p));

    case "observe": {
      const radius = args[0] ? Number(args[0]) : undefined;
      return runSkill(bot, "observeSurroundings", { radius }, (p) => observeSurroundings(bot, p));
    }

    case "goto": {
      const target = parseGoToTarget(args);
      if (!target) {
        return {
          ok: false,
          message: "usage: !goto <player|mob> | !goto <x> <y> <z> | !goto block <name>",
        };
      }
      return runSkill(bot, "goTo", { target }, (p) => goTo(bot, p));
    }

    case "mine": {
      const type = args[0];
      const count = args[1] ? Number(args[1]) : 1;
      if (!type) return { ok: false, message: "usage: !mine <block> [count]" };
      if (Number.isNaN(count) || count < 1) {
        return { ok: false, message: `count must be a positive integer (got "${args[1]}")` };
      }
      return runSkill(bot, "mineBlock", { type, count }, (p) => mineBlock(bot, p));
    }

    case "stop":
      return stopMovement(bot);

    case "queue": {
      // Re-split the original line so semicolon-separated tasks survive the
      // whitespace tokenization the dispatcher does above.
      const body = raw.replace(/^!\w+\s*/, "");
      const tasks = body.split(";").map((t) => t.trim()).filter((t) => t.length > 0);
      if (tasks.length === 0) {
        return { ok: false, message: "usage: !queue <task1>; <task2>; ..." };
      }
      return runSkill(bot, "setTaskQueue", { tasks }, (p) => setTaskQueue(bot, p));
    }

    case "advance":
      return runSkill(bot, "advanceTaskQueue", undefined, () => advanceTaskQueue(bot));

    case "remember": {
      const type = args[0];
      if (!type) return { ok: false, message: "usage: !remember <type> [name]" };
      const name = args.slice(1).join(" ").trim() || undefined;
      return runSkill(bot, "remember", { type, name }, (p) => remember(bot, p));
    }

    case "ask": {
      const message = args.join(" ").trim();
      if (!message) return { ok: false, message: "usage: !ask <message>" };
      const agent = getAgent(bot.username);
      if (!agent) return { ok: false, message: "no agent registered for this bot" };
      if (agent.isRateLimited()) {
        return { ok: false, message: "agent is rate-limited; try again later" };
      }
      agent.pushChat(
        { channel: "chat", sender, message },
        { channel: "chat", reason: "name-mention" },
      );
      return { ok: true, message: `pushed to ${bot.username}'s agent` };
    }

    default:
      return { ok: false, message: `unknown command "!${cmd}"` };
  }
}

function parseGoToTarget(args: string[]): GoToTarget | null {
  if (args.length === 0) return null;
  if (args[0] === "block" && args[1]) {
    return { kind: "block", block: args[1] };
  }
  if (args.length === 3) {
    const [xs, ys, zs] = args;
    const x = Number(xs);
    const y = Number(ys);
    const z = Number(zs);
    if ([x, y, z].some(Number.isNaN)) return null;
    return { kind: "coords", coords: { x, y, z } };
  }
  if (args.length === 1 && args[0]) {
    return { kind: "entity", entity: args[0] };
  }
  return null;
}

function reply(bot: Bot, sender: string, channel: "chat" | "whisper", message: string): void {
  // Use a fresh chat line for chat triggers; whisper back for /msg triggers.
  if (channel === "whisper") {
    bot.whisper(sender, message);
  } else {
    bot.chat(message);
  }
}

function formatResult(cmd: string, result: SkillResult): string {
  const tag = result.ok ? "ok" : "fail";
  const detail = result.message ?? "";
  const head = `[${tag}] ${cmd}: ${detail}`;
  // observeSurroundings produces a fat state object — summarise rather than dump.
  if (cmd === "observe" && result.ok && result.state) {
    const s = result.state as {
      nearbyBlocks?: Array<{ type: string; count: number; nearest: { dist: number } }>;
      nearbyEntities?: Array<{ type: string; name: string; dist: number }>;
    };
    const blocks = (s.nearbyBlocks ?? [])
      .slice(0, 5)
      .map((b) => `${b.count}× ${b.type}@${b.nearest.dist}`)
      .join(", ");
    const entities = (s.nearbyEntities ?? [])
      .slice(0, 5)
      .map((e) => `${e.name}(${e.type})@${e.dist}`)
      .join(", ");
    return `${head} | blocks: ${blocks || "none"} | entities: ${entities || "none"}`;
  }
  return head;
}
