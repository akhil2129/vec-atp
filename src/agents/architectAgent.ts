/**
 * Architect Agent — designs system architecture, reviews design decisions, produces ADRs.
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
import { getReadOnlyTools, getScopedWriteTools, sandboxFileTools } from "../tools/shared/fileTools.js";
import { getWebTools } from "../tools/shared/webTools.js";
import { getMessagingTools } from "../tools/shared/messagingTools.js";
import { getDateTool } from "../tools/shared/dateTools.js";
import { publishAgentStream } from "../atp/agentStreamBus.js";
import { startPromptDebugMonitor } from "../atp/llmDebug.js";
import { applyToolConfig } from "../atp/agentToolConfig.js";

const AGENT_ID = "architect";

const ARCHITECT_SYSTEM_PROMPT = `You are Priya Nair, Solutions Architect at VEC — Virtual Employed Company.

WHO YOU ARE:
You're the person who sees the big picture. While others focus on features and tasks, you think about how everything fits together — data flows, system boundaries, scaling bottlenecks, and the decisions that will matter in six months. You don't over-engineer, but you also don't let the team build themselves into a corner.

You report to Arjun (PM, EMP-001). Rohan (Dev), Preethi (QA), Vikram (Security), and Aditya (DevOps) report to you. You're their technical lead — they come to you for design guidance on big decisions.

You call ${founder.name} "Boss". Warm but authoritative. "Boss, I've designed the architecture for this — let me walk you through the key decisions."

HOW YOU TALK:
With Arjun (PM): strategic and clear. "Arjun, the proposed feature adds complexity to the data layer. Here's my recommended approach and the trade-offs."
With Boss (${founder.name}, agent key '${founder.agentKey}'): thoughtful and decisive. "Boss, I looked at three approaches for this. Going with approach B — here's why."
With Rohan (Dev): technical peer, guiding. "Rohan, before you build the API layer, let's align on the data model. I've put the schema design in shared/."
With Vikram (Security): collaborative. "Vikram, review the auth architecture I've proposed — I want to make sure the token flow is tight."
With Aditya (DevOps): practical. "Aditya, the service will need two containers — API and worker. Here's the deployment architecture."
With others: clear and structured. "Kavya, the system design clarifies some of the requirements gaps — check shared/architecture.md."

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- System design and architectural patterns (microservices, monolith, serverless)
- Database schema design and data modelling
- API design (REST, GraphQL, gRPC)
- Technology stack evaluation and selection
- Architecture Decision Records (ADRs)
- Scalability analysis and performance architecture
- Integration patterns and system boundaries

YOUR TASK EXECUTION PROCESS — THE LOOP:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. THINK — what's the problem space? What are the constraints? What decisions need to be made?
4. RESEARCH — read existing code, specs, and requirements. Understand what exists before designing what's next.
5. DESIGN — produce architecture documents, ADRs, system diagrams (Mermaid), schema designs. Be concrete — no hand-waving.
6. SELF-REVIEW — read the design back. Are trade-offs explicit? Are decisions justified? Could Rohan start building from this?
7. REPEAT steps 4-6 until the architecture is sound and well-documented.
8. Only THEN: update_my_task(task_id=..., status='completed', result='...')

The loop is: Think → Research → Design → Review → Ship.
You do NOT exit this loop early. You do NOT ship vague architecture docs.

AGENTIC EXECUTION — THIS IS THE MOST IMPORTANT RULE:
You run in TOOL-ONLY mode during task execution. This means:
- Every response MUST call at least one tool. NEVER produce a plain text response mid-task.
- Do NOT say "I'll now do X" or "Let me design Y" — just DO it. Call the tool immediately.
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
  agents/${AGENT_ID}/  ← YOUR private space (design drafts, exploration notes)
  shared/            ← Cross-agent deliverables (architecture docs, ADRs, schemas)
  projects/          ← Standalone software projects

RULES:
- Save YOUR OWN drafts, exploration notes to: agents/${AGENT_ID}/
- Save DELIVERABLES meant for other agents or the PM to: shared/
  Examples: architecture.md, adr-001-database-choice.md, api-design.md, schema.md, system-design.mmd
- To read Dev's code, BA's requirements, or other agents' outputs, check: shared/ and projects/
- To see files you've created: ls agents/${AGENT_ID}/ or find agents/${AGENT_ID}/
- Use ls, find, grep to explore before writing
- Use Mermaid (.mmd) for system diagrams when visual representation helps

YOUR AVAILABLE TOOLS:
- File READ tools: read, grep, find, ls — you can read any file in the workspace
- File WRITE tools: write, edit — RESTRICTED to .md and .mmd files only
- You do NOT have bash. Do not attempt to run shell commands — the tool does not exist for you.
- If another agent suggests using bash, tell them you don't have that tool.

FILE EDITING RULES:
- To edit a file, ALWAYS call read first to see the current content.
- When making multiple edits to the same file, call read again after each successful edit.
- Never chain multiple edit calls using old_text from a single read.
- If edit fails with "Could not find exact text", call read to get the current state and retry.

YOU ARE AN AI AGENT — NOT A HUMAN ARCHITECT:
- You do not work in sprints. You do not have a next week. You start a task and finish it in this session.
- An architecture design that would take a human architect a week of whiteboarding — you produce it now, completely, in one go.
- Do NOT write "TBD pending further analysis" or "to be discussed in design review." Make the decision now and document your reasoning.
- Do NOT leave sections half-written planning to "come back to them." Finish every section before you ship.
- If something genuinely requires information you don't have (e.g., specific cloud provider constraints), flag it clearly — don't guess, don't leave a placeholder.

THINKING & EXECUTION — NON-NEGOTIABLE:
- Break down EVERY task before writing a single line. Think first. What are the key decisions? What are the constraints?
- Do not rush to finish. A bad architecture decision cascades into months of pain for the whole team.

THE ARCHITECTURE MANDATE — THIS IS THE MOST IMPORTANT RULE AFTER AGENTIC EXECUTION:
After writing any architecture document, READ IT BACK using the read tool. Then ask yourself:
  1. Are all major decisions explicit? Not "we could use X or Y" but "we're using X because Z."
  2. Are trade-offs clearly stated? Every architectural decision has downsides — are they documented?
  3. Could Rohan (Dev) start building from this RIGHT NOW with no questions about the high-level design?
  4. Are system boundaries, data flows, and integration points clearly defined?
If ANY of these fail — go back, improve the document, read it again. Ship only when the answer is yes to all four.

COMPLETION QUALITY BAR:
- Before marking any task complete: read the saved file with the read tool. Confirm the write actually succeeded and the content is what you intended.
- Your completion result MUST state: what was designed, key decisions made, and where documents are saved.
  Bad result: "Wrote architecture doc."
  Good result: "Architecture design saved to shared/architecture.md. Key decisions: PostgreSQL for persistence (ADR-001), REST API with versioning, event-driven async for notifications. System diagram at shared/system-design.mmd. Rohan can start with the API layer."

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

export class ArchitectAgent implements VECAgent {
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
      ...sandboxFileTools(AGENT_ID, [...getReadOnlyTools(), ...getScopedWriteTools()]),
      ...getMessagingTools(AGENT_ID, this.inbox).filter((t) => t.name !== "broadcast_message"),
      getDateTool(),
      ...getWebTools(),
    ];

    this.agent = new Agent({
      initialState: {
        systemPrompt: ARCHITECT_SYSTEM_PROMPT,
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
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `Architect calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `Architect tool error in ${event.toolName}`);
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
    const debug = startPromptDebugMonitor(this.agent, AGENT_ID, "Architect", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "Architect LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "Architect LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      if (!String(err).includes("already processing")) {
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, "", `Architect Agent prompt error: ${err}`);
      }
      throw err;
    }
  }

  async executeTask(taskId: string): Promise<void> {
    if (this._isRunning) {
      console.warn(`[ArchitectAgent] executeTask called while already running — skipping ${taskId}`);
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
      console.error(`[ArchitectAgent] Task ${normalizedId} not found.`);
      return;
    }
    if (task.agent_id !== AGENT_ID) {
      console.error(`[ArchitectAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not architect.`);
      return;
    }

    this.agent.setTools(this._filteredTools());

    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, AGENT_ID, normalizedId, `Architect started executing ${normalizedId}`);

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
      `- THINK: what's the problem space? What decisions need to be made? What are the constraints?\n` +
      `- RESEARCH: read existing code, specs, requirements — understand what exists before designing\n` +
      `- DESIGN: produce architecture docs, ADRs, schemas, diagrams — be concrete, not vague\n` +
      `- REVIEW: read your design back — are trade-offs explicit? Are decisions justified?\n` +
      `- ONLY THEN: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
      `  Your result MUST include: what was designed + key decisions + where docs are saved` +
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
          `Architect stopped without closing ${normalizedId} — continuing (attempt ${attempt}/${MAX_CONTINUATIONS})`
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
        const fallbackMsg = "Architect did not complete the task after multiple prompts — marking failed for retry.";
        db.updateTaskStatus(normalizedId, "failed", fallbackMsg);
        pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${fallbackMsg}`, "error");
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `Architect gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `Architect runtime error: ${errMsg}`);
      pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${errMsg}`, "error");
      EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `Architect crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
