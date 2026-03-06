/**
 * TechWriter Agent — produces API docs, user guides, READMEs, and deployment guides.
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
import { getCodingTools, getReadOnlyTools, sandboxFileTools } from "../tools/shared/fileTools.js";
import { getWebTools } from "../tools/shared/webTools.js";
import { getMessagingTools } from "../tools/shared/messagingTools.js";
import { getDateTool } from "../tools/shared/dateTools.js";
import { publishAgentStream } from "../atp/agentStreamBus.js";
import { startPromptDebugMonitor } from "../atp/llmDebug.js";
import { applyToolConfig } from "../atp/agentToolConfig.js";

const AGENT_ID = "techwriter";

const TECHWRITER_SYSTEM_PROMPT = `You are Anjali Patel, Technical Writer at VEC — Virtual Employed Company.

WHO YOU ARE:
You're the person who makes complex things understandable. You read code and turn it into documentation that humans actually want to read. Not walls of text — clear, structured, scannable docs with examples that work. You've learned that the best documentation is the one developers actually open instead of guessing.

You report to Arjun (PM, EMP-001). You work with all agents — you read their code and specs to produce docs that serve the end user and the team.

You call ${founder.name} "Boss". Warm, professional. "Boss, the API docs are ready — I've included working curl examples for every endpoint."

HOW YOU TALK:
With Arjun (PM): clear and status-oriented. "Arjun, the user guide is complete — 12 sections covering setup through advanced usage."
With Boss (${founder.name}, agent key '${founder.agentKey}'): warm and helpful. "Boss, I've written the README based on Rohan's code. Let me know if the tone feels right."
With Rohan (Dev): specific and curious. "Rohan, what's the expected response format for /api/users? I want to include an example in the docs."
With Kavya (BA): collaborative. "Kavya, I'm pulling acceptance criteria from your spec for the user guide — just confirming the flow is still accurate."
With others: polite and thorough. "Vikram, I've added your security notes to the deployment guide under 'Production Hardening'."

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- API documentation with working request/response examples
- README files that actually help people get started
- User guides and tutorials with step-by-step instructions
- Deployment and operations guides
- Changelogs and release notes
- Architecture and design documentation

YOUR TASK EXECUTION PROCESS — THE LOOP:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. THINK — who is the audience? What do they need to know? What's the right format?
4. RESEARCH — read the code, specs, existing docs. Understand what you're documenting before writing a word.
5. WRITE — produce the documentation using file tools. Clear structure, working examples, no filler.
6. SELF-REVIEW — read the document back. Is it clear? Are examples correct? Could someone follow it with zero prior context?
7. REPEAT steps 4-6 until the documentation is genuinely helpful and complete.
8. Only THEN: update_my_task(task_id=..., status='completed', result='...')

The loop is: Think → Research → Write → Review → Ship.
You do NOT exit this loop early. You do NOT ship docs you haven't read back.

AGENTIC EXECUTION — THIS IS THE MOST IMPORTANT RULE:
You run in TOOL-ONLY mode during task execution. This means:
- Every response MUST call at least one tool. NEVER produce a plain text response mid-task.
- Do NOT say "I'll now do X" or "Let me write Y" — just DO it. Call the tool immediately.
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
  agents/${AGENT_ID}/  ← YOUR private space (drafts, outlines, notes)
  shared/             ← Cross-agent deliverables (published docs, guides)
  projects/           ← Standalone software projects that need documentation

RULES:
- Save YOUR OWN drafts, outlines, notes to: agents/${AGENT_ID}/
- Save DELIVERABLES meant for other agents, users, or the PM to: shared/
  Examples: api-reference.md, user-guide.md, deployment-guide.md, changelog.md, README.md
- For PROJECT-SPECIFIC DOCS (README, API docs for a specific project):
  Save inside the project: projects/{project-name}/README.md, projects/{project-name}/docs/
- To read Dev's code, BA's specs, or other agents' outputs, check: shared/ and projects/
- To see files you've created: ls agents/${AGENT_ID}/ or find agents/${AGENT_ID}/
- Use ls, find, grep to explore before writing

BASH RULES:
- NEVER run long-running server processes: npm run dev, npm start, python -m http.server, vite, nodemon, etc.
  These commands block forever and will hang the tool indefinitely.
- Use bash only for quick, non-interactive operations: checking file existence, running verification scripts.
- If a bash command fails, read the error output and adapt. Do not retry the exact same command blindly.

FILE EDITING RULES:
- To edit a file, ALWAYS call read first to see the current content.
- When making multiple edits to the same file, call read again after each successful edit.
- Never chain multiple edit calls using old_text from a single read.
- If edit fails with "Could not find exact text", call read to get the current state and retry.

YOU ARE AN AI AGENT — NOT A HUMAN TECHNICAL WRITER:
- You do not work in sprints. You do not have a next week. You start a task and finish it in this session.
- A user guide that would take a human writer a week of interviews and drafts — you write it now, completely, in one go.
- Do NOT write "TBD" or "section to be added later." Produce the final thing.
- Do NOT leave sections half-written planning to "come back to them." Finish every section before you ship.
- If something genuinely requires information you don't have (e.g., API endpoints not yet built), flag it clearly — don't guess, don't leave a placeholder.

THINKING & EXECUTION — NON-NEGOTIABLE:
- Break down EVERY task before writing a single word. Think first. Who is the audience? What's the structure?
- Do not rush to finish. Poorly written documentation is worse than no documentation — it misleads and wastes people's time.

THE DOCUMENTATION MANDATE — THIS IS THE MOST IMPORTANT RULE AFTER AGENTIC EXECUTION:
After writing any document, READ IT BACK using the read tool. Then ask yourself:
  1. Is the structure clear? Can someone scan headings and find what they need?
  2. Are all examples correct and complete? Could someone copy-paste and run them?
  3. Could a new team member or external user follow this RIGHT NOW with no prior context? If not, it's not done.
  4. Are there any gaps, broken references, or inconsistencies with the actual code?
If ANY of these fail — go back, fix the document, read it again. Ship only when the answer is yes to all four.

COMPLETION QUALITY BAR:
- Before marking any task complete: read the saved file with the read tool. Confirm the write actually succeeded and the content is what you intended.
- Your completion result MUST state: what was documented, where it's saved, and a one-sentence summary.
  Bad result: "Wrote the docs."
  Good result: "API reference saved to shared/api-reference.md. Covers 8 endpoints with curl examples, request/response schemas, and error codes. README saved to projects/my-app/README.md with quickstart guide."

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

export class TechWriterAgent implements VECAgent {
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
      ...sandboxFileTools(AGENT_ID, getCodingTools()),
      ...sandboxFileTools(AGENT_ID, getReadOnlyTools().filter((t: any) => t.name !== "read")),
      ...getMessagingTools(AGENT_ID, this.inbox).filter((t) => t.name !== "broadcast_message"),
      getDateTool(),
      ...getWebTools(),
    ];

    this.agent = new Agent({
      initialState: {
        systemPrompt: TECHWRITER_SYSTEM_PROMPT,
        model: getModel(config.modelProvider as any, config.model as any),
        thinkingLevel: config.thinkingLevel,
        tools: this._filteredTools(),
        messages: [],
      },
      transformContext: makeCompactionTransform(100),
      getApiKey: codexApiKeyResolver(),
    });

    this.compactor = new AutoCompactor(this.agent, {
      agentId: AGENT_ID,
      enablePreFlush: false,
    });

    const savedHistory = loadAgentHistory(AGENT_ID);
    if (savedHistory.length > 0) {
      this.agent.replaceMessages(savedHistory);
    }

    this.agent.subscribe((event: AgentEvent) => {
      publishAgentStream(AGENT_ID, event);
      if (event.type === "tool_execution_start") {
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `TechWriter calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `TechWriter tool error in ${event.toolName}`);
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
    const debug = startPromptDebugMonitor(this.agent, AGENT_ID, "TechWriter", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "TechWriter LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "TechWriter LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      if (!String(err).includes("already processing")) {
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, "", `TechWriter Agent prompt error: ${err}`);
      }
      throw err;
    }
  }

  async executeTask(taskId: string): Promise<void> {
    if (this._isRunning) {
      console.warn(`[TechWriterAgent] executeTask called while already running — skipping ${taskId}`);
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
      console.error(`[TechWriterAgent] Task ${normalizedId} not found.`);
      return;
    }
    if (task.agent_id !== AGENT_ID) {
      console.error(`[TechWriterAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not techwriter.`);
      return;
    }

    this.agent.setTools(this._filteredTools());

    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, AGENT_ID, normalizedId, `TechWriter started executing ${normalizedId}`);

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
      `- THINK: who is the audience? What format and structure works best?\n` +
      `- RESEARCH: read code, specs, existing docs — understand what you're documenting\n` +
      `- WRITE: produce the documentation — clear structure, working examples, no filler\n` +
      `- REVIEW: read the document back — is it clear, complete, and accurate?\n` +
      `- ONLY THEN: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
      `  Your result MUST include: what was documented + where it's saved + summary of content` +
      interruptBlock;

    const MAX_CONTINUATIONS = 3;
    try {
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

      for (let attempt = 1; attempt <= MAX_CONTINUATIONS; attempt++) {
        const latest = db.getTask(normalizedId);
        if (!latest || latest.status !== "in_progress") break;

        EventLog.log(
          EventType.AGENT_THINKING, AGENT_ID, normalizedId,
          `TechWriter stopped without closing ${normalizedId} — continuing (attempt ${attempt}/${MAX_CONTINUATIONS})`
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

      const final = db.getTask(normalizedId);
      if (final?.status === "in_progress") {
        const fallbackMsg = "TechWriter did not complete the task after multiple prompts — marking failed for retry.";
        db.updateTaskStatus(normalizedId, "failed", fallbackMsg);
        pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${fallbackMsg}`, "error");
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `TechWriter gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `TechWriter runtime error: ${errMsg}`);
      pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${errMsg}`, "error");
      EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `TechWriter crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
