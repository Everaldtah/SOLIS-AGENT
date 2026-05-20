#!/usr/bin/env node
/**
 * TermuxAgent CLI - Main Entry Point
 * Token-optimized command-line interface for Android/Termux
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRuntime } from "../runtime.js";
import { ConfigManager } from "../config/manager.js";
import { ChatSession } from "../chat/session.js";
import { GatewayClient } from "../gateway/client.js";
import { MemoryStore } from "../memory/store.js";
import { ObsidianMemory } from "../memory/obsidian-memory.js";
import { ToolRegistry } from "../tools/registry.js";
import { Logger } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));

// ASCII Art Banner (compact for mobile)
const BANNER = `
╔═══════════════════════════════════════╗
║     🤖 TermuxAgent v${pkg.version.padEnd(8)}      ║
║  Token-Optimized AI for Android  ║
╚═══════════════════════════════════════╝
`;

class TermuxAgentCLI {
  private program: Command;
  private runtime!: AgentRuntime;
  private config!: ConfigManager;
  private logger: Logger;

  constructor() {
    this.program = new Command();
    this.logger = new Logger("CLI");
    this.setupCommands();
  }

  private setupCommands(): void {
    this.program
      .name("termux-agent")
      .description("Token-optimized AI agent for Android/Termux")
      .version(pkg.version, "-v, --version", "Show version")
      .helpOption("-h, --help", "Show help")
      .configureOutput({
        outputError: (str, write) => write(`❌ ${str}`)
      });

    // Main chat command
    this.program
      .command("chat")
      .description("Start interactive chat session")
      .option("-m, --model <model>", "LLM model to use", "claude-sonnet-4-6")
      .option("-p, --provider <provider>", "API provider", "anthropic")
      .option("--no-memory", "Disable conversation memory")
      .option("-s, --system <prompt>", "System prompt")
      .option("-t, --tools <tools>", "Enable tools (comma-separated)")
      .option("--thinking-budget <tokens>", "Extended thinking token budget (Anthropic Claude only)", "0")
      .argument("[message]", "Initial message")
      .action(this.handleChat.bind(this));

    // Quick ask command
    this.program
      .command("ask")
      .description("Single-shot question (no interactive mode)")
      .option("-m, --model <model>", "LLM model", "claude-sonnet-4-6")
      .option("-p, --provider <provider>", "API provider", "anthropic")
      .option("--no-stream", "Disable streaming")
      .argument("<question>", "Question to ask")
      .action(this.handleAsk.bind(this));

    // Config command
    this.program
      .command("config")
      .description("Manage configuration")
      .option("--get <key>", "Get config value")
      .option("--set <key=value>", "Set config value")
      .option("--list", "List all config")
      .option("--init", "Initialize config file")
      .action(this.handleConfig.bind(this));

    // Setup/onboard command
    this.program
      .command("setup")
      .description("Interactive setup wizard")
      .action(this.handleSetup.bind(this));

    // Tool management
    this.program
      .command("tools")
      .description("Manage available tools")
      .option("-l, --list", "List all tools")
      .option("-e, --enable <tool>", "Enable a tool")
      .option("-d, --disable <tool>", "Disable a tool")
      .action(this.handleTools.bind(this));

    // Status command
    this.program
      .command("status")
      .description("Show agent status")
      .action(this.handleStatus.bind(this));

    // Daemon command — background service management
    this.program
      .command("daemon [subcommand]")
      .description("Manage the background agent daemon (setup/start/stop/restart/status)")
      .option("--bin <path>", "Path to termux-agent binary (used during setup)")
      .allowUnknownOption(false)
      .action(this.handleDaemon.bind(this));

    // Default: show banner and help
    this.program.action(() => {
      console.log(BANNER);
      this.program.help();
    });
  }

  private async handleChat(message: string | undefined, options: any): Promise<void> {
    console.log(BANNER);
    this.logger.info("Starting chat session...");

    try {
      this.config = new ConfigManager();
      await this.config.load();

      const memory = options.memory ? new MemoryStore(this.config.get("memory.path")) : null;
      const gateway = new GatewayClient(this.config.getProviderConfig(options.provider));

      // Auto-init Obsidian RAG memory from config
      const obsidianCfg = this.config.get<{ enabled?: boolean; vaultPath?: string }>("obsidian");
      const vaultPath: string | undefined = obsidianCfg?.vaultPath;
      const obsidianMemory = (obsidianCfg?.enabled !== false && vaultPath)
        ? new ObsidianMemory(vaultPath)
        : null;

      if (obsidianMemory) {
        this.logger.info(`Obsidian RAG vault: ${vaultPath}`);
      }

      const tools = new ToolRegistry(
        options.tools ? options.tools.split(",") : undefined,
        undefined,
        { vaultPath: vaultPath ?? undefined },
      );

      this.runtime = new AgentRuntime({
        config: this.config,
        gateway,
        memory,
        tools,
        obsidianMemory,
        model: options.model,
        systemPrompt: options.system,
        thinkingBudget: parseInt(options.thinkingBudget ?? "0", 10),
      });

      // Pre-load vault context (user profile + last session) before first message
      await this.runtime.initVaultContext();

      const session = new ChatSession(this.runtime);
      await session.start(message);
    } catch (err: unknown) {
      this.logger.error(`Chat failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  private async handleAsk(question: string, options: any): Promise<void> {
    this.logger.info("Processing request...");

    try {
      this.config = new ConfigManager();
      await this.config.load();

      const gateway = new GatewayClient(this.config.getProviderConfig(options.provider));
      
      const response = await gateway.complete({
        model: options.model,
        messages: [{ role: "user", content: question }],
        stream: options.stream
      });

      console.log(response.content);
    } catch (err: unknown) {
      this.logger.error(`Request failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  private async handleConfig(options: any): Promise<void> {
    this.config = new ConfigManager();
    
    if (options.init) {
      await this.config.init();
      console.log("✅ Config initialized at ~/.termux-agent/config.json");
      return;
    }

    await this.config.load();

    if (options.list) {
      console.log(JSON.stringify(this.config.getAll(), null, 2));
    } else if (options.get) {
      console.log(this.config.get(options.get));
    } else if (options.set) {
      const [key, value] = options.set.split("=");
      await this.config.set(key, value);
      console.log(`✅ Set ${key} = ${value}`);
    } else {
      console.log("Use --list, --get <key>, --set <key=value>, or --init");
    }
  }

  private async handleSetup(): Promise<void> {
    console.log(BANNER);
    console.log("🚀 Welcome to TermuxAgent Setup\n");

    const setup = await import("../utils/setup.js");
    await setup.runInteractiveSetup();
  }

  private async handleTools(options: any): Promise<void> {
    this.config = new ConfigManager();
    await this.config.load();

    const registry = new ToolRegistry();

    if (options.list) {
      const tools = registry.list();
      console.log("Available tools:");
      tools.forEach(t => console.log(`  ${t.enabled ? "✅" : "❌"} ${t.name} - ${t.description}`));
    } else if (options.enable) {
      await registry.enable(options.enable);
      console.log(`✅ Enabled tool: ${options.enable}`);
    } else if (options.disable) {
      await registry.disable(options.disable);
      console.log(`❌ Disabled tool: ${options.disable}`);
    }
  }

  private async handleStatus(): Promise<void> {
    console.log(BANNER);
    
    const status = {
      version: pkg.version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      config: "~/.termux-agent/config.json"
    };

    console.log("Status:");
    Object.entries(status).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  }

  private async handleDaemon(subcommand: string | undefined, options: any): Promise<void> {
    const sub = subcommand ?? "status";
    try {
      // Dynamic import keeps the daemon module out of the main bundle
      const { daemonCli } = await import("../services/termux-daemon.mjs" as any);
      await daemonCli(sub, { bin: options.bin });
    } catch (err: unknown) {
      this.logger.error(`Daemon command failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  public async run(argv: string[]): Promise<void> {
    await this.program.parseAsync(argv);
  }
}

// Run CLI
const cli = new TermuxAgentCLI();
cli.run(process.argv).catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
