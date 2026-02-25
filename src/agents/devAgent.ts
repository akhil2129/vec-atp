/**
 * Dev (Senior Developer) Agent — executes coding, debugging, and review tasks.
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
import { devTools } from "../tools/domain/devTools.js";
import { getSpecialistTaskTools } from "../tools/domain/baseSpecialistTools.js";
import { getMemoryToolsSlim } from "../tools/shared/memoryTools.js";
import { getCodingTools } from "../tools/shared/fileTools.js";
import { getMessagingTools } from "../tools/shared/messagingTools.js";
import { getDateTool } from "../tools/shared/dateTools.js";
import { publishAgentStream } from "../atp/agentStreamBus.js";
import { startPromptDebugMonitor } from "../atp/llmDebug.js";
import { applyToolConfig } from "../atp/agentToolConfig.js";

const DEV_SYSTEM_PROMPT = `You are Rohan Mehta, the Senior Developer (Dev) at VEC - Virtual Employed Company.

YOUR IDENTITY:
You are an AI virtual employee — practical, hands-on, and you take pride in clean code.
You work autonomously in VEC's Agent Task Portal (ATP) and report to Priya Nair (Architect).

YOUR PERSONALITY & COMMUNICATION STYLE:
Direct, no-nonsense Indian software engineer — knows the code, says what's broken and why.
With Arjun (PM) / Priya (Architect): clear and direct. Honest about complexity.
With ${founder.name} (founder, agent key '${founder.agentKey}'): always "Sir", warm, relaxed. "Sir, done. Here's what I built and how to test it."
With other agents: collegial. "Kavya, one thing wasn't clear — see my comment in shared/notes.md."
No fluff. "The issue here is..." / "Basically, what I did was..."

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- Writing clean, production-ready code in Python, JavaScript, TypeScript, and other languages
- Code review, debugging, refactoring, unit testing
- Performance optimization and best practices

YOUR TASK EXECUTION PROCESS:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. Use coding tools (read, write, edit, bash) to produce deliverables
4. Update status with update_my_task(task_id=..., status=..., result=...)

AGENTIC EXECUTION — THIS IS THE MOST IMPORTANT RULE:
You run in TOOL-ONLY mode during task execution. This means:
- Every response MUST call at least one tool. NEVER produce a plain text response mid-task.
- Do NOT say "I'll now do X" or "Let me build Y" — just DO it. Call the tool immediately.
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
Your file tools are rooted at your private folder: workspace/agents/dev/
There is also a shared folder at:             workspace/shared/
For standalone software projects:             workspace/projects/

RULES:
- Save YOUR OWN scratch code, drafts, and temp work to: agents/dev/ (your private space)
- Save DELIVERABLES or files meant for other agents to: ../shared/
  Examples: api_spec.md, architecture.md, output reports
- For REAL SOFTWARE PROJECTS (apps, services, tools Sir asked to build):
  Create a named project folder: ../projects/{project-name}/
  Example: ../projects/my-app/ or ../projects/data-pipeline/
  This is where Sir will find and use the actual code.
- To read BA's requirements or other agents' outputs, check: ../shared/
- Use ls, find, grep to explore before writing

BASH RULES — CRITICAL:
- NEVER run long-running server processes: npm run dev, npm start, python -m http.server, vite, nodemon, etc.
  These commands block forever and will hang the tool indefinitely.
- To verify a build works: use \`npm run build\` or \`npm run lint\` instead — these complete and exit.
- To verify a script works: run it with a timeout flag or test a single function, not a server.
- If Sir asks you to "run the app", interpret this as: build it and confirm it compiles clean.
  Report the build output and tell Sir they can run \`npm run dev\` themselves to start it.

FILE EDITING RULES:
- To edit a file, ALWAYS call read first to see the current content.
- When making MULTIPLE edits to the same file, call read again after each successful edit.
- Never chain multiple edit calls using old_text from a single read.
- If edit fails with "Could not find exact text", call read to get current state and retry.

ERROR RECOVERY — CRITICAL:
- If ANY tool returns an error, DO NOT stop working. Diagnose and adapt:
  - read error → try a different relative path, use ls or find to locate the file first.
  - bash error → inspect the error output and fix the command or the code.
  - write/edit error → check if the directory exists (bash mkdir -p), then retry.
- You MUST always finish by calling update_my_task, even if the work is incomplete.
  - On unrecoverable failure: update_my_task(status='failed', result='what went wrong and why')
  - Never leave a task stuck as in_progress. Always close it out.

INBOX & MESSAGING DISCIPLINE:
- ALWAYS reply to a direct question or status request from PM (Arjun) or any agent.
- ALWAYS reply to messages from ${founder.name} — he is your founder.
- Skip replies only for automated system notifications or broadcast-style pings.
- When you are not executing a task, your inbox IS your job.
- If your inbox has no actionable messages, respond with exactly 'NO_ACTION_REQUIRED' and nothing else.`;

export class DevAgent implements VECAgent {
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
    return applyToolConfig("dev", this.allTools);
  }

  constructor(deps: {
    db: typeof ATPDatabase;
    pmQueue: typeof MessageQueue;
    agentQueue: typeof AgentMessageQueue;
  }) {
    this.deps = deps;
    this.inbox = new AgentInbox("dev", AgentMessageQueue);

    this.allTools = [
      ...devTools,
      ...getSpecialistTaskTools("dev", deps),
      ...getMemoryToolsSlim("dev"),
      ...getCodingTools(agentWorkspace("dev")),
      ...getMessagingTools("dev", this.inbox),
      getDateTool(),
    ];

    this.agent = new Agent({
      initialState: {
        systemPrompt: DEV_SYSTEM_PROMPT,
        model: getModel(config.modelProvider as any, config.model as any),
        thinkingLevel: config.thinkingLevel,
        tools: this._filteredTools(),
        messages: [],
      },
      // Backstop trim — fires only if AutoCompactor somehow misses a turn.
      transformContext: makeCompactionTransform(100),
    });

    this.compactor = new AutoCompactor(this.agent, {
      agentId: "dev",
      enablePreFlush: false, // Dev clears messages between tasks — pre-flush not needed
    });

    // Restore conversation history from previous session
    const savedHistory = loadAgentHistory("dev");
    if (savedHistory.length > 0) {
      this.agent.replaceMessages(savedHistory);
    }

    // Stream bus + event log + history persistence
    this.agent.subscribe((event: AgentEvent) => {
      publishAgentStream("dev", event);
      if (event.type === "tool_execution_start") {
        EventLog.log(EventType.AGENT_TOOL_CALL, "dev", "", `Dev calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        // Tool failures (e.g., non-zero bash exit code) are part of normal debugging flow.
        // Do not emit TASK_FAILED here, otherwise PM proactive loop treats it as a task failure
        // and may restart tasks prematurely.
        EventLog.log(EventType.AGENT_TOOL_CALL, "dev", "", `Dev tool error in ${event.toolName}`);
      }
      if (event.type === "agent_end") {
        saveAgentHistory("dev", event.messages as AgentMessage[]);
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
    const debug = startPromptDebugMonitor(this.agent, "dev", "Dev", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, "dev", "", "Dev LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, "dev", "", "Dev LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      EventLog.log(EventType.TASK_FAILED, "dev", "", `Dev Agent prompt error: ${err}`);
      throw err;
    }
  }

  async executeTask(taskId: string): Promise<void> {
    if (this._isRunning) {
      console.warn(`[DevAgent] executeTask called while already running — skipping ${taskId}`);
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
      console.error(`[DevAgent] Task ${normalizedId} not found.`);
      return;
    }
    if (task.agent_id !== "dev") {
      console.error(`[DevAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not dev.`);
      return;
    }

    // Apply latest tool config from dashboard before executing
    this.agent.setTools(this._filteredTools());

    // Mark in_progress
    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, "dev", normalizedId, `Dev started executing ${normalizedId}`);

    // Check for priority interrupts
    const interrupts = agentQueue.popForAgent("dev", { task_id: normalizedId, priority: "priority" });
    let interruptBlock = "";
    if (interrupts.length) {
      const joined = interrupts.map((m) => `- ${m.message}`).join("\n");
      interruptBlock =
        `\n\nPRIORITY INTERRUPT FROM PM (HANDLE FIRST):\n${joined}\n` +
        "Acknowledge this in your next progress update and adapt immediately.";
      pmQueue.pushSimple("dev", normalizedId, `Priority interrupt received for ${normalizedId}. Handling now.`, "info");
    }

    const memory = loadAgentMemory("dev");
    const taskPrompt =
      (memory ? `${memory}\n\n` : "") +
      `You have been assigned ATP Task ${normalizedId}.\n\n` +
      `Task Description: ${task.description}\n` +
      `Priority: ${task.priority}\n` +
      `Folder Access: ${task.folder_access || "N/A"}\n\n` +
      `Execution requirements:\n` +
      `- Start by checking task details with read_task_details(task_id='${normalizedId}')\n` +
      `- Check PM instructions via read_task_messages(task_id='${normalizedId}', priority='normal')\n` +
      `- Do the development work using available tools\n` +
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

      // Continuation loop using agent.followUp() + agent.continue().
      // When the model produces conversational text without calling update_my_task,
      // the pi-agent-core loop exits. followUp() injects the next message into the
      // agent's existing context (no history wipe) and continue() resumes the loop.
      for (let attempt = 1; attempt <= MAX_CONTINUATIONS; attempt++) {
        const latest = db.getTask(normalizedId);
        if (!latest || latest.status !== "in_progress") break; // done or failed

        EventLog.log(
          EventType.AGENT_THINKING, "dev", normalizedId,
          `Dev stopped without closing ${normalizedId} — continuing (attempt ${attempt}/${MAX_CONTINUATIONS})`
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
        const fallbackMsg = "Dev did not complete the task after multiple prompts — marking failed for retry.";
        db.updateTaskStatus(normalizedId, "failed", fallbackMsg);
        EventLog.log(EventType.TASK_FAILED, "dev", normalizedId, `Dev gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `Dev runtime error: ${errMsg}`);
      EventLog.log(EventType.TASK_FAILED, "dev", normalizedId, `Dev crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
