/**
 * AR Department — BaseSpecialistAgent.
 * Replaces 8 near-identical specialist agent files with one data-driven class.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { AgentInbox, AgentMessageQueue } from "../atp/agentMessageQueue.js";
import { codexApiKeyResolver } from "../atp/codexAuth.js";
import { ATPDatabase } from "../atp/database.js";
import { MessageQueue } from "../atp/messageQueue.js";
import { EventLog } from "../atp/eventLog.js";
import { EventType } from "../atp/models.js";
import type { VECAgent } from "../atp/inboxLoop.js";
import { config } from "../config.js";
import { getEffectiveModel } from "../atp/modelConfig.js";
import { founder } from "../identity.js";
import { loadAgentMemory } from "../memory/agentMemory.js";
import { makeCompactionTransform } from "../memory/compaction.js";
import { AutoCompactor } from "../memory/autoCompaction.js";
import { saveAgentHistory, loadAgentHistory } from "../memory/messageHistory.js";
import { publishAgentStream } from "../atp/agentStreamBus.js";
import { startPromptDebugMonitor } from "../atp/llmDebug.js";
import { applyToolConfig } from "../atp/agentToolConfig.js";
import type { RosterEntry } from "./roster.js";
import { buildToolset } from "./toolProfiles.js";
import { loadPrompt } from "./promptLoader.js";
import {
  autoInitRepo,
  autoCommitIfDirty,
  getProjectDirFromFolderAccess,
} from "../tools/domain/gitTools.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpecialistDeps {
  db: typeof ATPDatabase;
  pmQueue: typeof MessageQueue;
  agentQueue: typeof AgentMessageQueue;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CONTINUATIONS = 3;

// ── BaseSpecialistAgent ───────────────────────────────────────────────────────

export class BaseSpecialistAgent implements VECAgent {
  readonly inbox: AgentInbox;
  readonly entry: RosterEntry;
  readonly agentId: string;

  private agent: Agent;
  private compactor: AutoCompactor;
  private _isRunning = false;
  private allTools: any[];
  private deps: SpecialistDeps;

  get isRunning(): boolean {
    return this._isRunning;
  }

  constructor(entry: RosterEntry, deps: SpecialistDeps) {
    this.entry = entry;
    this.agentId = entry.agent_id;
    this.deps = deps;

    this.inbox = new AgentInbox(this.agentId, AgentMessageQueue);

    // Build toolset from profile
    this.allTools = buildToolset(entry, this.inbox, deps);

    // Build system prompt from template
    const systemPrompt = loadPrompt(entry.prompt_file, {
      name: entry.name,
      role: entry.role,
      agent_id: entry.agent_id,
      employee_id: entry.employee_id,
      founder_name: founder.name,
      founder_agent_key: founder.agentKey,
      founder_raw: founder.raw,
      company_name: config.companyName,
    });

    const effectiveModel = getEffectiveModel(entry.agent_id);
    this.agent = new Agent({
      initialState: {
        systemPrompt,
        model: getModel(effectiveModel.provider as any, effectiveModel.model as any),
        thinkingLevel: config.thinkingLevel,
        tools: this._filteredTools(),
        messages: [],
      },
      transformContext: makeCompactionTransform(100),
      getApiKey: codexApiKeyResolver(),
    });

    this.compactor = new AutoCompactor(this.agent, {
      agentId: this.agentId,
      enablePreFlush: false,
    });

    // Restore conversation history from previous session
    const savedHistory = loadAgentHistory(this.agentId);
    if (savedHistory.length > 0) {
      this.agent.replaceMessages(savedHistory);
    }

    // Stream bus + event log + history persistence
    this.agent.subscribe((event: AgentEvent) => {
      publishAgentStream(this.agentId, event);
      if (event.type === "tool_execution_start") {
        EventLog.log(
          EventType.AGENT_TOOL_CALL, this.agentId, "",
          `${entry.name} calling tool: ${event.toolName}`
        );
      }
      if (event.type === "tool_execution_end" && event.isError) {
        EventLog.log(
          EventType.AGENT_TOOL_CALL, this.agentId, "",
          `${entry.name} tool error in ${event.toolName}`
        );
      }
      if (event.type === "agent_end") {
        saveAgentHistory(this.agentId, event.messages as AgentMessage[]);
      }
    });
  }

  // ── Tool filtering ──────────────────────────────────────────────────────────

  private _filteredTools(): any[] {
    return applyToolConfig(this.agentId, this.allTools);
  }

  // ── VECAgent interface ──────────────────────────────────────────────────────

  subscribeEvents(fn: (event: any) => void): () => void {
    return this.agent.subscribe(fn as any);
  }

  followUp(text: string): void {
    this.agent.followUp({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    } as any);
  }

  steer(text: string): void {
    this.agent.steer({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    } as any);
  }

  clearHistory(): void {
    this.agent.clearMessages();
  }

  abort(): void {
    this.agent.abort();
  }

  async prompt(text: string): Promise<void> {
    this.agent.setTools(this._filteredTools());
    const debug = startPromptDebugMonitor(this.agent, this.agentId, this.entry.name, {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(
      EventType.AGENT_THINKING, this.agentId, "",
      `${this.entry.name} LLM request started (awaiting stream/tool events)`
    );
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(
        EventType.AGENT_THINKING, this.agentId, "",
        `${this.entry.name} LLM request completed`
      );
    } catch (err) {
      debug.stop("error", err);
      if (!String(err).includes("already processing")) {
        EventLog.log(
          EventType.TASK_FAILED, this.agentId, "",
          `${this.entry.name} prompt error: ${err}`
        );
      }
      throw err;
    }
  }

  // ── Task execution ──────────────────────────────────────────────────────────

  async executeTask(taskId: string): Promise<void> {
    if (this._isRunning) {
      console.warn(
        `[${this.entry.name}] executeTask called while already running — skipping ${taskId}`
      );
      return;
    }
    this._isRunning = true;
    try {
      await this._executeTaskInner(taskId);
    } finally {
      this._isRunning = false;
    }
  }

  private async _executeTaskInner(taskId: string): Promise<void> {
    const { db, pmQueue, agentQueue } = this.deps;
    const normalizedId = taskId.trim().toUpperCase();

    const task = db.getTask(normalizedId);
    if (!task) {
      console.error(`[${this.entry.name}] Task ${normalizedId} not found.`);
      return;
    }
    if (task.agent_id !== this.agentId) {
      console.error(
        `[${this.entry.name}] Task ${normalizedId} is assigned to '${task.agent_id}', not ${this.agentId}.`
      );
      return;
    }

    // Apply latest tool config from dashboard before executing
    this.agent.setTools(this._filteredTools());

    // Mark in_progress
    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(
      EventType.TASK_IN_PROGRESS, this.agentId, normalizedId,
      `${this.entry.name} started executing ${normalizedId}`
    );

    // Git auto-init for agents with git capability
    const projectDir = this.entry.capabilities.git
      ? getProjectDirFromFolderAccess(task.folder_access)
      : null;
    if (projectDir) {
      try {
        autoInitRepo(projectDir);
      } catch (e) {
        EventLog.log(
          EventType.AGENT_THINKING, this.agentId, normalizedId,
          `Git auto-init skipped: ${e}`
        );
      }
    }

    // Check for priority interrupts
    const interrupts = agentQueue.popForAgent(this.agentId, {
      task_id: normalizedId,
      priority: "priority",
    });
    let interruptBlock = "";
    if (interrupts.length) {
      const joined = interrupts.map((m) => `- ${m.message}`).join("\n");
      interruptBlock =
        `\n\nPRIORITY INTERRUPT FROM PM (HANDLE FIRST):\n${joined}\n` +
        "Acknowledge this in your next progress update and adapt immediately.";
      pmQueue.pushSimple(
        this.agentId, normalizedId,
        `Priority interrupt received for ${normalizedId}. Handling now.`, "info"
      );
    }

    const memory = loadAgentMemory(this.agentId);
    const taskPrompt =
      (memory ? `${memory}\n\n` : "") +
      `You have been assigned ATP Task ${normalizedId}.\n\n` +
      `Task Description: ${task.description}\n` +
      `Priority: ${task.priority}\n` +
      `Folder Access: ${task.folder_access || "N/A"}\n\n` +
      `Execution requirements:\n` +
      `- Start by checking task details with read_task_details(task_id='${normalizedId}')\n` +
      `- Check PM instructions via read_task_messages(task_id='${normalizedId}', priority='normal')\n` +
      `- THINK: plan your approach before doing anything\n` +
      `- DO: execute the task using your available tools\n` +
      `- ONLY THEN: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
      `  Your result MUST include what you produced and where it is.` +
      interruptBlock;

    const MAX_CONT = MAX_CONTINUATIONS;
    try {
      // Wait for idle if an inbox prompt is still running
      await this.agent.waitForIdle();

      let startedTaskPrompt = false;
      for (let attempt = 1; attempt <= 2 && !startedTaskPrompt; attempt++) {
        try {
          this.agent.clearMessages();
          await this.compactor.run(() => this.agent.prompt(taskPrompt));
          startedTaskPrompt = true;
        } catch (err) {
          const errMsg = String(err);
          if (errMsg.includes("already processing") && attempt < 2) {
            await this.agent.waitForIdle();
            continue;
          }
          throw err;
        }
      }

      // Continuation loop
      for (let attempt = 1; attempt <= MAX_CONT; attempt++) {
        const latest = db.getTask(normalizedId);
        if (!latest || latest.status !== "in_progress") break;

        EventLog.log(
          EventType.AGENT_THINKING, this.agentId, normalizedId,
          `${this.entry.name} stopped without closing ${normalizedId} — continuing (${attempt}/${MAX_CONT})`
        );
        this.agent.followUp({
          role: "user",
          content: [{
            type: "text",
            text:
              `${normalizedId} is still in_progress. Continue working — do NOT stop until you call update_my_task.\n` +
              `If done: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
              `If blocked: update_my_task(task_id='${normalizedId}', status='failed', result='reason')`,
          }],
          timestamp: Date.now(),
        } as any);
        await this.compactor.run(() => this.agent.continue());
      }

      // Git auto-commit safety net
      const final = db.getTask(normalizedId);
      if (final?.status === "completed" && projectDir) {
        try {
          const committed = autoCommitIfDirty(projectDir, normalizedId, task.description);
          if (committed) {
            EventLog.log(
              EventType.AGENT_THINKING, this.agentId, normalizedId,
              `Auto-committed uncommitted changes for ${normalizedId}`
            );
          }
        } catch (e) {
          EventLog.log(
            EventType.AGENT_THINKING, this.agentId, normalizedId,
            `Git auto-commit failed: ${e}`
          );
        }
      }

      // Hard fallback: if still in_progress after all re-prompts, mark failed
      if (final?.status === "in_progress") {
        const fallbackMsg = `${this.entry.name} did not complete the task after multiple prompts — marking failed for retry.`;
        db.updateTaskStatus(normalizedId, "failed", fallbackMsg);
        pmQueue.pushSimple(this.agentId, normalizedId, `Task ${normalizedId} FAILED: ${fallbackMsg}`, "error");
        EventLog.log(
          EventType.TASK_FAILED, this.agentId, normalizedId,
          `${this.entry.name} gave up on ${normalizedId} after ${MAX_CONT} re-prompts`
        );
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `${this.entry.name} runtime error: ${errMsg}`);
      pmQueue.pushSimple(this.agentId, normalizedId, `Task ${normalizedId} FAILED: ${errMsg}`, "error");
      EventLog.log(
        EventType.TASK_FAILED, this.agentId, normalizedId,
        `${this.entry.name} crashed on ${normalizedId}: ${errMsg}`
      );
    }
  }
}
