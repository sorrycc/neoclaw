import yargsParser from "yargs-parser";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { existsSync } from "fs";
import pkg from "../package.json";

const __pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
import { loadConfig, ensureWorkspaceDirs, watchConfig } from "./config/schema.js";
import { MessageBus } from "./bus/message-bus.js";
import { sessionKey, type InboundMessage } from "./bus/types.js";
import { ChannelManager } from "./channels/manager.js";
import { NeovateAgent } from "./agent/neovate-agent.js";
import { CronService } from "./services/cron.js";
import { HeartbeatService } from "./services/heartbeat.js";
import { handleCronCommand } from "./commands/cron.js";
import { handleStatusCommand } from "./commands/status.js";
import { handleOnboardCommand } from "./commands/onboard.js";

function showHelp(): void {
  console.log(`neoclaw v${pkg.version} - A multi-channel AI agent

Usage: neoclaw [command] [options]

Commands:
  (default)    Start the agent
  status       Show agent status and cron jobs
  onboard      Initialize workspace and configuration
  cron         Manage scheduled tasks
  help         Show this help message

Options:
  --profile <name>  Use a named profile (~/.neoclaw-<name>)
  --dev             Use dev profile (~/.neoclaw-dev)
  -h, --help        Show this help message
  -v, --version     Print version and exit`);
}

function resolveBaseDir(argv: yargsParser.Arguments): string {
  const { profile, dev } = argv;

  if (dev && profile) {
    console.error("Error: Cannot use --dev and --profile together");
    process.exit(1);
  }

  if (profile === true) {
    console.error("Error: --profile requires a name");
    process.exit(1);
  }

  const resolved = dev ? "dev" : (profile as string | undefined);
  return resolved
    ? join(homedir(), `.neoclaw-${resolved}`)
    : join(homedir(), ".neoclaw");
}

const INTERRUPT_COMMANDS = new Set(["/stop"]);

async function processMsg(bus: MessageBus, agent: NeovateAgent, msg: InboundMessage): Promise<void> {
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

async function mainLoop(bus: MessageBus, agent: NeovateAgent): Promise<void> {
  const running = new Map<string, Promise<void>>();

  while (true) {
    const msg = await bus.consumeInbound();
    const key = sessionKey(msg);

    if (INTERRUPT_COMMANDS.has(msg.content)) {
      processMsg(bus, agent, msg);
    } else {
      const prev = running.get(key) ?? Promise.resolve();
      const next = prev.then(() => processMsg(bus, agent, msg));
      running.set(key, next);
      next.then(() => { if (running.get(key) === next) running.delete(key); });
    }
  }
}

async function main(): Promise<void> {
  const argv = yargsParser(process.argv.slice(2));
  const baseDir = resolveBaseDir(argv);
  const subcommand = argv._[0] as string | undefined;

  if (argv.v || argv.version) {
    console.log(pkg.version);
    process.exit(0);
  }

  if (argv.h || argv.help || subcommand === "help") {
    showHelp();
    process.exit(0);
  }

  if (subcommand === "status") {
    const config = loadConfig(baseDir);
    ensureWorkspaceDirs(config.agent.workspace);
    const bus = new MessageBus();
    const cron = new CronService(config.agent.workspace, bus);
    console.log(handleStatusCommand(config, cron, baseDir));
    process.exit(0);
  }

  if (subcommand === "onboard") {
    await handleOnboardCommand(baseDir, __pkgRoot);
    process.exit(0);
  }

  if (subcommand === "cron") {
    const config = loadConfig(baseDir);
    ensureWorkspaceDirs(config.agent.workspace);
    const bus = new MessageBus();
    const cron = new CronService(config.agent.workspace, bus);
    const args = argv._.slice(1).map(String);
    console.log(handleCronCommand(cron, args));
    process.exit(0);
  }

  if (!existsSync(baseDir)) {
    console.error(`[neoclaw] profile not initialized at ${baseDir}`);
    console.error(`Run: neoclaw onboard${argv.profile ? ` --profile ${argv.profile}` : argv.dev ? " --dev" : ""}`);
    process.exit(1);
  }

  const config = loadConfig(baseDir);
  ensureWorkspaceDirs(config.agent.workspace);

  console.log("[neoclaw] starting...");
  console.log(`[neoclaw] model: ${config.agent.model}`);
  console.log(`[neoclaw] workspace: ${config.agent.workspace}`);

  const bus = new MessageBus();
  const cron = new CronService(config.agent.workspace, bus);
  const agent = new NeovateAgent(config, cron);
  const channelManager = new ChannelManager(config, bus);
  const heartbeat = new HeartbeatService(config.agent.workspace, bus);

  const configWatcher = watchConfig(baseDir, (newConfig) => {
    agent.updateConfig(newConfig);
    channelManager.updateConfig(newConfig);
  });

  process.on("SIGINT", async () => {
    console.log("\n[neoclaw] shutting down...");
    configWatcher.close();
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
