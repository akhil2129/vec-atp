#!/usr/bin/env node
/**
 * TOWER — VEC entry point.
 * Initialises all infrastructure, creates agents, starts inbox loops,
 * and runs an interactive readline loop for the founder to talk to the PM.
 */

import readline from "readline";
import fs from "fs";
import { join } from "path";

import { config, USER_DATA_DIR, sharedWorkspace, agentWorkspace, getWorkspaceDirs } from "./config.js";
import { initUserDataDir } from "./init.js";
import { runOnboardingIfNeeded } from "./onboarding.js";
import { runMigration } from "./migrate.js";
import { getAllAgentIds } from "./ar/roster.js";
import { AgentRuntime } from "./atp/agentRuntime.js";
import { founder } from "./identity.js";
import { loadAgentMemory, isFirstInteraction, markFirstInteractionDone } from "./memory/agentMemory.js";
import { ATPDatabase } from "./atp/database.js";
import { MessageQueue } from "./atp/messageQueue.js";
import { AgentMessageQueue, AGENT_DISPLAY_NAMES } from "./atp/agentMessageQueue.js";
import { EventLog } from "./atp/eventLog.js";
import { EventType } from "./atp/models.js";
import { startPmLiveLoop } from "./atp/inboxLoop.js";
import type { VECAgent } from "./atp/inboxLoop.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

import { PMAgent } from "./agents/pmAgent.js";
import { startDashboardServer } from "./dashboard/server.js";
import { releaseDueTasks } from "./tools/pm/taskTools.js";
import { AgentInterrupt } from "./atp/agentInterrupt.js";
import { getActiveGroupForAgent, markActiveGroupConversation } from "./atp/agentGroups.js";
import { ActiveChannelState } from "./channels/activeChannel.js";
import { channelManager } from "./channels/channelManager.js";
import { injectChannelEnv } from "./channels/channelConfig.js";
import { injectIntegrationEnv } from "./integrations/integrationConfig.js";
import { UserChatLog } from "./atp/chatLog.js";
import { clearAgentHistory } from "./memory/messageHistory.js";
import { shouldRunSunset } from "./memory/sessionLifecycle.js";
import { publishAgentStream } from "./atp/agentStreamBus.js";
import { initMCP, shutdownMCP } from "./mcp/mcpBridge.js";

