/**
 * BA (Business Analyst) Agent — executes requirements, user stories, and analysis tasks.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { AgentInbox } from "../atp/agentMessageQueue.js";
import { AgentMessageQueue } from "../atp/agentMessageQueue.js";
import { ATPDatabase } from "../atp/database.js";
import { MessageQueue } from "../atp/messageQueue.js";
import { EventLog } from "../atp/eventLog.js";
import { EventType } from "../atp/models.js";
import type { VECAgent } from "../atp/inboxLoop.js";
import { config, agentWorkspace } from "../config.js";
import { founder } from "../identity.js";
import { loadAgentMemory } from "../memory/agentMemory.js";
import { makeCompactionTransform } from "../memory/compaction.js";
import { AutoCompactor } from "../memory/autoCompaction.js";
import { saveAgentHistory, loadAgentHistory } from "../memory/messageHistory.js";
import { baTools } from "../tools/domain/baTools.js";
import { getSpecialistTaskTools } from "../tools/domain/baseSpecialistTools.js";
import { getMemoryToolsSlim } from "../tools/shared/memoryTools.js";
import { getCodingTools } from "../tools/shared/fileTools.js";
import { getMessagingTools } from "../tools/shared/messagingTools.js";
import { getDateTool } from "../tools/shared/dateTools.js";
import { publishAgentStream } from "../atp/agentStreamBus.js";
import { startPromptDebugMonitor } from "../atp/llmDebug.js";
import { applyToolConfig } from "../atp/agentToolConfig.js";

const BA_SYSTEM_PROMPT = `You are Kavya Nair, the Business Analyst (BA) at VEC - Virtual Employed Company.

YOUR IDENTITY:
You are an AI virtual employee — methodical, sharp, and good at cutting through ambiguity.
You work autonomously in VEC's Agent Task Portal (ATP) and report to Arjun Sharma (PM).

YOUR PERSONALITY & COMMUNICATION STYLE:
Warm, analytical, direct Indian tech professional — sounds like a smart colleague, not a robot.
With Arjun (PM): direct and professional. Honest about blockers.
With ${founder.name} (founder, agent key '${founder.agentKey}'): always "Sir", warm, personal. "Sir, just wanted to clarify one thing before I proceed..."
With other agents: collegial and specific. "Rohan, I've put the requirements in shared/requirements.md."
"See, looking at these requirements..." / "Basically, the gap here is..."

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- Requirements gathering and structured analysis
- User story creation with acceptance criteria
- Gap analysis and process mapping
- KPI definition and business metrics

YOUR TASK EXECUTION PROCESS:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. Use analysis tools to produce structured deliverables
4. Use file tools to save deliverables to workspace if needed
5. Update status with update_my_task(task_id=..., status=..., result=...)

AGENTIC EXECUTION — THIS IS THE MOST IMPORTANT RULE:
You run in TOOL-ONLY mode during task execution. This means:
- Every response MUST call at least one tool. NEVER produce a plain text response mid-task.
- Do NOT say "I'll now do X" or "Let me analyse Y" — just DO it. Call the tool immediately.
- Do NOT narrate, explain, or summarise while working. Use tools, not words.
- update_my_task is your ONLY valid exit. Until you call it, keep calling tools.
- If you feel done but haven't called update_my_task — call it now with status='completed'.
- If stuck — call update_my_task with status='failed' and explain why.
- NEVER end a response without either a tool call or update_my_task. No exceptions.

CRITICAL RULES:
- Always use explicit ATP Task IDs (TASK-XXX)
- Always pass task_id explicitly when calling update_my_task
- When done: update_my_task(task_id='TASK-XXX', status='completed', result='...')
- On errors: update_my_task(task_id='TASK-XXX', status='failed', result='reason')

WORKSPACE STRUCTURE:
Your file tools are rooted at your private folder: workspace/agents/ba/
There is also a shared folder at:            workspace/shared/

RULES:
- Save YOUR OWN working drafts, notes, and temp files to: agents/ba/ (your private space)
- Save DELIVERABLES meant for other agents or the PM to: ../shared/ (shared space)
  Examples of shared deliverables: requirements.md, user-stories.md, gap-analysis.md, kpis.md
- To read files written by other agents (e.g. Dev), check: ../shared/
- Use ls, find, grep to explore before writing

ERROR RECOVERY — CRITICAL:
- If ANY tool returns an error, DO NOT stop working. Diagnose and adapt:
  - read error → try a different relative path, use ls or find to locate the file first.
  - write/edit error → check if the directory exists, then retry.
- You MUST always finish by calling update_my_task, even if the work is incomplete.
  - On unrecoverable failure: update_my_task(status='failed', result='what went wrong and why')
  - Never leave a task stuck as in_progress. Always close it out.

INBOX & MESSAGING DISCIPLINE:
- ALWAYS reply to a direct question or status request from PM (Arjun) or any agent.
- ALWAYS reply to messages from ${founder.name} — he is your founder.
- Skip replies only for automated system notifications or broadcast-style pings.
- When you are not executing a task, your inbox IS your job.
- If your inbox has no actionable messages, respond with exactly 'NO_ACTION_REQUIRED' and nothing else.`;

export class BAAgent implements VECAgent {
  readonly inbox: AgentInbox;
  private agent: Agent;
  private compactor: AutoCompactor;
  private _isRunning = false;
  get isRunning() { return this._isRunning; }
  private allTools: any[];
  private deps: {
    db: typeof ATPDatabase;
    pmQueue: typeof MessageQueue;
    agentQueue: typeof AgentMessageQueue;
  };

  private _filteredTools() {
    return applyToolConfig("ba", this.allTools);
  }

  constructor(deps: {
    db: typeof ATPDatabase;
    pmQueue: typeof MessageQueue;
    agentQueue: typeof AgentMessageQueue;
  }) {
    this.deps = deps;
    this.inbox = new AgentInbox("ba", AgentMessageQueue);

    this.allTools = [
      ...baTools,
      ...getSpecialistTaskTools("ba", deps),
      ...getMemoryToolsSlim("ba"),
      ...getCodingTools(agentWorkspace("ba")),
      ...getMessagingTools("ba", this.inbox),
      getDateTool(),
    ];

    this.agent = new Agent({
      initialState: {
        systemPrompt: BA_SYSTEM_PROMPT,
        model: getModel(config.modelProvider as any, config.model as any),
        thinkingLevel: config.thinkingLevel,
        tools: this._filteredTools(),
        messages: [],
      },
      // Backstop trim — fires only if AutoCompactor somehow misses a turn.
      transformContext: makeCompactionTransform(100),
    });

    this.compactor = new AutoCompactor(this.agent, {
      agentId: "ba",
      enablePreFlush: false, // BA clears messages between tasks — pre-flush not needed
    });

    // Restore conversation history from previous session
    const savedHistory = loadAgentHistory("ba");
    if (savedHistory.length > 0) {
      this.agent.replaceMessages(savedHistory);
    }

    // Stream bus + event log + history persistence
    this.agent.subscribe((event: AgentEvent) => {
      publishAgentStream("ba", event);
      if (event.type === "tool_execution_start") {
        EventLog.log(EventType.AGENT_TOOL_CALL, "ba", "", `BA calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        // Tool failures are recoverable during execution; keep them out of TASK_FAILED
        // to avoid PM proactive misclassifying them as hard task failures.
        EventLog.log(EventType.AGENT_TOOL_CALL, "ba", "", `BA tool error in ${event.toolName}`);
      }
      if (event.type === "agent_end") {
        saveAgentHistory("ba", event.messages as AgentMessage[]);
      }
    });
  }

  subscribeEvents(fn: (event: any) => void): () => void {
    return this.agent.subscribe(fn as any);
  }

  followUp(text: string): void {
    this.agent.followUp({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as any);
  }

  steer(text: string): void {
    this.agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as any);
  }

  clearHistory(): void {
    this.agent.clearMessages();
  }

  abort(): void {
    this.agent.abort();
  }

  async prompt(text: string): Promise<void> {
    this.agent.setTools(this._filteredTools());
    const debug = startPromptDebugMonitor(this.agent, "ba", "BA", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, "ba", "", "BA LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, "ba", "", "BA LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      EventLog.log(EventType.TASK_FAILED, "ba", "", `BA Agent prompt error: ${err}`);
      throw err;
    }
  }

  async executeTask(taskId: string): Promise<void> {
    if (this._isRunning) {
      console.warn(`[BAAgent] executeTask called while already running — skipping ${taskId}`);
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
      console.error(`[BAAgent] Task ${normalizedId} not found.`);
      return;
    }
    if (task.agent_id !== "ba") {
      console.error(`[BAAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not ba.`);
      return;
    }

    // Apply latest tool config from dashboard before executing
    this.agent.setTools(this._filteredTools());

    // Mark in_progress
    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, "ba", normalizedId, `BA started executing ${normalizedId}`);

    // Check for priority interrupts
    const interrupts = agentQueue.popForAgent("ba", { task_id: normalizedId, priority: "priority" });
    let interruptBlock = "";
    if (interrupts.length) {
      const joined = interrupts.map((m) => `- ${m.message}`).join("\n");
      interruptBlock =
        `\n\nPRIORITY INTERRUPT FROM PM (HANDLE FIRST):\n${joined}\n` +
        "Acknowledge this in your next progress update and adapt immediately.";
      pmQueue.pushSimple("ba", normalizedId, `Priority interrupt received for ${normalizedId}. Handling now.`, "info");
    }

    const memory = loadAgentMemory("ba");
    const taskPrompt =
      (memory ? `${memory}\n\n` : "") +
      `You have been assigned ATP Task ${normalizedId}.\n\n` +
      `Task Description: ${task.description}\n` +
      `Priority: ${task.priority}\n` +
      `Folder Access: ${task.folder_access || "N/A"}\n\n` +
      `Execution requirements:\n` +
      `- Start by checking task details with read_task_details(task_id='${normalizedId}')\n` +
      `- Check PM instructions via read_task_messages(task_id='${normalizedId}', priority='normal')\n` +
      `- Do the analysis work using available tools\n` +
      `- Update status: update_my_task(task_id='${normalizedId}', status='completed', result='full deliverable')` +
      interruptBlock;

    const MAX_CONTINUATIONS = 3;
    try {
      // If an inbox prompt is still running, wait until it finishes before
      // starting task-mode prompt to avoid "already processing a prompt" crashes.
      await this.agent.waitForIdle();

      let startedTaskPrompt = false;
      for (let attempt = 1; attempt <= 2 && !startedTaskPrompt; attempt++) {
        try {
          // Fresh task context must be cleared only when the agent is idle.
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

      // Re-prompt loop: if the LLM stopped without calling update_my_task, push it back.
      for (let attempt = 1; attempt <= MAX_CONTINUATIONS; attempt++) {
        const latest = db.getTask(normalizedId);
        if (!latest || latest.status !== "in_progress") break; // done or failed

        EventLog.log(
          EventType.AGENT_THINKING, "ba", normalizedId,
          `BA stopped without closing ${normalizedId} — continuing (attempt ${attempt}/${MAX_CONTINUATIONS})`
        );
        this.agent.followUp({
          role: "user",
          content: [{
            type: "text",
            text: `${normalizedId} is still in_progress. Continue working — do NOT stop until you call update_my_task.\n` +
                  `If done: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
                  `If blocked: update_my_task(task_id='${normalizedId}', status='failed', result='reason')`,
          }],
          timestamp: Date.now(),
        } as any);
        await this.compactor.run(() => this.agent.continue());
      }

      // Hard fallback: if still in_progress after all re-prompts, mark failed so it doesn't block.
      const final = db.getTask(normalizedId);
      if (final?.status === "in_progress") {
        const fallbackMsg = "BA did not complete the task after multiple prompts — marking failed for retry.";
        db.updateTaskStatus(normalizedId, "failed", fallbackMsg);
        pmQueue.pushSimple("ba", normalizedId, `Task ${normalizedId} FAILED: ${fallbackMsg}`, "error");
        EventLog.log(EventType.TASK_FAILED, "ba", normalizedId, `BA gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `BA runtime error: ${errMsg}`);
      pmQueue.pushSimple("ba", normalizedId, `Task ${normalizedId} FAILED: ${errMsg}`, "error");
      EventLog.log(EventType.TASK_FAILED, "ba", normalizedId, `BA crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
