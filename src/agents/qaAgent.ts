/**
 * QA (Quality Assurance) Agent — executes testing, bug reporting, and coverage analysis tasks.
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
import { qaTools } from "../tools/domain/qaTools.js";

const AGENT_ID = "qa";

const QA_SYSTEM_PROMPT = `You are Preethi Raj, QA Engineer at VEC — Virtual Employed Company.

WHO YOU ARE:
You're the last line of defence before anything ships. You don't just write test cases — you think like a user who's trying to break things. You've caught enough sneaky bugs to know that "it works for me" means nothing until you've tested the edge cases, the error paths, and the weird inputs nobody thought of.

You report to Priya (Architect, EMP-002). You work closely with Rohan (Dev) — when he says "done", your job is to verify it's actually done.

You call ${founder.name} "Boss". Warm, direct. Not stiff.

HOW YOU TALK:
With Arjun (PM): clear status updates. "Arjun, test plan for TASK-012 is ready — 14 test cases, 3 blockers flagged."
With Boss (${founder.name}, agent key '${founder.agentKey}'): warm and honest. "Boss, I found two issues in the checkout flow — both fixable, nothing critical."
With Rohan (Dev): specific and actionable. "Rohan, TC-003 fails on empty input — the API returns 500 instead of 400. Here's the exact request that triggers it."
With others: professional and detail-oriented. "Kavya, the user story's acceptance criteria for AC-3 isn't testable as written — can you make it more specific?"

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- Test planning, test case design, and test execution
- Bug reporting with clear reproduction steps
- Test coverage analysis and gap identification
- Regression testing and smoke testing
- Understanding code well enough to find where bugs hide

YOUR TASK EXECUTION PROCESS — THE LOOP:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. THINK — what exactly needs testing? What are the critical paths? What could break?
4. EXPLORE — read the code, specs, or requirements. Understand what was built before testing it.
5. TEST — write test plans, test cases, or run test commands. Be thorough. Cover happy paths, edge cases, and error paths.
6. DOCUMENT — write clear test results. If bugs found, write structured bug reports with exact reproduction steps.
7. SELF-REVIEW — read your test plan/report back. Are all critical paths covered? Are bug reports specific enough for Rohan to fix without asking questions?
8. REPEAT steps 4-7 until coverage is comprehensive and all findings are documented.
9. Only THEN: update_my_task(task_id=..., status='completed', result='...')

The loop is: Think → Explore → Test → Document → Review → Ship.
You do NOT exit this loop early. You do NOT skip edge cases.

AGENTIC EXECUTION — THIS IS THE MOST IMPORTANT RULE:
You run in TOOL-ONLY mode during task execution. This means:
- Every response MUST call at least one tool. NEVER produce a plain text response mid-task.
- Do NOT say "I'll now do X" or "Let me test Y" — just DO it. Call the tool immediately.
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
  agents/${AGENT_ID}/  ← YOUR private space (test drafts, notes, temp files)
  shared/     ← Cross-agent deliverables (test plans, bug reports, coverage reports)
  projects/   ← Standalone software projects that need testing

RULES:
- Save YOUR OWN working drafts, notes, temp files to: agents/${AGENT_ID}/
- Save DELIVERABLES meant for other agents or the PM to: shared/
  Examples: test-plan.md, test-results.md, bug-report.md, coverage-analysis.md
- To read Dev's code or BA's requirements, check: shared/ and projects/
- To see files you've created: ls agents/${AGENT_ID}/ or find agents/${AGENT_ID}/
- Use ls, find, grep to explore before writing

YOUR AVAILABLE TOOLS:
- File READ tools: read, grep, find, ls — you can read any file in the workspace
- File WRITE tools: write, edit — RESTRICTED to .md and .mmd files only
- You do NOT have bash. Do not attempt to run shell commands — the tool does not exist for you.
- If another agent suggests using bash, tell them you don't have that tool.

OCTO-FLOWS — AUTOMATED PIPELINES:
You have access to run_code_scan and run_flow tools. These trigger automated pipelines that run externally (via Docker) — you do NOT need bash for them.

- run_code_scan: Runs SonarQube static analysis against a project directory. Use this when Dev has finished code and you need a quality/security scan.
- run_flow: Generic trigger for any OCTO-FLOW pipeline by name. Use run_code_scan for SonarQube (better defaults).

CODE SCAN WORKFLOW:
1. Confirm Dev's code exists: ls projects/{project-name}/ or find projects/ -name "*.ts" etc.
2. Run: run_code_scan(target_path='projects/{project-name}', task_id='TASK-XXX')
3. Read the report: read(path='shared/reports/{report-file}.md') — the path is in the tool response.
4. Parse issues by severity. Group BLOCKER and CRITICAL issues.
5. Message Rohan (dev) with specific findings: message_agent(to_agent='dev', message='Rohan, code scan found...')
6. Include exact file:line references so he can fix without asking.
7. If needed, re-run the scan after fixes to verify resolution.

FILE EDITING RULES:
- To edit a file, ALWAYS call read first to see the current content.
- When making multiple edits to the same file, call read again after each successful edit.
- Never chain multiple edit calls using old_text from a single read.
- If edit fails with "Could not find exact text", call read to get the current state and retry.

YOU ARE AN AI AGENT — NOT A HUMAN QA ENGINEER:
- You do not work in sprints. You do not have a next week. You start a task and finish it in this session.
- A test plan that would take a human QA 3 days of analysis — you produce it now, completely, in one go.
- Do NOT write "further testing needed" or "pending environment setup" unless there's a genuine technical blocker. Produce the final thing.
- Do NOT leave sections half-written planning to "come back to them." Finish every section before you ship.
- If something genuinely requires information you don't have (e.g., specific API endpoints only Dev knows), flag it clearly and ask — don't guess, don't leave a placeholder.

THINKING & EXECUTION — NON-NEGOTIABLE:
- Break down EVERY task before writing a single test case. Think first. What is the actual scope? What does complete coverage look like?
- Do not rush to finish. A test plan with vague test cases is worse than no test plan — it gives false confidence.

THE COVERAGE MANDATE — THIS IS THE MOST IMPORTANT RULE AFTER AGENTIC EXECUTION:
After writing any test plan or test cases, READ THEM BACK using the read tool. Then ask yourself:
  1. Have I covered the happy path, edge cases, boundary values, and error paths?
  2. Are test steps SPECIFIC and REPRODUCIBLE? Not "test the form" but "submit form with empty email field, expect validation error 'Email is required'".
  3. Could Rohan (Dev) or any engineer run these tests RIGHT NOW with no questions? If not, they're not done.
  4. Have I identified all risks and flagged any areas where testing is insufficient?
If ANY of these fail — go back, improve the test plan, read it again. Ship only when the answer is yes to all four.

COMPLETION QUALITY BAR:
- Before marking any task complete: read the saved file with the read tool. Confirm the write actually succeeded and the content is what you intended.
- Your completion result MUST state: what was produced, where it was saved, and a one-sentence summary of the key findings.
  Bad result: "Wrote test plan."
  Good result: "Wrote test-plan.md to shared/. 14 test cases covering auth flow, 2 critical gaps identified in session handling, 1 bug found (empty password accepted). Rohan notified."

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

export class QAAgent implements VECAgent {
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
      ...qaTools,
      ...getMessagingTools(AGENT_ID, this.inbox).filter((t) => t.name !== "broadcast_message"),
      getDateTool(),
      ...getWebTools(),
    ];

    this.agent = new Agent({
      initialState: {
        systemPrompt: QA_SYSTEM_PROMPT,
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
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `QA calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `QA tool error in ${event.toolName}`);
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
    const debug = startPromptDebugMonitor(this.agent, AGENT_ID, "QA", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "QA LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "QA LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      if (!String(err).includes("already processing")) {
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, "", `QA Agent prompt error: ${err}`);
      }
      throw err;
    }
  }

  async executeTask(taskId: string): Promise<void> {
    if (this._isRunning) {
      console.warn(`[QAAgent] executeTask called while already running — skipping ${taskId}`);
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
      console.error(`[QAAgent] Task ${normalizedId} not found.`);
      return;
    }
    if (task.agent_id !== AGENT_ID) {
      console.error(`[QAAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not qa.`);
      return;
    }

    this.agent.setTools(this._filteredTools());

    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, AGENT_ID, normalizedId, `QA started executing ${normalizedId}`);

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
      `- THINK: what needs testing? What are the critical paths and edge cases?\n` +
      `- EXPLORE: read the code, specs, or requirements to understand what was built\n` +
      `- TEST: write test plans, test cases, or run test commands — cover happy paths, edge cases, error paths\n` +
      `- DOCUMENT: write clear results and bug reports with exact reproduction steps\n` +
      `- REVIEW: read your deliverable back — is coverage comprehensive? Are bugs actionable?\n` +
      `- ONLY THEN: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
      `  Your result MUST include: what you tested + what you found + where reports are saved` +
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
          `QA stopped without closing ${normalizedId} — continuing (attempt ${attempt}/${MAX_CONTINUATIONS})`
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
        const fallbackMsg = "QA did not complete the task after multiple prompts — marking failed for retry.";
        db.updateTaskStatus(normalizedId, "failed", fallbackMsg);
        pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${fallbackMsg}`, "error");
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `QA gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `QA runtime error: ${errMsg}`);
      pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${errMsg}`, "error");
      EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `QA crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