import os from "os";
import { execSync } from "child_process";

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureDirs(): void {
  for (const dir of [config.dataDir, config.memoryDir, ...getWorkspaceDirs()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── System requirements check ─────────────────────────────────────────────

const MIN_RAM_GB = 4;
const MIN_CPU_CORES = 2;
const RECOMMENDED_RAM_GB = 8;
const RECOMMENDED_CPU_CORES = 4;

function checkSystemRequirements(): void {
  const totalRamGB = Math.round(os.totalmem() / (1024 ** 3) * 10) / 10;
  const cpuCores = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model?.trim() ?? "Unknown";

  console.log(`  System   : ${cpuCores} cores · ${totalRamGB} GB RAM`);
  console.log(`  CPU      : ${cpuModel}`);

  const warnings: string[] = [];

  if (totalRamGB < MIN_RAM_GB) {
    warnings.push(`  ⚠ RAM: ${totalRamGB} GB detected — minimum ${MIN_RAM_GB} GB required. Performance may be severely impacted.`);
  } else if (totalRamGB < RECOMMENDED_RAM_GB) {
    warnings.push(`  ⚠ RAM: ${totalRamGB} GB detected — ${RECOMMENDED_RAM_GB} GB recommended for running multiple agents.`);
  }

  if (cpuCores < MIN_CPU_CORES) {
    warnings.push(`  ⚠ CPU: ${cpuCores} core(s) detected — minimum ${MIN_CPU_CORES} cores required.`);
  } else if (cpuCores < RECOMMENDED_CPU_CORES) {
    warnings.push(`  ⚠ CPU: ${cpuCores} core(s) detected — ${RECOMMENDED_CPU_CORES}+ cores recommended for parallel agent execution.`);
  }

  if (warnings.length > 0) {
    console.log("");
    for (const w of warnings) console.log(w);
  }
}

// ── Auto-open dashboard in browser ────────────────────────────────────────

function openInBrowser(url: string): void {
  try {
    const plat = process.platform;
    if (plat === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore", shell: "cmd.exe" });
    } else if (plat === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    }
  } catch {
    // Silent fail — user can open manually
  }
}

function printBanner(): void {
  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║       VEC — Virtual Employed Company             ║");
  console.log("║       TOWER  |  Agent Task Portal                ║");
  console.log("╚══════════════════════════════════════════════════╝");
  checkSystemRequirements();
  console.log(`  Model    : ${config.modelProvider}/${config.model}`);
  console.log(`  Thinking : ${config.thinkingLevel}`);
  console.log(
    `  LLM Debug: ${config.debugLlm ? `ON (stall>${config.debugLlmStallSecs}s)` : "OFF (set VEC_DEBUG_LLM=1)"
    }`
  );
  console.log(`  Data Dir : ${USER_DATA_DIR}`);
  console.log(`  Workspace: ${config.workspace}`);
  console.log(`    Shared : workspace/shared/         (cross-agent deliverables)`);
  console.log(`    Agents : workspace/agents/{EMP-ID}/ (per-agent private folders)`);
  console.log(`  Proactive: ${config.pmProactiveEnabled ? `ON (every ${config.pmProactiveIntervalSecs}s)` : "OFF"}`);
  // Dashboard URL with key is printed by server.ts on listen
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  console.log(`  Telegram : ${tgChatId ? `active (chat ${tgChatId})` : "disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable)"}`);
  const slackCh = process.env.SLACK_CHANNEL_ID;
  console.log(`  Slack    : ${slackCh ? `active (channel ${slackCh})` : "disabled (set SLACK_BOT_TOKEN + SLACK_APP_TOKEN + SLACK_CHANNEL_ID to enable)"}`);
  const discordCh = process.env.DISCORD_CHANNEL_ID;
  console.log(`  Discord  : ${discordCh ? `active (channel ${discordCh})` : "disabled (set DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID to enable)"}`);
  console.log(`  CLI      : ${config.cliEnabled ? "ON" : "OFF (headless — set VEC_CLI_ENABLED=1 to enable)"}`);
  if (config.cliEnabled) {
    console.log("  /board   — Task board (SQLite)");
    console.log("  /queue   — PM message queue");
    console.log("  /events  — Recent event log (last 20)");
    console.log("  /dir     — Employee directory");
    console.log("  /message   — Message any agent directly");
    console.log("  /interrupt — Stop a running agent mid-task");
    console.log("  /forget    — Clear PM conversation history");
    console.log("  /live      — Toggle live queue monitor");
    console.log("  /reset     — Company reset (tasks, memories, histories, queues)");
  }
  if (config.cliEnabled) console.log("  /quit      — Exit");
  console.log("");
}

// ── Suppress chat log during system prompts (sunset, proactive, etc.) ─────
//    Set to true before any internally-initiated PM prompt so the response
//    is NOT logged to UserChatLog as a user-facing chat message.
let suppressChatLog = false;

// ── PM event handler for streaming output ─────────────────────────────────

function attachPmStreaming(pmAgent: PMAgent): void {
  let headerPrinted = false;
  let onNewLine = true;
  let capturedText = "";
  let messageAgentCalled = false;

  pmAgent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        headerPrinted = false;
        onNewLine = true;
        capturedText = "";
        messageAgentCalled = false;
        publishAgentStream("pm", event);
        break;

      case "message_update": {
        const ae = event.assistantMessageEvent;
        // Always forward to stream bus (handles text, thinking, etc.)
        publishAgentStream("pm", event);
        if (ae.type === "text_delta" && ae.delta) {
          capturedText += ae.delta;
          if (CLI_MODE) {
            if (!headerPrinted) {
              process.stdout.write("\nArjun (PM): ");
              headerPrinted = true;
              onNewLine = false;
            }
            process.stdout.write(ae.delta);
            onNewLine = ae.delta.endsWith("\n");
          }
        }
        break;
      }

      case "tool_execution_start":
        if (CLI_MODE) {
          if (!onNewLine) process.stdout.write("\n");
          process.stdout.write(`  [${event.toolName}] `);
          onNewLine = false;
        }
        if (event.toolName === "message_agent") messageAgentCalled = true;
        publishAgentStream("pm", event);
        break;

      case "tool_execution_end":
        if (CLI_MODE) {
          process.stdout.write(event.isError ? "ERROR\n" : "done\n");
          onNewLine = true;
        }
        publishAgentStream("pm", event);
        break;

      case "agent_end": {
        if (CLI_MODE) {
          if (!onNewLine) process.stdout.write("\n");
          onNewLine = true;
        }
        publishAgentStream("pm", event);
        // Fallback: if PM generated text but never called message_agent,
        // the model output plain text instead of a tool call (Kimi K2 quirk).
        // Capture it directly so it appears in chat.
        // Skip: Telegram-originated prompts (Telegram handles its own reply).
        // Skip: system-initiated prompts (sunset, proactive) — suppressChatLog flag.
        const text = capturedText.trim();
        if (
          text &&
          !messageAgentCalled &&
          !suppressChatLog &&
          !text.startsWith("NO_ACTION_REQUIRED") &&
          ActiveChannelState.get() !== "telegram" &&
          ActiveChannelState.get() !== "slack"
        ) {
          UserChatLog.log({ from: "pm", to: "user", message: text, channel: "agent" });
        }
        capturedText = "";
        messageAgentCalled = false;
        break;
      }

      default:
        break;
    }
  });
}

