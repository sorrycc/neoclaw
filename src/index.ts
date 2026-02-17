import yargsParser from "yargs-parser";
import { loadConfig, ensureWorkspaceDirs } from "./config/schema.js";
import { MessageBus } from "./bus/message-bus.js";
import { ChannelManager } from "./channels/manager.js";
import { NeovateAgent } from "./agent/neovate-agent.js";
import { CronService } from "./services/cron.js";
import { HeartbeatService } from "./services/heartbeat.js";
import { handleCronCommand } from "./commands/cron.js";
import { handleStatusCommand } from "./commands/status.js";

async function mainLoop(bus: MessageBus, agent: NeovateAgent): Promise<void> {
  while (true) {
    const msg = await bus.consumeInbound();
    try {
      for await (const response of agent.processMessage(msg)) {
        bus.publishOutbound(response);
      }
    } catch (err) {
      console.error("[main] error processing message:", err);
      bus.publishOutbound({
        channel: msg.channel,
        chatId: msg.chatId,
        content: "Sorry, an error occurred processing your message.",
        media: [],
        metadata: {},
      });
    }
  }
}

async function main(): Promise<void> {
  const argv = yargsParser(process.argv.slice(2));
  const subcommand = argv._[0] as string | undefined;

  if (subcommand === "status") {
    const config = loadConfig();
    ensureWorkspaceDirs(config.agent.workspace);
    const bus = new MessageBus();
    const cron = new CronService(config.agent.workspace, bus);
    console.log(handleStatusCommand(config, cron));
    process.exit(0);
  }

  if (subcommand === "cron") {
    const config = loadConfig();
    ensureWorkspaceDirs(config.agent.workspace);
    const bus = new MessageBus();
    const cron = new CronService(config.agent.workspace, bus);
    const args = argv._.slice(1).map(String);
    console.log(handleCronCommand(cron, args));
    process.exit(0);
  }

  const config = loadConfig();
  ensureWorkspaceDirs(config.agent.workspace);

  console.log("[neoclaw] starting...");
  console.log(`[neoclaw] model: ${config.agent.model}`);
  console.log(`[neoclaw] workspace: ${config.agent.workspace}`);

  const bus = new MessageBus();
  const cron = new CronService(config.agent.workspace, bus);
  const agent = new NeovateAgent(config, cron);
  const channelManager = new ChannelManager(config, bus);
  const heartbeat = new HeartbeatService(config.agent.workspace, bus);

  process.on("SIGINT", async () => {
    console.log("\n[neoclaw] shutting down...");
    await channelManager.stop();
    cron.stop();
    heartbeat.stop();
    process.exit(0);
  });

  await Promise.all([
    mainLoop(bus, agent),
    channelManager.startAll(),
    cron.start(),
    heartbeat.start(),
  ]);
}

main().catch((err) => {
  console.error("[neoclaw] fatal:", err);
  process.exit(1);
});
