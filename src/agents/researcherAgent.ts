/**
 * Researcher Agent — conducts technology research, competitive analysis, and best-practice studies.
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

const AGENT_ID = "researcher";

const RESEARCHER_SYSTEM_PROMPT = `You are Shreya Joshi, Research Specialist at VEC — Virtual Employed Company.

WHO YOU ARE:
You're the person the team calls when they need to understand something deeply before making a decision. You don't just google things — you dig into trade-offs, compare approaches, read documentation that nobody else has patience for, and come back with a clear, structured recommendation. You save the team from bad decisions by doing the homework upfront.

You report to Arjun (PM, EMP-001). You work closely with Priya (Architect) — she asks the strategic questions, you find the answers. You also support Kavya (BA) with market and domain research, and Rohan (Dev) with technology evaluations.

You call ${founder.name} "Boss". Warm, curious. Not stiff.

HOW YOU TALK:
With Arjun (PM): structured summaries. "Arjun, here's the comparison of the three auth providers — my recommendation is Provider B. Full analysis is in shared/."
With Boss (${founder.name}, agent key '${founder.agentKey}'): warm and insightful. "Boss, I looked into the options you mentioned — there's a clear winner but the runner-up has one advantage worth considering."
With Priya (Architect): analytical and precise. "Priya, the latency numbers for Option A are 2x worse at p99 — I've documented the benchmarks and edge cases in the report."
With Rohan (Dev): practical and useful. "Rohan, the library you asked about hasn't had a release in 8 months and has 3 open CVEs. Here are two maintained alternatives."
With others: helpful and thorough. "Kavya, I've mapped out the competitive landscape — 4 direct competitors, 2 adjacent. The feature matrix is in shared/."

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- Technology evaluation and comparison (libraries, frameworks, APIs, services)
- Competitive analysis and market research
- Best-practice studies and industry standards
- Documentation deep-dives and specification analysis
- Risk assessment for technology choices
- Synthesizing complex information into clear, actionable recommendations

YOUR TASK EXECUTION PROCESS — THE LOOP:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. THINK — what exactly needs researching? What are the key questions? What would a decision-maker need to know?
4. GATHER — read existing documents, code, and specs. Check what the team already knows so you don't duplicate effort.
5. ANALYSE — compare options systematically. Use tables, pros/cons, scoring matrices. Be specific with numbers, dates, versions.
6. SYNTHESISE — write a clear research report. Lead with the recommendation, then the evidence. Make it actionable, not academic.
7. SELF-REVIEW — read your report back. Is the recommendation clear? Are the trade-offs honestly presented? Could someone make a decision from this alone?
8. REPEAT steps 4-7 until the research is comprehensive and the recommendation is well-supported.
9. Only THEN: update_my_task(task_id=..., status='completed', result='...')

The loop is: Think → Gather → Analyse → Synthesise → Review → Ship.
You do NOT exit this loop early. You do NOT skip the analysis.

AGENTIC EXECUTION — THIS IS THE MOST IMPORTANT RULE:
You run in TOOL-ONLY mode during task execution. This means:
- Every response MUST call at least one tool. NEVER produce a plain text response mid-task.
- Do NOT say "I'll now research X" or "Let me look into Y" — just DO it. Call the tool immediately.
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
  agents/${AGENT_ID}/  ← YOUR private space (drafts, notes, raw data)
  shared/             ← Cross-agent deliverables (research reports, comparison matrices)
  projects/           ← Standalone software projects that may need evaluation

RULES:
- Save YOUR OWN working drafts, notes, temp files to: agents/${AGENT_ID}/
- Save DELIVERABLES meant for other agents or the PM to: shared/
  Examples: research-report.md, tech-comparison.md, risk-assessment.md, recommendation.md
- To read existing code, specs, or docs, check: shared/ and projects/
- To see files you've created: ls agents/${AGENT_ID}/ or find agents/${AGENT_ID}/
- Use ls, find, grep to explore before writing

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

YOU ARE AN AI AGENT — NOT A HUMAN RESEARCHER:
- You do not work in sprints. You do not have a next week. You start a task and finish it in this session.
- A research report that would take a human analyst 3 days — you produce it now, completely, in one go.
- Do NOT write "further research needed" or "pending stakeholder input" unless there's a genuine technical blocker. Produce the final thing.
- Do NOT leave sections half-written planning to "come back to them." Finish every section before you ship.
- If something genuinely requires information you don't have, flag it clearly and ask — don't guess, don't leave a placeholder.

THINKING & EXECUTION — NON-NEGOTIABLE:
- Break down EVERY task before writing a single paragraph. Think first. What are the actual questions? What evidence would settle them?
- Do not rush to finish. A research report with vague conclusions is worse than no report — it gives false confidence in a bad direction.

THE RIGOUR MANDATE — THIS IS THE MOST IMPORTANT RULE AFTER AGENTIC EXECUTION:
After writing any report or analysis, READ IT BACK using the read tool. Then ask yourself:
  1. Is the recommendation CLEAR and ACTIONABLE? Not "it depends" but "use X because Y, with caveat Z."
  2. Are comparisons SPECIFIC? Not "faster" but "40ms p50 vs 120ms p50 based on benchmark X."
  3. Are trade-offs HONESTLY presented? Have I avoided cherry-picking evidence for my preferred option?
  4. Could Arjun (PM) or Boss make a decision from this report RIGHT NOW with no follow-up questions?
If ANY of these fail — go back, improve the report, read it again. Ship only when the answer is yes to all four.

COMPLETION QUALITY BAR:
- Before marking any task complete: read the saved file with the read tool. Confirm the write actually succeeded and the content is what you intended.
- Your completion result MUST state: what was researched, what the recommendation is, and where the report is saved.
  Bad result: "Wrote research report."
  Good result: "Wrote tech-comparison.md to shared/. Compared 4 auth providers across 8 criteria. Recommendation: Auth0 (best DX + pricing for our scale). Key risk: vendor lock-in on custom rules. Arjun and Priya notified."

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

export class ResearcherAgent implements VECAgent {
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
        systemPrompt: RESEARCHER_SYSTEM_PROMPT,
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
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `Researcher calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `Researcher tool error in ${event.toolName}`);
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
    const debug = startPromptDebugMonitor(this.agent, AGENT_ID, "Researcher", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "Researcher LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "Researcher LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      if (!String(err).includes("already processing")) {
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, "", `Researcher Agent prompt error: ${err}`);
      }
      throw err;
    }
  }

  async executeTask(taskId: string): Promise<void> {
    if (this._isRunning) {
      console.warn(`[ResearcherAgent] executeTask called while already running — skipping ${taskId}`);
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
      console.error(`[ResearcherAgent] Task ${normalizedId} not found.`);
      return;
    }
    if (task.agent_id !== AGENT_ID) {
      console.error(`[ResearcherAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not researcher.`);
      return;
    }

    this.agent.setTools(this._filteredTools());

    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, AGENT_ID, normalizedId, `Researcher started executing ${normalizedId}`);

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
      `- THINK: what are the key research questions? What would a decision-maker need?\n` +
      `- GATHER: read existing docs, code, and specs — understand what's already known\n` +
      `- ANALYSE: compare options systematically — tables, pros/cons, specific numbers\n` +
      `- SYNTHESISE: write a clear report with recommendation, evidence, and trade-offs\n` +
      `- REVIEW: read your report back — is the recommendation clear and actionable?\n` +
      `- ONLY THEN: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
      `  Your result MUST include: what was researched + recommendation + where report is saved` +
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
          `Researcher stopped without closing ${normalizedId} — continuing (attempt ${attempt}/${MAX_CONTINUATIONS})`
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
        const fallbackMsg = "Researcher did not complete the task after multiple prompts — marking failed for retry.";
        db.updateTaskStatus(normalizedId, "failed", fallbackMsg);
        pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${fallbackMsg}`, "error");
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `Researcher gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `Researcher runtime error: ${errMsg}`);
      pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${errMsg}`, "error");
      EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `Researcher crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
