/**
 * Termux Daemon Manager
 *
 * Manages TermuxAgent as a persistent background service using:
 *   - runit (termux-services) for auto-restart supervision
 *   - Termux:Boot for auto-start on device boot
 *   - termux-wake-lock to prevent Android from killing the process
 *   - termux-notification for a persistent status notification
 *
 * Requires: pkg install termux-services termux-api
 * Optional: install Termux:Boot from F-Droid for boot auto-start
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const execAsync = promisify(execFile);

const PREFIX = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
const HOME   = homedir();

export const PATHS = {
  service : `${PREFIX}/var/service/termux-agent`,
  sv      : `${PREFIX}/bin/sv`,
  boot    : `${HOME}/.termux/boot`,
  logs    : `${HOME}/.termux-agent/logs`,
  pid     : `${HOME}/.termux-agent/daemon.pid`,
};

// ── environment helpers ───────────────────────────────────────────────────────

export function isTermux() {
  return !!(process.env.TERMUX_VERSION ?? process.env.PREFIX?.includes("termux"));
}

function assertTermux() {
  if (!isTermux()) throw new Error("Not running in Termux — this feature requires the Termux app on Android.");
}

// ── low-level helpers ─────────────────────────────────────────────────────────

async function run(cmd, args = [], opts = {}) {
  try {
    const r = await execAsync(cmd, args, { timeout: 15000, encoding: "utf8", ...opts });
    return (r.stdout ?? "").trim();
  } catch (e) {
    return null;
  }
}

// ── wake lock ─────────────────────────────────────────────────────────────────

export async function acquireWakeLock() {
  await run("termux-wake-lock");
}

export async function releaseWakeLock() {
  await run("termux-wake-unlock");
}

// ── persistent status notification ───────────────────────────────────────────

const NOTIF_ID = "termux-agent-daemon";

export async function setStatusNotification(status, message) {
  const icon = { running: "▶", stopped: "■", error: "✖" }[status] ?? "●";
  await run("termux-notification", [
    "--id",       NOTIF_ID,
    "--title",    `${icon} TermuxAgent`,
    "--content",  message,
    "--priority", "low",
    "--ongoing",
  ]);
}

export async function clearStatusNotification() {
  await run("termux-notification-remove", [NOTIF_ID]);
}

// ── runit service setup ───────────────────────────────────────────────────────

export async function setupService(agentBin) {
  assertTermux();

  // Install termux-services (runit) if sv binary is missing
  if (!existsSync(PATHS.sv)) {
    console.log("Installing termux-services…");
    await execAsync("pkg", ["install", "-y", "termux-services"], { timeout: 120000, encoding: "utf8" });
  }

  mkdirSync(PATHS.service,          { recursive: true });
  mkdirSync(`${PATHS.service}/log`, { recursive: true });
  mkdirSync(PATHS.logs,             { recursive: true });

  const bin = agentBin ?? `${PREFIX}/bin/termux-agent`;

  // runit run script — executed by sv/runsv on every restart
  writeFileSync(`${PATHS.service}/run`, [
    `#!/${PREFIX}/bin/sh`,
    `exec 2>&1`,
    `exec ${bin} daemon-worker`,
  ].join("\n") + "\n");
  chmodSync(`${PATHS.service}/run`, 0o755);

  // runit log script — pipes stdout to svlogd
  writeFileSync(`${PATHS.service}/log/run`, [
    `#!/${PREFIX}/bin/sh`,
    `exec svlogd -tt ${PATHS.logs}`,
  ].join("\n") + "\n");
  chmodSync(`${PATHS.service}/log/run`, 0o755);

  // Remove 'down' file so runit starts the service immediately
  const down = `${PATHS.service}/down`;
  if (existsSync(down)) unlinkSync(down);

  return PATHS.service;
}

// ── Termux:Boot auto-start ────────────────────────────────────────────────────

export async function setupBoot(agentBin) {
  assertTermux();

  mkdirSync(PATHS.boot, { recursive: true });

  const bin = agentBin ?? `${PREFIX}/bin/termux-agent`;
  const bootScript = [
    `#!/${PREFIX}/bin/sh`,
    `# TermuxAgent auto-start — requires Termux:Boot (F-Droid)`,
    ``,
    `# Let the system settle before starting`,
    `sleep 8`,
    ``,
    `# Prevent Android from sleeping during agent tasks`,
    `termux-wake-lock`,
    ``,
    `# Try runit first, fall back to direct start`,
    `if command -v sv >/dev/null 2>&1; then`,
    `  sv start termux-agent`,
    `else`,
    `  ${bin} daemon start &`,
    `fi`,
  ].join("\n") + "\n";

  const bootFile = `${PATHS.boot}/termux-agent.sh`;
  writeFileSync(bootFile, bootScript);
  chmodSync(bootFile, 0o755);

  return bootFile;
}

// ── service control via sv (runit) ────────────────────────────────────────────

export async function startService() {
  if (!existsSync(PATHS.service)) throw new Error("Service not installed — run: termux-agent daemon setup");
  return run(PATHS.sv, ["start", "termux-agent"]);
}

export async function stopService() {
  if (!existsSync(PATHS.service)) return "Service not installed";
  return run(PATHS.sv, ["stop", "termux-agent"]);
}

export async function restartService() {
  if (!existsSync(PATHS.service)) throw new Error("Service not installed — run: termux-agent daemon setup");
  return run(PATHS.sv, ["restart", "termux-agent"]);
}

export async function getServiceStatus() {
  const installed = existsSync(PATHS.service);

  if (!installed) {
    return { status: "not-installed", paths: PATHS };
  }

  if (!existsSync(PATHS.sv)) {
    return { status: "runit-missing", detail: "pkg install termux-services", paths: PATHS };
  }

  const detail = await run(PATHS.sv, ["status", "termux-agent"]);
  const running = detail?.startsWith("run:");

  return {
    status   : running ? "running" : "stopped",
    detail,
    paths    : PATHS,
    bootReady: existsSync(`${PATHS.boot}/termux-agent.sh`),
  };
}

// ── daemon worker (called by runit run script) ────────────────────────────────

export async function runDaemonWorker() {
  await acquireWakeLock();
  await setStatusNotification("running", "Agent is active");

  const cleanup = async (sig) => {
    await clearStatusNotification();
    await releaseWakeLock();
    process.exit(sig === "SIGTERM" ? 0 : 1);
  };

  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT",  () => cleanup("SIGINT"));

  // Log PID for external management
  mkdirSync(`${HOME}/.termux-agent`, { recursive: true });
  writeFileSync(PATHS.pid, String(process.pid));

  // Delegate to the main CLI runtime
  try {
    if (existsSync(join(HOME, ".termux-agent", "dist", "cli", "index.js"))) {
      await import(join(HOME, ".termux-agent", "dist", "cli", "index.js"));
    } else {
      const { execa } = await import("node:child_process");
      // Keep runit happy — re-exec ourselves with the chat mode
      const child = spawn(process.execPath, [process.argv[1], "chat", "--no-interactive"], {
        stdio: "inherit",
        env: { ...process.env, TERMUX_AGENT_DAEMON: "1" },
      });
      child.on("exit", (code) => process.exit(code ?? 0));
    }
  } catch (e) {
    await setStatusNotification("error", `Agent error: ${e.message}`);
    throw e;
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

export async function daemonCli(subcommand, opts = {}) {
  switch (subcommand) {
    case "setup": {
      console.log("Setting up TermuxAgent background service…\n");
      const svcPath  = await setupService(opts.bin);
      const bootPath = await setupBoot(opts.bin);
      console.log(`\nService installed : ${svcPath}`);
      console.log(`Boot script       : ${bootPath}`);
      console.log(`\nNext steps:`);
      console.log(`  sv start termux-agent           — start service now`);
      console.log(`  termux-agent daemon status       — check status`);
      console.log(`  Install Termux:Boot (F-Droid)    — enable boot auto-start`);
      console.log(`\nLogs: ${PATHS.logs}`);
      break;
    }

    case "start":
      assertTermux();
      await startService();
      await setStatusNotification("running", "Agent started via daemon");
      console.log("Agent service started.");
      break;

    case "stop":
      assertTermux();
      await stopService();
      await releaseWakeLock();
      await clearStatusNotification();
      console.log("Agent service stopped.");
      break;

    case "restart":
      assertTermux();
      await restartService();
      console.log("Agent service restarted.");
      break;

    case "status": {
      const s = await getServiceStatus();
      const lines = [
        `Status    : ${s.status}`,
        s.detail      ? `Detail    : ${s.detail}`       : null,
        `Boot ready: ${s.bootReady ? "yes" : "no"}`,
        `Service   : ${s.paths.service}`,
        `Logs      : ${s.paths.logs}`,
      ].filter(Boolean);
      console.log(lines.join("\n"));
      break;
    }

    case "daemon-worker":
      await runDaemonWorker();
      break;

    case "wake-lock":
      await acquireWakeLock();
      console.log("Wake lock acquired.");
      break;

    case "wake-unlock":
      await releaseWakeLock();
      console.log("Wake lock released.");
      break;

    default:
      console.log([
        "Usage: termux-agent daemon <subcommand>",
        "",
        "Subcommands:",
        "  setup         Install runit service + Termux:Boot script",
        "  start         Start the background service",
        "  stop          Stop the background service",
        "  restart       Restart the background service",
        "  status        Show service status",
        "  wake-lock     Acquire Android wake lock",
        "  wake-unlock   Release Android wake lock",
        "",
        "Requirements:",
        "  pkg install termux-services termux-api",
        "  Termux:Boot app (F-Droid) for boot auto-start",
      ].join("\n"));
  }
}
