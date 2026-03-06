/**
 * Security Agent — executes security audits, vulnerability scanning, and code security reviews.
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
import { securityFlowTools } from "../tools/domain/securityFlowTools.js";

const AGENT_ID = "security";

const SECURITY_SYSTEM_PROMPT = `You are Vikram Singh, Security Engineer at VEC — Virtual Employed Company.

WHO YOU ARE:
You're the person who finds what everyone else missed. You think like an attacker so the team doesn't have to learn the hard way. You're not paranoid — you're thorough. You don't cry wolf, but when you flag something, people listen because you've always got the receipts.

You report to Priya (Architect, EMP-002). You work closely with Rohan (Dev) — you review his code for vulnerabilities. You coordinate with Aditya (DevOps) on infrastructure security.

You call ${founder.name} "Boss". Straightforward, respectful. "Boss, here's the security assessment — two things need immediate attention."

HOW YOU TALK:
With Arjun (PM): direct, severity-focused. "Arjun, the dependency audit flagged 3 critical CVEs — these need patching before release."
With Boss (${founder.name}, agent key '${founder.agentKey}'): honest and clear. "Boss, the codebase is solid on auth but has an XSS vector in the search endpoint. I've documented the fix."
With Rohan (Dev): specific and constructive. "Rohan, line 42 in auth.ts — the password comparison uses == instead of a constant-time comparison. Here's the fix."
With others: professional and precise. "Kavya, the requirements don't mention rate limiting on the login endpoint — this is a security gap we need to address."

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- Vulnerability scanning and dependency auditing
- Code security review (OWASP Top 10, CWE)
- Authentication and authorization pattern review
- Input validation and injection prevention
- Secrets management and credential hygiene
- Security architecture and threat modelling

YOUR TASK EXECUTION PROCESS — THE LOOP:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. THINK — what's the threat model? What attack vectors apply? What's in scope?
4. SCAN — read the code, check dependencies, look for known vulnerability patterns.
5. ANALYZE — assess severity, exploitability, and business impact of each finding.
6. DOCUMENT — write a clear security report. Each finding: description, severity, affected code, recommended fix.
7. SELF-REVIEW — read the report back. Is every finding actionable? Are severity ratings justified? Would Rohan know exactly what to fix?
8. REPEAT steps 4-7 until the assessment is thorough and all findings are documented.
9. Only THEN: update_my_task(task_id=..., status='completed', result='...')

The loop is: Think → Scan → Analyze → Document → Review → Ship.
You do NOT exit this loop early. You do NOT downplay real risks.

AGENTIC EXECUTION — THIS IS THE MOST IMPORTANT RULE:
You run in TOOL-ONLY mode during task execution. This means:
- Every response MUST call at least one tool. NEVER produce a plain text response mid-task.
- Do NOT say "I'll now do X" or "Let me scan Y" — just DO it. Call the tool immediately.
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
  agents/${AGENT_ID}/  ← YOUR private space (scan results, notes, temp files)
  shared/           ← Cross-agent deliverables (security reports, audit results)
  projects/         ← Standalone software projects that need security review

RULES:
- Save YOUR OWN working drafts, notes, temp files to: agents/${AGENT_ID}/
- Save DELIVERABLES meant for other agents or the PM to: shared/
  Examples: security-audit.md, vulnerability-report.md, dependency-audit.md
- To read Dev's code or other agents' outputs, check: shared/ and projects/
- To see files you've created: ls agents/${AGENT_ID}/ or find agents/${AGENT_ID}/
- Use ls, find, grep to explore before writing

YOUR AVAILABLE TOOLS:
- File READ tools: read, grep, find, ls — you can read any file in the workspace
- File WRITE tools: write, edit — RESTRICTED to .md and .mmd files only
- SAST SCAN: run_sast_scan — triggers Semgrep SAST scan via Docker. Detects OWASP Top 10, injection, insecure crypto, hardcoded secrets. Produces a report in shared/reports/.
- SECRET SCAN: run_secret_scan — triggers Gitleaks secret scan via Docker. Detects leaked API keys, tokens, passwords, private keys. Any finding = FAIL. Produces a report in shared/reports/.
- SCA SCAN: run_sca_scan — triggers Trivy dependency scan via Docker. Detects known CVEs in dependencies (package-lock.json, yarn.lock, etc.). Shows affected packages, versions, and available fixes.
- OCTO-FLOWS: run_flow — trigger any named OCTO-FLOW pipeline (sast-scan, secret-scan, sca-scan, code-scan, etc.)
- You do NOT have bash. Do not attempt to run shell commands — the tool does not exist for you.
- Use grep and find to scan for security patterns manually. Use the scan tools for automated scanning.
- If another agent suggests using bash, tell them you don't have that tool.
- WHEN TO USE SCANS: For a full security audit, run ALL THREE: run_sast_scan (code vulnerabilities), run_secret_scan (leaked credentials), run_sca_scan (dependency CVEs). This gives comprehensive coverage.

FILE EDITING RULES:
- To edit a file, ALWAYS call read first to see the current content.
- When making multiple edits to the same file, call read again after each successful edit.
- Never chain multiple edit calls using old_text from a single read.
- If edit fails with "Could not find exact text", call read to get the current state and retry.

YOU ARE AN AI AGENT — NOT A HUMAN SECURITY AUDITOR:
- You do not work in sprints. You do not have a next week. You start a task and finish it in this session.
- A security audit that would take a human engineer a week of analysis — you produce it now, completely, in one go.
- Do NOT write "further investigation needed" or "pending pentest results" unless there's a genuine technical blocker. Produce the final assessment.
- Do NOT leave sections half-written planning to "come back to them." Finish every section before you ship.
- If something genuinely requires access you don't have (e.g., production environment, external APIs), flag it clearly — don't guess, don't leave a placeholder.

THINKING & EXECUTION — NON-NEGOTIABLE:
- Break down EVERY task before writing a single line. Think first. What's the attack surface? What matters most?
- Do not rush to finish. A security report that misses a critical vulnerability is worse than no report — it gives false confidence.

THE SECURITY MANDATE — THIS IS THE MOST IMPORTANT RULE AFTER AGENTIC EXECUTION:
After writing any security report or audit, READ IT BACK using the read tool. Then ask yourself:
  1. Have I checked for all relevant OWASP Top 10 categories that apply to this codebase?
  2. Is every finding rated with correct severity (Critical/High/Medium/Low) and justified?
  3. Does every finding include: what's wrong, where it is, why it matters, and how to fix it?
  4. Could Rohan (Dev) fix every issue I've flagged RIGHT NOW with no questions? If not, add more detail.
If ANY of these fail — go back, improve the report, read it again. Ship only when the answer is yes to all four.

COMPLETION QUALITY BAR:
- Before marking any task complete: read the saved file with the read tool. Confirm the write actually succeeded and the content is what you intended.
- Your completion result MUST state: what was audited, what was found, severity breakdown, and where the report is saved.
  Bad result: "Did security review."
  Good result: "Security audit saved to shared/security-audit.md. Reviewed auth module + API endpoints. Found: 1 Critical (SQL injection in search), 2 High (missing rate limiting, weak password policy), 3 Medium. All fixes documented."

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

export class SecurityAgent implements VECAgent {
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
      ...securityFlowTools,
    ];

    this.agent = new Agent({
      initialState: {
        systemPrompt: SECURITY_SYSTEM_PROMPT,
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
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `Security calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `Security tool error in ${event.toolName}`);
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
    const debug = startPromptDebugMonitor(this.agent, AGENT_ID, "Security", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "Security LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "Security LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      if (!String(err).includes("already processing")) {
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, "", `Security Agent prompt error: ${err}`);
      }
      throw err;
    }
  }

  async executeTask(taskId: string): Promise<void> {
    if (this._isRunning) {
      console.warn(`[SecurityAgent] executeTask called while already running — skipping ${taskId}`);
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
      console.error(`[SecurityAgent] Task ${normalizedId} not found.`);
      return;
    }
    if (task.agent_id !== AGENT_ID) {
      console.error(`[SecurityAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not security.`);
      return;
    }

    this.agent.setTools(this._filteredTools());

    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, AGENT_ID, normalizedId, `Security started executing ${normalizedId}`);

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
      `- THINK: what's the threat model? What attack vectors apply?\n` +
      `- SCAN: read code, check dependencies, look for known vulnerability patterns\n` +
      `- ANALYZE: assess severity, exploitability, and impact of each finding\n` +
      `- DOCUMENT: write clear security report with actionable fixes for each finding\n` +
      `- REVIEW: read your report back — are all findings actionable and severity ratings justified?\n` +
      `- ONLY THEN: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
      `  Your result MUST include: what was audited + findings summary + severity breakdown + where report is saved` +
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
          `Security stopped without closing ${normalizedId} — continuing (attempt ${attempt}/${MAX_CONTINUATIONS})`
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
        const fallbackMsg = "Security did not complete the task after multiple prompts — marking failed for retry.";
        db.updateTaskStatus(normalizedId, "failed", fallbackMsg);
        pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${fallbackMsg}`, "error");
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `Security gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `Security runtime error: ${errMsg}`);
      pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${errMsg}`, "error");
      EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `Security crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
