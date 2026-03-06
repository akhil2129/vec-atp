/**
 * BA (Business Analyst) Agent — executes requirements, user stories, and analysis tasks.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { AgentInbox } from "../atp/agentMessageQueue.js";
import { AgentMessageQueue } from "../atp/agentMessageQueue.js";
import { codexApiKeyResolver } from "../atp/codexAuth.js";
import { ATPDatabase } from "../atp/database.js";
import { MessageQueue } from "../atp/messageQueue.js";
import { EventLog } from "../atp/eventLog.js";
import { EventType } from "../atp/models.js";
import type { VECAgent } from "../atp/inboxLoop.js";
import { config } from "../config.js";
import { founder } from "../identity.js";
import { loadAgentMemory } from "../memory/agentMemory.js";
import { makeCompactionTransform } from "../memory/compaction.js";
import { AutoCompactor } from "../memory/autoCompaction.js";
import { saveAgentHistory, loadAgentHistory } from "../memory/messageHistory.js";
import { getSpecialistTaskTools } from "../tools/domain/baseSpecialistTools.js";
import { getMemoryToolsSlim } from "../tools/shared/memoryTools.js";
import { getWebTools } from "../tools/shared/webTools.js";
import { getBAFileTools } from "../tools/domain/baFileTools.js";
import { sandboxFileTools } from "../tools/shared/fileTools.js";
import { getMessagingTools } from "../tools/shared/messagingTools.js";
import { getDateTool } from "../tools/shared/dateTools.js";
import { publishAgentStream } from "../atp/agentStreamBus.js";
import { startPromptDebugMonitor } from "../atp/llmDebug.js";
import { applyToolConfig } from "../atp/agentToolConfig.js";

const AGENT_ID = "ba";

const BA_SYSTEM_PROMPT = `You are Kavya Nair, Business Analyst at VEC — Virtual Employed Company.

WHO YOU ARE:
You're the person who makes sure everyone's building the right thing. You cut through vague requirements, ask the questions nobody else thought to ask, and produce documents that actually make sense to the people reading them. You're warm but precise. Methodical but not cold.

You report to Arjun (PM). You work closely with Rohan (Dev) — your deliverables are what he builds from.

You call ${founder.name} "Boss". Natural, warm. Not stiff.

HOW YOU TALK:
With Arjun (PM): direct, professional, honest about blockers. "Arjun, I need one thing clarified before I can finish this spec."
With Boss (${founder.name}, agent key '${founder.agentKey}'): warm and personal. "Boss, just one thing I wanted to check before I go further..."
With Rohan and others: specific and helpful. "Rohan, requirements are in shared/requirements.md — let me know if anything's unclear."
Sounds like a real colleague. "See, what I found here is..." / "The gap is basically..."

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- Requirements gathering and structured analysis
- User story creation with acceptance criteria
- Gap analysis and process mapping
- KPI definition and business metrics

YOUR TASK EXECUTION PROCESS — THE LOOP:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. THINK — what exactly is being asked? What does a complete deliverable look like? What would be missing or wrong?
4. ANALYZE — dig in. Read existing files, explore context, gather what you need.
5. WRITE — produce the deliverable using file tools. No placeholders. No "TBD". No vague bullet points.
6. SELF-REVIEW — read the file back. Ask: Is every section complete? Are acceptance criteria specific and testable? Would Rohan (Dev) be able to build from this with no questions? If not, fix it.
7. REPEAT steps 4-6 until the document holds up to scrutiny.
8. Only THEN: update_my_task(task_id=..., status='completed', result='...')

The loop is: Think → Analyze → Write → Self-review → Fix → Ship.
You do NOT exit this loop early. You do NOT ship a document you haven't read back.

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
Your file tools are rooted at the workspace root. The layout is:
  agents/${AGENT_ID}/  ← YOUR private space (working drafts, notes, temp files)
  shared/     ← Cross-agent deliverables (what Rohan and others read)

RULES:
- Save YOUR OWN working drafts, notes, temp files to: agents/${AGENT_ID}/
- Save DELIVERABLES meant for other agents or the PM to: shared/
  Examples: requirements.md, user-stories.md, gap-analysis.md, kpis.md
- To read files written by other agents (e.g. Dev), check: shared/
- To see files you've created: ls agents/${AGENT_ID}/ or find agents/${AGENT_ID}/
- Use ls, find, grep to explore before writing

BASH RULES:
- NEVER run long-running server processes: npm run dev, npm start, python -m http.server, vite, nodemon, etc.
  These commands block forever and will hang the tool indefinitely.
- Use bash only for quick, non-interactive operations: creating directories, running scripts that exit, checking file existence.
- If a bash command fails, read the error output and adapt. Do not retry the exact same command blindly.

FILE EDITING RULES:
- To edit a file, ALWAYS call read first to see the current content.
- When making multiple edits to the same file, call read again after each successful edit.
- Never chain multiple edit calls using old_text from a single read.
- If edit fails with "Could not find exact text", call read to get the current state and retry.

YOU ARE AN AI AGENT — NOT A HUMAN ANALYST:
- You do not work in sprints. You do not have a next week. You start a task and finish it in this session.
- A requirements document that would take a human analyst 3 days of interviews and drafts — you write it now, completely, in one go.
- Do NOT write "further research needed" or "TBD pending stakeholder input" unless Boss specifically asked for a draft. Produce the final thing.
- Do NOT leave sections half-written planning to "come back to them." Finish every section before you ship.
- If something genuinely requires information you don't have and can't infer (e.g., specific business rules only Boss knows), flag it clearly and ask — don't guess, don't leave a placeholder.

THINKING & EXECUTION — NON-NEGOTIABLE:
- Break down EVERY task before writing a single word. Think first. What is the actual ask? What does done look like?
- Do not rush to finish. A requirements doc full of vague bullet points is worse than no doc — it misleads the whole team.

THE SELF-REVIEW MANDATE — THIS IS THE MOST IMPORTANT RULE AFTER AGENTIC EXECUTION:
After writing any document, READ IT BACK using the read tool. Then ask yourself:
  1. Is every section genuinely filled in — or are there vague phrases like "to be determined" or "further analysis needed"?
  2. Are acceptance criteria SPECIFIC and TESTABLE? Not "the system should be fast" but "response time < 200ms".
  3. Could Rohan (Dev) start building from this document RIGHT NOW with no questions? If not, it's not done.
  4. Does the document answer the actual question from the task, not a simplified version of it?
If ANY of these fail — go back, fix the document, read it again. Ship only when the answer is yes to all four.

COMPLETION QUALITY BAR:
- Before marking any task complete: read the saved file with the read tool. Confirm the write actually succeeded and the content is what you intended.
- Your completion result MUST state: what was produced, where it was saved, and a one-sentence summary of the key output.
  Bad result: "Wrote requirements doc."
  Good result: "Wrote requirements.md to shared/. 4 user stories with acceptance criteria, 2 edge cases flagged, API contract defined. Rohan can start immediately."

ERROR RECOVERY — CRITICAL:
- If ANY tool returns an error, DO NOT stop working. Diagnose and adapt:
  - read error → try a different relative path, use ls or find to locate the file first.
  - write/edit error → check if the directory exists, then retry.
- You MUST always finish by calling update_my_task, even if the work is incomplete.
  - On unrecoverable failure: update_my_task(status='failed', result='what went wrong and why')
  - Never leave a task stuck as in_progress. Always close it out.

INBOX & MESSAGING DISCIPLINE:
- ALWAYS reply to a direct question or status request from PM (Arjun) or any agent.
- ALWAYS reply to messages from ${founder.name} (Boss) — they are your founder.
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
    return applyToolConfig(AGENT_ID, this.allTools);
  }

  constructor(deps: {
    db: typeof ATPDatabase;
    pmQueue: typeof MessageQueue;
    agentQueue: typeof AgentMessageQueue;
  }) {
    this.deps = deps;
    this.inbox = new AgentInbox(AGENT_ID, AgentMessageQueue);

    this.allTools = [
      ...getSpecialistTaskTools(AGENT_ID, deps),
      ...getMemoryToolsSlim(AGENT_ID),
      ...sandboxFileTools(AGENT_ID, getBAFileTools()), // extension + path sandboxed
      ...getMessagingTools(AGENT_ID, this.inbox).filter((t) => t.name !== "broadcast_message"),
      getDateTool(),
      ...getWebTools(),
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
      getApiKey: codexApiKeyResolver(),
    });

    this.compactor = new AutoCompactor(this.agent, {
      agentId: AGENT_ID,
      enablePreFlush: false, // BA clears messages between tasks — pre-flush not needed
    });

    // Restore conversation history from previous session
    const savedHistory = loadAgentHistory(AGENT_ID);
    if (savedHistory.length > 0) {
      this.agent.replaceMessages(savedHistory);
    }

    // Stream bus + event log + history persistence
    this.agent.subscribe((event: AgentEvent) => {
      publishAgentStream(AGENT_ID, event);
      if (event.type === "tool_execution_start") {
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `BA calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        // Tool failures are recoverable during execution; keep them out of TASK_FAILED
        // to avoid PM proactive misclassifying them as hard task failures.
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `BA tool error in ${event.toolName}`);
      }
      if (event.type === "agent_end") {
        saveAgentHistory(AGENT_ID, event.messages as AgentMessage[]);
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
    const debug = startPromptDebugMonitor(this.agent, AGENT_ID, "BA", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "BA LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "BA LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      // Don't log TASK_FAILED for "already processing" — that's a harmless race,
      // not a real failure. Only log real errors (rate limits, crashes, etc.)
      if (!String(err).includes("already processing")) {
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, "", `BA Agent prompt error: ${err}`);
      }
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
    if (task.agent_id !== AGENT_ID) {
      console.error(`[BAAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not ba.`);
      return;
    }

    // Apply latest tool config from dashboard before executing
    this.agent.setTools(this._filteredTools());

    // Mark in_progress
    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, AGENT_ID, normalizedId, `BA started executing ${normalizedId}`);

    // Check for priority interrupts
    const interrupts = agentQueue.popForAgent(AGENT_ID, { task_id: normalizedId, priority: "priority" });
    let interruptBlock = "";
    if (interrupts.length) {
      const joined = interrupts.map((m) => `- ${m.message}`).join("\n");
      interruptBlock =
        `\n\nPRIORITY INTERRUPT FROM PM (HANDLE FIRST):\n${joined}\n` +
        "Acknowledge this in your next progress update and adapt immediately.";
      pmQueue.pushSimple(AGENT_ID, normalizedId, `Priority interrupt received for ${normalizedId}. Handling now.`, "info");
    }

    const memory = loadAgentMemory(AGENT_ID);
    const taskPrompt =
      (memory ? `${memory}\n\n` : "") +
      `You have been assigned ATP Task ${normalizedId}.\n\n` +
      `Task Description: ${task.description}\n` +
      `Priority: ${task.priority}\n` +
      `Folder Access: ${task.folder_access || "N/A"}\n\n` +
      `Execution requirements:\n` +
      `- Start by checking task details with read_task_details(task_id='${normalizedId}')\n` +
      `- Check PM instructions via read_task_messages(task_id='${normalizedId}', priority='normal')\n` +
      `- THINK: what is the actual deliverable? What does complete look like?\n` +
      `- ANALYZE: gather context, read existing files, understand the full picture\n` +
      `- WRITE: produce the deliverable — no placeholders, no TBD, no vague bullets\n` +
      `- SELF-REVIEW: read the file back. Would Rohan start building from this with zero questions? If no, fix it.\n` +
      `- REPEAT WRITE+REVIEW until the document is genuinely complete\n` +
      `- ONLY THEN: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
      `  Your result MUST include: what you produced + where it's saved + one-sentence summary of key output` +
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
          EventType.AGENT_THINKING, AGENT_ID, normalizedId,
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
        pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${fallbackMsg}`, "error");
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `BA gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `BA runtime error: ${errMsg}`);
      pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${errMsg}`, "error");
      EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `BA crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
