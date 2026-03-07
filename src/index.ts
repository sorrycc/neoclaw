import yargsParser from "yargs-parser";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { existsSync } from "fs";
import pkg from "../package.json";

const __pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
import { loadConfig, ensureWorkspaceDirs, watchConfig } from "./config/schema.js";
import { logger, setLevel } from "./logger.js";
import { MessageBus } from "./bus/message-bus.js";
import { replyTarget, sessionKey, type InboundMessage } from "./bus/types.js";
import { ChannelManager } from "./channels/manager.js";
import { NeovateAgent } from "./agent/neovate-agent.js";
import { CronService } from "./services/cron.js";
import { HeartbeatService } from "./services/heartbeat.js";
import { handleCronCommand } from "./commands/cron.js";
import { handleStatusCommand } from "./commands/status.js";
import { handleOnboardCommand } from "./commands/onboard.js";
import { handleWebCommand, parseWebHost, parseWebPort } from "./commands/web.js";
import { RuntimeStatusStore } from "./runtime/status-store.js";
let activeStatusStore: RuntimeStatusStore | null = null;

function showHelp(): void {
  console.log(`neoclaw v${pkg.version} - A multi-channel AI agent

Usage: neoclaw [command] [options]

Commands:
  (default)    Start the agent
  status       Show agent status and cron jobs
  onboard      Initialize workspace and configuration
  cron         Manage scheduled tasks
  web          Open web config panel
  help         Show this help message

Options:
  --profile <name>  Use a named profile (~/.neoclaw-<name>)
  --dev             Use dev profile (~/.neoclaw-dev)
  --mode <mode>     Onboard mode (for onboard command): default|web
  --host <host>     Bind host for web command (default: 127.0.0.1)
  --port <port>     Bind port for web command (default: 8788)
  --token <token>   Web auth token (for web / onboard --mode web)
  -y, --yes         Auto-confirm prompts (for onboard command)
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

function resolveOnboardMode(argv: yargsParser.Arguments): "default" | "web" {
  const raw = argv.mode;
  if (raw === undefined) return "default";
  if (typeof raw !== "string") {
    console.error("Error: --mode requires a value (default|web)");
    process.exit(1);
  }

  const mode = raw.trim().toLowerCase();
  if (mode === "default" || mode === "file") return "default";
  if (mode === "web") return "web";

  console.error(`Error: invalid --mode "${raw}", expected default|web`);
  process.exit(1);
}

function resolveWebOptions(argv: yargsParser.Arguments): { host: string; port: number; token?: string } {
  return {
    host: parseWebHost(argv.host),
    port: parseWebPort(argv.port),
    token: typeof argv.token === "string" ? argv.token : undefined,
  };
}

function resolveProfileArgs(argv: yargsParser.Arguments): string[] {
  if (typeof argv.profile === "string" && argv.profile.trim()) {
    return ["--profile", argv.profile.trim()];
  }
  if (argv.dev) return ["--dev"];
  return [];
}

const INTERRUPT_COMMANDS = new Set(["/stop"]);

async function processMsg(
  bus: MessageBus,
  agent: NeovateAgent,
  msg: InboundMessage,
  statusStore?: RuntimeStatusStore,
): Promise<void> {
  try {
    for await (const response of agent.processMessage(msg)) {
      bus.publishOutbound(response);
    }
  } catch (err) {
    logger.error("main", `error processing message, session=${sessionKey(msg)}:`, err);
    statusStore?.pushError("main:process", err);
    const { channel, chatId } = replyTarget(msg);
    bus.publishOutbound({
      channel,
      chatId,
      content: "Sorry, an error occurred processing your message.",
      media: [],
      metadata: {},
    });
  }
}

async function mainLoop(bus: MessageBus, agent: NeovateAgent, statusStore?: RuntimeStatusStore): Promise<void> {
  const running = new Map<string, Promise<void>>();

  while (true) {
    const msg = await bus.consumeInbound();
    if (!msg) break;
    const key = sessionKey(msg);

    if (INTERRUPT_COMMANDS.has(msg.content)) {
      processMsg(bus, agent, msg, statusStore);
    } else {
      const prev = running.get(key) ?? Promise.resolve();
      const next = prev.then(() => processMsg(bus, agent, msg, statusStore));
      running.set(key, next);
      next.then(() => { if (running.get(key) === next) running.delete(key); });
    }
  }
}

async function runAgent(baseDir: string, profileHint: string): Promise<void> {
  if (!existsSync(baseDir)) {
    logger.error("neoclaw", `profile not initialized at ${baseDir}`);
    logger.error("neoclaw", `Run: neoclaw onboard${profileHint}`);
    process.exit(1);
  }

  const config = loadConfig(baseDir);
  ensureWorkspaceDirs(config.agent.workspace);

  if (!config.agent.model) {
    logger.error("neoclaw", "no model configured — set agent.model in config.json or NEOCLAW_MODEL env");
    process.exit(1);
  }

  if (config.logLevel) setLevel(config.logLevel);

  logger.info("neoclaw", `starting v${pkg.version}, profile=${baseDir}`);
  logger.info("neoclaw", `model: ${config.agent.model}`);
  logger.info("neoclaw", `workspace: ${config.agent.workspace}`);

  const statusStore = new RuntimeStatusStore(baseDir);
  activeStatusStore = statusStore;
  statusStore.markAgentRunning();

  const bus = new MessageBus();
  const cron = new CronService(config.agent.workspace, bus);
  await cron.init();
  const agent = await NeovateAgent.create(config, cron, bus);
  const channelManager = new ChannelManager(config, bus, statusStore);
  const heartbeat = new HeartbeatService(config.agent.workspace, bus);

  const configWatcher = watchConfig(baseDir, (newConfig) => {
    if (newConfig.logLevel) setLevel(newConfig.logLevel);
    agent.updateConfig(newConfig);
    void channelManager.updateConfig(newConfig).catch((err) => {
      logger.error("neoclaw", "failed to dynamically update channels:", err);
      statusStore.pushError("config:update", err);
    });
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("neoclaw", "shutting down...");
    configWatcher.close();
    await channelManager.stop();
    cron.stop();
    heartbeat.stop();
    statusStore.markAgentStopped();
    activeStatusStore = null;
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await Promise.all([
    mainLoop(bus, agent, statusStore),
    channelManager.startAll(),
    cron.start(),
    heartbeat.start(),
  ]);
}

async function main(): Promise<void> {
  const argv = yargsParser(process.argv.slice(2));
  const baseDir = resolveBaseDir(argv);
  const subcommand = argv._[0] as string | undefined;
  const profileHint = argv.profile ? ` --profile ${argv.profile}` : argv.dev ? " --dev" : "";

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
    await cron.init();
    console.log(handleStatusCommand(config, cron, baseDir));
    process.exit(0);
  }

  if (subcommand === "onboard") {
    const mode = resolveOnboardMode(argv);
    const profileArgs = resolveProfileArgs(argv);
    const result = await handleOnboardCommand({
      baseDir,
      pkgRoot: __pkgRoot,
      profileFlag: profileHint,
      force: !!(argv.yes || argv.y),
      mode,
    });
    console.log(result);

    if (mode === "web") {
      const webResult = await handleWebCommand({
        baseDir,
        ...resolveWebOptions(argv),
        autoStart: {
          enabled: true,
          startArgs: profileArgs,
        },
      });
      if (webResult.startAgent) await runAgent(baseDir, profileHint);
    }

    process.exit(0);
  }

  if (subcommand === "cron") {
    const config = loadConfig(baseDir);
    ensureWorkspaceDirs(config.agent.workspace);
    const bus = new MessageBus();
    const cron = new CronService(config.agent.workspace, bus);
    await cron.init();
    const args = argv._.slice(1).map(String);
    console.log(await handleCronCommand(cron, args));
    process.exit(0);
  }

  if (subcommand === "web") {
    const profileArgs = resolveProfileArgs(argv);
    const webResult = await handleWebCommand({
      baseDir,
      ...resolveWebOptions(argv),
      autoStart: {
        enabled: true,
        startArgs: profileArgs,
      },
    });
    if (webResult.startAgent) await runAgent(baseDir, profileHint);
    process.exit(0);
  }

  await runAgent(baseDir, profileHint);
}

main().catch((err) => {
  try {
    activeStatusStore?.pushError("main:fatal", err);
    activeStatusStore?.markAgentStopped();
  } catch {}
  logger.error("neoclaw", "fatal:", err);
  process.exit(1);
});
