import { NpcAgent, registerAgent, unregisterAgent } from "./agent/npc-agent.js";
import { loadConfig } from "./config.js";
import {
  registerSupervisor,
  startBotSupervisor,
  unregisterSupervisor,
  type BotSupervisor,
} from "./mineflayer-glue/bot-factory.js";
import { attachBotEventHooks } from "./mineflayer-glue/event-hooks.js";
import { installLogBuffer } from "./observability/log-buffer.js";
import { createBotState, registerBotState, unregisterBotState } from "./state/index.js";

// Patch console.* so every line we write is also retained for the dashboard
// log pane. Must run before any other module logs.
installLogBuffer();

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
      attachBotEventHooks(bot, botConfig.username, allBotUsernames, state);
    },
  });
  registerSupervisor(supervisor);
  return supervisor;
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`orchestrator: received ${signal}, disconnecting bots`);
  await Promise.all(supervisors.map((s) => s.stop()));
  await Promise.all(supervisors.map((s) => unregisterAgent(s.username)));
  for (const s of supervisors) {
    unregisterBotState(s.username);
    unregisterSupervisor(s.username);
  }
  console.log("orchestrator: bye");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Optional dashboard. Single-process model — quitting the dashboard SIGINTs
// the orchestrator. Dynamic import so the blessed/blessed-contrib trees only
// load when actually needed.
if (process.env.DASHBOARD === "1") {
  if (allBotUsernames.length === 0) {
    console.warn("DASHBOARD=1 set but no bots configured");
  } else {
    void import("./dashboard/index.js").then(({ mountDashboard }) => {
      // No-arg form pulls every registered bot; the dashboard cycles via Tab.
      mountDashboard();
    });
  }
}
