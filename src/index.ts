import { loadConfig } from "./config.js";
import { startBotSupervisor, type BotSupervisor } from "./mineflayer-glue/bot-factory.js";
import { attachStubEventHooks } from "./mineflayer-glue/event-hooks.js";

const config = loadConfig();
console.log(
  `orchestrator: starting ${config.bots.length} bot(s), target ${config.mcHost}:${config.mcPort}`,
);

const supervisors: BotSupervisor[] = config.bots.map((botConfig) =>
  startBotSupervisor({
    botConfig,
    host: config.mcHost,
    port: config.mcPort,
    onConnect: (bot) => attachStubEventHooks(bot, botConfig.username),
  }),
);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`orchestrator: received ${signal}, disconnecting bots`);
  await Promise.all(supervisors.map((s) => s.stop()));
  console.log("orchestrator: bye");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