// ── Live PM queue monitor ──────────────────────────────────────────────────

function startLiveMonitor(): { toggle: () => boolean; interval: NodeJS.Timeout } {
  let enabled = true;
  const seen = new Set<string>();

  const interval = setInterval(() => {
    if (!enabled) return;
    const messages = MessageQueue.peek();
    for (const msg of messages) {
      const key = `${msg.timestamp}|${msg.from_agent}|${msg.task_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const tag =
        msg.type === "error"
          ? "[ERR]"
          : msg.type === "status_update"
            ? "[UPDATE]"
            : "[INFO]";
      const taskRef = msg.task_id ? ` ${msg.task_id}` : "";
      console.log(
        `\n  ${tag} ${msg.from_agent.toUpperCase()}${taskRef}: ${msg.message.substring(0, 120)}`
      );
    }
  }, 2_000);

  return {
    toggle: () => {
      enabled = !enabled;
      return enabled;
    },
    interval,
  };
}

// ── Commander.js CLI ──────────────────────────────────────────────────────
import { Command } from "commander";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

const program = new Command();
program
  .name("octo-vec")
  .description("OCTO VEC — AI Agent Orchestration Platform")
  .version(pkg.version, "-v, --version");

// ── octo-vec start (default) ─────────────────────────────────────────────
let CLI_MODE = false;

program
  .command("start", { isDefault: true })
  .description("Start OCTO VEC (daemon mode by default)")
  .option("-c, --cli", "Enable full interactive CLI mode with readline")
  .option("--reset", "Wipe all tasks, memories, and queues on startup")
  .action(async (opts: { cli?: boolean; reset?: boolean }) => {
    CLI_MODE = !!opts.cli;
    await startServer(!!opts.reset).catch((err) => {
      console.error("[Fatal startup error]", err);
      process.exit(1);
    });
  });

// ── octo-vec dashboard ───────────────────────────────────────────────────
program
  .command("dashboard")
  .description("Open the dashboard in your browser")
  .action(() => {
    const urlFile = join(USER_DATA_DIR, ".dashboard-url");
    if (fs.existsSync(urlFile)) {
      const url = fs.readFileSync(urlFile, "utf-8").trim();
      console.log(`  Opening: ${url}`);
      openInBrowser(url);
    } else {
      console.log("  Dashboard URL not found. Start OCTO VEC first: octo-vec start");
    }
    process.exit(0);
  });

// ── octo-vec migrate ─────────────────────────────────────────────────────
program
  .command("migrate")
  .description("Migrate data from old ./data/ directory to ~/.octo-vec/")
  .action(async () => {
    await runMigration();
    process.exit(0);
  });

program.parse();

// ── Server startup ───────────────────────────────────────────────────────

async function startServer(doStartupReset: boolean): Promise<void> {
  // 0b. First-run onboarding — only in --cli mode (dashboard handles it otherwise)
  if (CLI_MODE) {
    await runOnboardingIfNeeded();
  }

  // 0c. Bootstrap user data directory (creates dirs + seeds roster.json)
  initUserDataDir();

  // 0d. Inject saved integration settings (SearXNG, SonarQube, etc.) into process.env
  injectIntegrationEnv();

  // 1. Ensure all data/memory/workspace directories exist
  ensureDirs();
  if (doStartupReset) {
    if (CLI_MODE) console.log("\n  [STARTUP RESET] Wiping all tasks, memories, and queues...");
    ATPDatabase.clearAllTasks();
    ATPDatabase.resetEmployeeStatuses();
    MessageQueue.clear();
    UserChatLog.clear();
    for (const id of getAllAgentIds()) clearAgentHistory(id);
    try {
      fs.rmSync(config.memoryDir, { recursive: true, force: true });
      fs.mkdirSync(config.memoryDir, { recursive: true });
    } catch { /* non-fatal */ }
    if (CLI_MODE) console.log("  Done — VEC will start fresh.\n");
  }

  // 1c. Initialize MCP bridge — connect to configured MCP servers and discover tools.
  await initMCP();

  // 2. Clear transient state from previous run.
  //    clearTransient() preserves recent user→agent messages (<2h) so they
  //    survive a server restart and PM still processes them. Agent→agent
  //    coordination messages are dropped (stale task context).
  AgentMessageQueue.clearTransient();
  // clearFlowLog() is NOT called on normal startup — flow history persists
  // across restarts so Network view shows historical message flows.
  // It is only cleared on full /reset.
  EventLog.clear();

  // 3. Create specialist agents dynamically from roster.json
  const deps = {
    db: ATPDatabase,
    pmQueue: MessageQueue,
    agentQueue: AgentMessageQueue,
  };

  // 4. Create PM agent first (needs specialist registry for message routing)
  //    Then build AgentRuntime which creates all specialists from roster.
  //    AgentRuntime.allAgents is the shared Map used by dashboard + PM.
  const pmAgentDeps = { ...deps, agents: new Map<string, VECAgent>() };
  const pmAgent = new PMAgent(pmAgentDeps);
  const runtime = new AgentRuntime(deps, pmAgent);
  // Patch PM's agent registry reference so it can route messages to specialists
  pmAgentDeps.agents = runtime.getSpecialistRegistry();

  // 6. Attach streaming output to PM agent
  attachPmStreaming(pmAgent);

  // 6b. Sunset / Sunrise — if PM has a stale session from a previous day,
  //     run one final "journal your memories" prompt before clearing it.
  //     This must happen before inbox loops start so there's no concurrent activity.
  const sunsetCheck = shouldRunSunset("pm");
  if (sunsetCheck.should && sunsetCheck.sessionDate) {
    suppressChatLog = true;
    try { await pmAgent.runSunset(sunsetCheck.sessionDate); } finally { suppressChatLog = false; }
  }

  // 7. Start background inbox loops via AgentRuntime.
  const specialistHandles = runtime.startAllLoops();
  const pmHandles = startPmLiveLoop(pmAgent, config.pmProactiveIntervalSecs * 1_000);
  const allHandles: NodeJS.Timeout[] = [...specialistHandles, ...pmHandles];

  // 7b. Watchdog — detects tasks stuck in_progress and marks them failed.
  //     Runs every 2 minutes. Any task with no status update in >5 minutes is considered hung.
  //     The watchdog does NOT restart tasks itself — it marks them failed and lets the PM
  //     proactive loop decide what to do (PM already has: retry once → then tell Boss).
  //     This prevents infinite crash loops where a broken task gets restarted forever.
  const STALE_TASK_MS = 5 * 60_000;
  const watchdogHandle = setInterval(() => {
    const staleTasks = ATPDatabase.getAllTasks("in_progress").filter((t) => {
      const age = Date.now() - new Date(t.updated_at).getTime();
      return age > STALE_TASK_MS;
    });
    for (const task of staleTasks) {
      const agent = runtime.allAgents.get(task.agent_id);
      if (agent) agent.abort(); // stop any hung LLM call
      ATPDatabase.updateTaskStatus(
        task.task_id, "failed",
        `Watchdog: task timed out after ${STALE_TASK_MS / 60_000}min with no progress. PM will decide next action.`
      );
      EventLog.log(
        EventType.TASK_FAILED, "system", task.task_id,
        `WATCHDOG: ${task.task_id} timed out — marked failed. PM proactive loop will handle retry/escalation.`
      );
    }
  }, 2 * 60_000);
  allHandles.push(watchdogHandle);

  // 7c. Scheduled task auto-release scheduler.
  //     Runs once at startup and every hour thereafter.
  //     Dispatches any pending task whose scheduled_date <= today so tasks
  //     created with a future date automatically start when their date arrives.
  const schedulerDeps = {
    db: ATPDatabase,
    pmQueue: MessageQueue,
    agentQueue: AgentMessageQueue,
    agents: runtime.getSpecialistRegistry(),
  };
  releaseDueTasks(schedulerDeps); // run immediately on startup
  const schedulerHandle = setInterval(() => releaseDueTasks(schedulerDeps), 60 * 60_000);
  allHandles.push(schedulerHandle);

  // 8. Start live queue monitor (CLI mode only)
  let monitor: ReturnType<typeof startLiveMonitor> | null = null;
  if (CLI_MODE) {
    monitor = startLiveMonitor();
    allHandles.push(monitor.interval);
  }

  function shutdown(): void {
    if (CLI_MODE) console.log("\nShutting down VEC... goodbye.");
    runtime.shutdown();
    for (const h of allHandles) clearInterval(h);
    shutdownMCP().catch(() => { });
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 9. Start dashboard HTTP server
  startDashboardServer(runtime, config.dashboardPort, openInBrowser);

  // 10. Inject saved channel credentials and start channels
  injectChannelEnv();
  await channelManager.initChannels(pmAgent);

  // 11. User inbox forwarder — delivers messages sent to 'user' by PM (or other agents)
  //     to the CLI console and, if active, to the Telegram channel.
  const userInboxHandle = setInterval(async () => {
    const msgs = AgentMessageQueue.popForAgent("user");
    for (const msg of msgs) {
      // Silently discard NO_ACTION_REQUIRED responses — they are intentional no-ops.
      if (msg.message.trim().startsWith("NO_ACTION_REQUIRED")) continue;
      const sender = AGENT_DISPLAY_NAMES[msg.from_agent] ?? msg.from_agent;
      const tag = msg.priority === "priority" ? " [PRIORITY]" : "";
      const line = `[${sender}${tag}]: ${msg.message}`;
      const ch = ActiveChannelState.get();
      if (CLI_MODE) console.log(`\n  [→ You] ${line}\n`);
      // ── Group reply interception ─────────────────────────────────────
      // If the replying agent is in an active group conversation,
      // forward their reply to all other group members and log with group_id.
      const activeGroup = getActiveGroupForAgent(msg.from_agent);
      if (activeGroup) {
        // Log with group_id
        UserChatLog.log({
          from: msg.from_agent, to: "user",
          message: msg.message, channel: "agent",
          group_id: activeGroup.id,
        });
        // Forward to other group members
        const otherMembers = activeGroup.members.filter((m) => m !== msg.from_agent);
        const senderName = AGENT_DISPLAY_NAMES[msg.from_agent] ?? msg.from_agent;
        for (const member of otherMembers) {
          AgentMessageQueue.push(
            msg.from_agent, member, "",
            `[GROUP: ${activeGroup.name}] ${senderName} says: ${msg.message}`,
            "normal",
          );
        }
        // Refresh active timestamp
        markActiveGroupConversation(activeGroup.id, activeGroup.members);
      } else {
        // Normal individual reply — route to origin channel
        if (ch !== "telegram" && ch !== "slack" && ch !== "discord") {
          UserChatLog.log({ from: msg.from_agent, to: "user", message: msg.message, channel: "agent" });
        }
      }

      // Route reply to origin channel (for both individual and group)
      const tg = channelManager.getChannel("telegram");
      if (tg && ch === "telegram") {
        await tg.sendToUser(line).catch(() => { });
      }
      const sl = channelManager.getChannel("slack");
      if (sl && ch === "slack") {
        await sl.sendToUser(line).catch(() => { });
      }
      const dc = channelManager.getChannel("discord");
      if (dc && ch === "discord") {
        await dc.sendToUser(line).catch(() => { });
      }
    }
  }, 5_000);
  allHandles.push(userInboxHandle);

  // 12. Print banner (CLI mode) or minimal daemon message
  if (CLI_MODE) {
    printBanner();
  } else {
    console.log("  OCTO VEC started. Dashboard will open in your browser.");
    console.log("  Press Ctrl+C to stop.\n");
  }

  // 13. Interactive readline loop (CLI mode only)
  if (!CLI_MODE) {
    // Daemon mode — keep process alive, no stdin input
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // When stdin closes (piped input, Ctrl+D), stop the askLine loop cleanly
  let rlClosed = false;
  rl.on("close", () => { rlClosed = true; });

  const askLine = (): void => {
    if (rlClosed) return;
    rl.question("You: ", async (raw) => {
      const input = raw.trim();

      if (!input) {
        askLine();
        return;
      }

      // ── Slash commands ────────────────────────────────────────────────

      if (input === "/quit" || input === "/exit") {
        rl.close();
        shutdown();
        return;
      }

      if (input === "/board") {
        console.log("\n" + ATPDatabase.taskBoard());
        askLine();
        return;
      }

      if (input === "/queue") {
        const msgs = MessageQueue.peek();
        if (!msgs.length) {
          console.log("\n[PM Queue] Empty.");
        } else {
          console.log(`\n[PM Queue] ${msgs.length} message(s):`);
          for (const m of msgs) {
            const taskRef = m.task_id ? ` ${m.task_id}` : "";
            console.log(`  [${m.type}] ${m.from_agent}${taskRef}: ${m.message.substring(0, 80)}`);
          }
        }
        askLine();
        return;
      }

      if (input === "/events") {
        const events = EventLog.getEvents(20);
        if (!events.length) {
          console.log("\n[Events] None recorded yet.");
        } else {
          console.log(`\n[Events] Last ${events.length}:`);
          for (const e of events) {
            const ts = e.timestamp
              ? new Date(e.timestamp).toLocaleTimeString()
              : "?";
            const taskRef = e.task_id ? ` | ${e.task_id}` : "";
            console.log(
              `  ${ts} [${e.event_type}] ${e.agent_id || "-"}${taskRef} — ${(e.message || "").substring(0, 80)}`
            );
          }
        }
        askLine();
        return;
      }

      if (input === "/dir") {
        console.log("\n" + ATPDatabase.employeeDirectory());
        askLine();
        return;
      }

      if (input === "/org") {
        console.log("\n" + ATPDatabase.orgChart());
        askLine();
        return;
      }

      if (input.startsWith("/message")) {
        // Agents available to message (all except "user" = Akhil himself)
        const AGENTS = Object.entries(AGENT_DISPLAY_NAMES).filter(([id]) => id !== "user");

        // Parse inline args: /message [agentKey] [message...]
        const parts = input.slice("/message".length).trim().split(/\s+/);
        let targetKey = "";
        let inlineMsg = "";

        if (parts[0] && AGENTS.some(([id]) => id === parts[0].toLowerCase())) {
          targetKey = parts[0].toLowerCase();
          inlineMsg = parts.slice(1).join(" ").trim();
        }

        // Step 1: pick agent if not given inline
        const pickAgent = (): Promise<string> => {
          if (targetKey) return Promise.resolve(targetKey);
          console.log("\n  Who do you want to message?");
          AGENTS.forEach(([, name], i) =>
            console.log(`    ${String(i + 1).padStart(2)}. ${name}`)
          );
          console.log("");
          return new Promise((resolve) => {
            rl.question("  Pick number (or agent key): ", (ans) => {
              const trimmed = ans.trim().toLowerCase();
              const byNum = AGENTS[parseInt(trimmed, 10) - 1];
              if (byNum) { resolve(byNum[0]); return; }
              if (AGENTS.some(([id]) => id === trimmed)) { resolve(trimmed); return; }
              console.log("  [Invalid selection — cancelled.]");
              resolve("");
            });
          });
        };

        // Step 2: ask for message text if not given inline
        const pickMessage = (agentKey: string): Promise<string> => {
          if (!agentKey) return Promise.resolve("");
          if (inlineMsg) return Promise.resolve(inlineMsg);
          const name = AGENT_DISPLAY_NAMES[agentKey] ?? agentKey;
          return new Promise((resolve) => {
            rl.question(`  Message to ${name}: `, (ans) => resolve(ans.trim()));
          });
        };

        const agentKey = await pickAgent();
        const msgText = await pickMessage(agentKey);

        if (agentKey && msgText) {
          AgentMessageQueue.push("user", agentKey, "", msgText, "normal");
          const name = AGENT_DISPLAY_NAMES[agentKey] ?? agentKey;
          console.log(`  [Sent to ${name}]`);
        }

        askLine();
        return;
      }

      if (input.startsWith("/interrupt")) {
        // Available specialist agents (exclude pm and user)
        const SPEC_AGENTS = Object.entries(AGENT_DISPLAY_NAMES).filter(
          ([id]) => id !== "user" && id !== "pm"
        );

        // Parse inline args: /interrupt [agentKey] [reason...]
        const iParts = input.slice("/interrupt".length).trim().split(/\s+/);
        let iTargetKey = "";
        let iReason = "";

        if (iParts[0] && SPEC_AGENTS.some(([id]) => id === iParts[0].toLowerCase())) {
          iTargetKey = iParts[0].toLowerCase();
          iReason = iParts.slice(1).join(" ").trim();
        }

        // Pending interrupts summary
        const pending = AgentInterrupt.getAll();
        const pendingCount = Object.keys(pending).length;
        if (pendingCount) {
          console.log(`\n  [Pending interrupts: ${Object.entries(pending).map(([id, r]) => `${id}=${r}`).join(", ")}]`);
        }

        const pickAgent = (): Promise<string> => {
          if (iTargetKey) return Promise.resolve(iTargetKey);
          console.log("\n  Which agent do you want to interrupt?");
          SPEC_AGENTS.forEach(([, name], i) =>
            console.log(`    ${String(i + 1).padStart(2)}. ${name}`)
          );
          console.log("");
          return new Promise((resolve) => {
            rl.question("  Pick number (or agent key): ", (ans) => {
              const trimmed = ans.trim().toLowerCase();
              const byNum = SPEC_AGENTS[parseInt(trimmed, 10) - 1];
              if (byNum) { resolve(byNum[0]); return; }
              if (SPEC_AGENTS.some(([id]) => id === trimmed)) { resolve(trimmed); return; }
              console.log("  [Invalid selection — cancelled.]");
              resolve("");
            });
          });
        };

        const pickReason = (agentKey: string): Promise<string> => {
          if (!agentKey) return Promise.resolve("");
          if (iReason) return Promise.resolve(iReason);
          return new Promise((resolve) => {
            rl.question("  Reason (or Enter to skip): ", (ans) => resolve(ans.trim() || "Interrupted by founder"));
          });
        };

        const iKey = await pickAgent();
        const reason = await pickReason(iKey);

        if (iKey) {
          const r = reason || "Interrupted by founder";
          // Native abort — stops LLM generation mid-stream
          runtime.allAgents.get(iKey)?.abort();
          // Flag fallback — caught at next tool boundary
          AgentInterrupt.request(iKey, r);
          const name = AGENT_DISPLAY_NAMES[iKey] ?? iKey;
          console.log(`  [${name} aborted (mid-stream) + flagged (next tool boundary)]`);
        }

        askLine();
        return;
      }

      if (input === "/forget") {
        pmAgent.clearMessages();
        clearAgentHistory("pm");
        console.log("[PM conversation history cleared.]");
        askLine();
        return;
      }

      if (input === "/reset") {
        const confirmed = await new Promise<boolean>((resolve) => {
          console.log("\n  [COMPANY RESET] This will permanently clear:");
          console.log("    • All ATP tasks (task counter resets to TASK-001)");
          console.log("    • All agent message queues, event log, chat log");
          console.log("    • All agent conversation histories");
          console.log("    • All agent memories (STM, LTM, SLTM)");
          console.log("    • Employee statuses reset to available");
          console.log("  Employee records are preserved. Workspace files are NOT deleted.\n");
          rl.question("  Type RESET to confirm (or Enter to cancel): ", (ans) => {
            resolve(ans.trim() === "RESET");
          });
        });

        if (!confirmed) {
          console.log("  [Cancelled.]\n");
          askLine();
          return;
        }

        // 1. Abort all running agents
        for (const [, agent] of runtime.allAgents) agent.abort();

        // 2. Clear ATP tasks + reset employee statuses
        const cleared = ATPDatabase.clearAllTasks();
        ATPDatabase.resetEmployeeStatuses();

        // 3. Clear all message queues
        MessageQueue.clear();
        AgentMessageQueue.clear();
        AgentMessageQueue.clearFlowLog();

        // 4. Clear event log + chat log
        EventLog.clear();
        UserChatLog.clear();

        // 5. Clear agent histories (disk + in-memory)
        for (const id of getAllAgentIds()) clearAgentHistory(id);
        for (const [, agent] of runtime.allAgents) agent.clearHistory();

        // 6. Wipe all agent memory files (STM, LTM, SLTM)
        try {
          fs.rmSync(config.memoryDir, { recursive: true, force: true });
          fs.mkdirSync(config.memoryDir, { recursive: true });
        } catch { /* non-fatal */ }

        console.log(`\n  [Company Reset Complete]`);
        console.log(`  • ${cleared} task(s) deleted — next task will be TASK-001`);
        console.log(`  • All agent memories wiped`);
        console.log(`  • All conversation histories cleared`);
        console.log(`  • All message queues flushed`);
        console.log(`  • All employees marked available`);
        console.log(`  VEC is starting fresh.\n`);
        askLine();
        return;
      }

      if (input === "/live") {
        const now = monitor!.toggle();
        console.log(`[Live queue monitor: ${now ? "ON" : "OFF"}]`);
        askLine();
        return;
      }

      // ── Send to PM agent ──────────────────────────────────────────────

      // Mark this as a CLI-originated message so replies go to Dashboard only
      ActiveChannelState.set("cli");

      // Log Sir's message to Teams chat history
      UserChatLog.log({ from: "user", to: "pm", message: input, channel: "cli" });

      try {
        const memory = loadAgentMemory("pm");
        const firstTime = isFirstInteraction("pm");
        if (firstTime) markFirstInteractionDone("pm");
        const founderPrompt =
          (memory ? `${memory}\n\n` : "") +
          (firstTime
            ? `[FIRST INTERACTION — Sir is messaging you for the first time.]\n` +
            `Introduce yourself briefly and warmly — one sentence. Then respond to what he said. Natural, not robotic.\n\n`
            : "") +
          `[Message from ${founder.name} (Sir) — agent key: '${founder.agentKey}']\n` +
          `Sir says: ${input}`;
        await pmAgent.prompt(founderPrompt);
      } catch (err) {
        console.error("\n[Error talking to PM]", err);
      }

      askLine();
    });
  };

  askLine();
}
