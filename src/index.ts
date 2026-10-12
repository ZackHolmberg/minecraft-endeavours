import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { NpcAgent, registerAgent, unregisterAgent } from "./agent/npc-agent.js";
import { loadConfig } from "./config.js";
import { attachJobRunner } from "./jobs/wire.js";
import { unregisterJobRunner } from "./jobs/registry.js";
import {
  registerSupervisor,
  startBotSupervisor,
  unregisterSupervisor,
  type BotSupervisor,
} from "./mineflayer-glue/bot-factory.js";
import { attachBotEventHooks } from "./mineflayer-glue/event-hooks.js";
import { installLogBuffer } from "./observability/log-buffer.js";
import { stopTelemetry } from "./observability/telemetry.js";
import { PID_PATH, SNAPSHOT_PATH } from "./runtime-paths.js";
import { startSnapshotWriter } from "./snapshot-writer.js";
import { createBotState, registerBotState, unregisterBotState } from "./state/index.js";

// Patch console.* so every line we write is also retained for the dashboard
// log pane. Must run before any other module logs.
installLogBuffer();

// Drop our own PID so `scripts/botStop.sh` and the viewer scripts can find
// us — bypasses the npm/tsx wrapper PID problem.
mkdirSync(dirname(PID_PATH), { recursive: true });
writeFileSync(PID_PATH, String(process.pid));

const config = loadConfig();
console.log(
  `orchestrator: starting ${config.bots.length} bot(s), target ${config.mcHost}:${config.mcPort}`,
);

const allBotUsernames: readonly string[] = config.bots.map((b) => b.username);

const supervisors: BotSupervisor[] = config.bots.map((botConfig) => {
  // State outlives the bot connection — a brief disconnect shouldn't erase
  // what happened 30 seconds ago. Lifetime ends with the orchestrator.
  const state = createBotState();
  registerBotState(botConfig.username, state);

  const supervisor = startBotSupervisor({
    botConfig,
    host: config.mcHost,
    port: config.mcPort,
    version: config.mcVersion,
    onConnect: (bot) => {
      // Fresh agent per connection — conversation context is intentionally
      // not preserved across reconnects (durable knowledge lives in
      // world.json). Replacing in the registry triggers `stop()` on the
      // previous agent.
      registerAgent(botConfig.username, new NpcAgent({ bot, botConfig }));
      void attachJobRunner(bot, botConfig.username, state).catch((err) => {
        console.error(`[${botConfig.username}] job runner setup failed:`, err);
      });
      attachBotEventHooks(bot, botConfig.username, allBotUsernames, state);
    },
  });
  registerSupervisor(supervisor);
  return supervisor;
});

// Stream every bot's state to disk so the out-of-process dashboard
// (`scripts/dashboard.sh`) can render without sharing memory with us.
const stopSnapshotWriter = startSnapshotWriter(SNAPSHOT_PATH);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`orchestrator: received ${signal}, disconnecting bots`);
  stopSnapshotWriter();
  // Runners first: a running job ends as `interrupted` (persisted, no event) before
  // the bots disconnect, instead of failing steps on a dead connection.
  await Promise.all(supervisors.map((s) => unregisterJobRunner(s.username)));
  await Promise.all(supervisors.map((s) => s.stop()));
  await Promise.all(supervisors.map((s) => unregisterAgent(s.username)));
  // After the agents stop (they record their in-flight task_end), before exit.
  try {
    await stopTelemetry();
  } catch (err) {
    console.warn("orchestrator: telemetry flush failed", err);
  }
  for (const s of supervisors) {
    unregisterBotState(s.username);
    unregisterSupervisor(s.username);
  }
  for (const path of [PID_PATH, SNAPSHOT_PATH]) {
    try {
      unlinkSync(path);
    } catch {
      // already gone — fine
    }
  }
  console.log("orchestrator: bye");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
