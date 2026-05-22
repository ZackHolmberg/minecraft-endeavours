import { NpcAgent, registerAgent, unregisterAgent } from "./agent/npc-agent.js";
import { loadConfig } from "./config.js";
import { startBotSupervisor, type BotSupervisor } from "./mineflayer-glue/bot-factory.js";
import { attachBotEventHooks } from "./mineflayer-glue/event-hooks.js";
import { attachChatTriggerHarness } from "./skills/chat-trigger.js";
import { createBotState, registerBotState, unregisterBotState } from "./state/index.js";

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

  return startBotSupervisor({
    botConfig,
    host: config.mcHost,
    port: config.mcPort,
    onConnect: (bot) => {
      attachBotEventHooks(bot, botConfig.username, allBotUsernames, state);
      attachChatTriggerHarness(bot, botConfig.username);
      // Fresh agent per connection — conversation context is intentionally
      // not preserved across reconnects (durable knowledge lives in
      // world.json). Replacing in the registry triggers `stop()` on the
      // previous agent.
      registerAgent(botConfig.username, new NpcAgent({ bot, botConfig }));
    },
  });
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`orchestrator: received ${signal}, disconnecting bots`);
  await Promise.all(supervisors.map((s) => s.stop()));
  await Promise.all(supervisors.map((s) => unregisterAgent(s.username)));
  for (const s of supervisors) unregisterBotState(s.username);
  console.log("orchestrator: bye");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
