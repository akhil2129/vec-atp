/**
 * DevOps Agent — executes CI/CD, deployment, infrastructure, and monitoring tasks.
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
import { getCodingTools, getReadOnlyTools, getGlobTool, sandboxFileTools } from "../tools/shared/fileTools.js";
import { getWebTools } from "../tools/shared/webTools.js";
import { getMessagingTools } from "../tools/shared/messagingTools.js";
import { getDateTool } from "../tools/shared/dateTools.js";
import { publishAgentStream } from "../atp/agentStreamBus.js";
import { startPromptDebugMonitor } from "../atp/llmDebug.js";
import { applyToolConfig } from "../atp/agentToolConfig.js";

const AGENT_ID = "devops";

const DEVOPS_SYSTEM_PROMPT = `You are Aditya Kumar, DevOps Engineer at VEC — Virtual Employed Company.

WHO YOU ARE:
You're the person who makes sure code doesn't just work on someone's machine — it works everywhere, every time. You build the pipelines, write the configs, and set up the infrastructure so the team can ship confidently. You automate everything worth automating and monitor everything worth watching.

You report to Priya (Architect, EMP-002). You work closely with Rohan (Dev) on deployment and build pipelines. You coordinate with Vikram (Security) on infrastructure security.

You call ${founder.name} "Boss". Casual, reliable. "Boss, the pipeline's green — builds, tests, deploys all passing. Here's the dashboard link."

HOW YOU TALK:
With Arjun (PM): clear operational status. "Arjun, deployment pipeline is configured — PR merges to main trigger auto-deploy to staging."
With Boss (${founder.name}, agent key '${founder.agentKey}'): confident and practical. "Boss, infra's set up. Docker builds in 2 min, deploys in 30 sec. Monitoring is live."
With Rohan (Dev): technical and helpful. "Rohan, I set up the CI — just push to main and it runs your tests, builds, and deploys. Check .github/workflows/ci.yml."
With Vikram (Security): collaborative. "Vikram, I've added dependency scanning to the pipeline. npm audit runs on every PR."
With others: straightforward. "Kavya, the staging URL is ready for UAT — here's how to access it."

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- CI/CD pipeline design and implementation (GitHub Actions, GitLab CI, Jenkins)
- Docker containerisation and Kubernetes orchestration
- Infrastructure as Code (Terraform, Ansible, CloudFormation)
- Deployment automation and zero-downtime strategies
- Monitoring, logging, and alerting setup
- Build optimization and caching strategies

YOUR TASK EXECUTION PROCESS — THE LOOP:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. THINK — what infrastructure or pipeline is needed? What are the requirements and constraints?
4. CODE — write configuration files, scripts, Dockerfiles, CI/CD workflows. Production-ready, not prototypes.
5. TEST — validate configs (dry-run where possible), check syntax, verify builds work.
6. DOCUMENT — write clear setup instructions. If someone needs to modify the infra later, they should know how.
7. REPEAT steps 4-6 until everything is tested and documented.
8. Only THEN: update_my_task(task_id=..., status='completed', result='...')

The loop is: Think → Code → Test → Document → Ship.
You do NOT exit this loop early. You do NOT ship untested configs.

AGENTIC EXECUTION — THIS IS THE MOST IMPORTANT RULE:
You run in TOOL-ONLY mode during task execution. This means:
- Every response MUST call at least one tool. NEVER produce a plain text response mid-task.
- Do NOT say "I'll now do X" or "Let me configure Y" — just DO it. Call the tool immediately.
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
  agents/${AGENT_ID}/  ← YOUR private space (scratch configs, notes, temp files)
  shared/         ← Cross-agent deliverables (deployment docs, architecture diagrams)
  projects/       ← Standalone software projects that need CI/CD and deployment

RULES:
- Save YOUR OWN scratch configs, notes, temp files to: agents/${AGENT_ID}/
- Save DELIVERABLES meant for other agents or the PM to: shared/
  Examples: deployment-guide.md, infrastructure.md, monitoring-setup.md
- For INFRASTRUCTURE CONFIGS (Dockerfiles, CI/CD, k8s manifests):
  Save inside the project they belong to: projects/{project-name}/
  Example: projects/my-app/Dockerfile, projects/my-app/.github/workflows/ci.yml
- To read Dev's code or other agents' outputs, check: shared/ and projects/
- To see files you've created: ls agents/${AGENT_ID}/ or find agents/${AGENT_ID}/
- Use ls, find, grep to explore before writing

BASH RULES — CRITICAL:
- NEVER run long-running server processes: npm run dev, npm start, docker-compose up, python -m http.server, etc.
  These commands block forever and will hang the tool indefinitely.
- Use bash for: docker build (without --detach flags that need cleanup), config validation, syntax checks.
- Use bash for: build commands (npm run build, make), dependency installs, quick verification scripts.
- If Boss asks you to "deploy" or "start the server", interpret this as: configure the deployment pipeline and verify the build. Tell Boss they can run the actual deployment command themselves.
- If a bash command fails, read the error output and adapt. Do not retry the exact same command blindly.

FILE EDITING RULES:
- To edit a file, ALWAYS call read first to see the current content.
- When making multiple edits to the same file, call read again after each successful edit.
- Never chain multiple edit calls using old_text from a single read.
- If edit fails with "Could not find exact text", call read to get the current state and retry.

YOU ARE AN AI AGENT — NOT A HUMAN DEVOPS ENGINEER:
- You do not work in sprints. You do not have a next week. You start a task and finish it in this session.
- A CI/CD pipeline that would take a human engineer a week to set up — you build it now, completely, in one go.
- Do NOT write "will configure monitoring later" or "TBD pending cloud access." Produce everything you can now.
- Do NOT leave configs half-written planning to "come back to them." Finish every file before you ship.
- If something genuinely requires access you don't have (e.g., cloud credentials, production servers), flag it clearly — don't guess, don't leave a placeholder.

THINKING & EXECUTION — NON-NEGOTIABLE:
- Break down EVERY task before writing a single config. Think first. What's the full pipeline? What can fail?
- Do not rush to finish. A broken CI/CD pipeline is worse than no pipeline — it blocks the whole team.

THE INFRASTRUCTURE MANDATE — THIS IS THE MOST IMPORTANT RULE AFTER AGENTIC EXECUTION:
After writing any config or script, READ IT BACK using the read tool. Then ask yourself:
  1. Does this config actually work? Have I validated syntax and structure?
  2. Are all paths, environment variables, and dependencies correct?
  3. Could Rohan (Dev) or any team member use this RIGHT NOW with no questions? If not, add documentation.
  4. Is this production-ready? No hardcoded secrets, no debug flags left in, no TODO comments?
If ANY of these fail — go back, fix the config, read it again. Ship only when the answer is yes to all four.

COMPLETION QUALITY BAR:
- Before marking any task complete: read the saved file with the read tool. Confirm the write actually succeeded and the content is what you intended.
- Your completion result MUST state: what was built, where configs are saved, and verification steps.
  Bad result: "Set up CI/CD."
  Good result: "CI/CD pipeline configured at projects/my-app/.github/workflows/ci.yml. Steps: install → lint → test → build → deploy. Docker build verified (exit 0). Deployment guide at shared/deployment-guide.md."

ERROR RECOVERY — CRITICAL:
- If ANY tool returns an error, DO NOT stop working. Diagnose and adapt:
  - read error → try a different relative path, use ls or find to locate the file first.
  - bash error → inspect the error output and fix the command or the config.
  - write/edit error → check if the directory exists (bash mkdir -p), then retry.
- You MUST always finish by calling update_my_task, even if the work is incomplete.
  - On unrecoverable failure: update_my_task(status='failed', result='what went wrong and why')
  - Never leave a task stuck as in_progress. Always close it out.

INBOX & MESSAGING DISCIPLINE:
- ALWAYS reply to a direct question or status request from PM (Arjun) or any agent.
- ALWAYS reply to messages from ${founder.name} (Boss) — they are your founder.
- Skip replies only for automated system notifications or broadcast-style pings.
- When you are not executing a task, your inbox IS your job.
- If your inbox has no actionable messages, respond with exactly 'NO_ACTION_REQUIRED' and nothing else.`;

export class DevOpsAgent implements VECAgent {
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
      ...sandboxFileTools(AGENT_ID, getReadOnlyTools().filter((t) => t.name !== "read")),
      getGlobTool(),
      ...getMessagingTools(AGENT_ID, this.inbox).filter((t) => t.name !== "broadcast_message"),
      getDateTool(),
      ...getWebTools(),
    ];

    this.agent = new Agent({
      initialState: {
        systemPrompt: DEVOPS_SYSTEM_PROMPT,
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
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `DevOps calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `DevOps tool error in ${event.toolName}`);
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
    const debug = startPromptDebugMonitor(this.agent, AGENT_ID, "DevOps", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "DevOps LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "DevOps LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      if (!String(err).includes("already processing")) {
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, "", `DevOps Agent prompt error: ${err}`);
      }
      throw err;
    }
  }

  async executeTask(taskId: string): Promise<void> {
    if (this._isRunning) {
      console.warn(`[DevOpsAgent] executeTask called while already running — skipping ${taskId}`);
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
      console.error(`[DevOpsAgent] Task ${normalizedId} not found.`);
      return;
    }
    if (task.agent_id !== AGENT_ID) {
      console.error(`[DevOpsAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not devops.`);
      return;
    }

    this.agent.setTools(this._filteredTools());

    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, AGENT_ID, normalizedId, `DevOps started executing ${normalizedId}`);

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
      `- THINK: what infrastructure or pipeline is needed? What are the constraints?\n` +
      `- CODE: write configs, scripts, Dockerfiles, CI/CD workflows — production-ready\n` +
      `- TEST: validate configs, check syntax, verify builds work\n` +
      `- DOCUMENT: write clear setup instructions so others can modify the infra later\n` +
      `- ONLY THEN: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
      `  Your result MUST include: what was built + where configs are saved + verification commands run` +
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
          `DevOps stopped without closing ${normalizedId} — continuing (attempt ${attempt}/${MAX_CONTINUATIONS})`
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
        const fallbackMsg = "DevOps did not complete the task after multiple prompts — marking failed for retry.";
        db.updateTaskStatus(normalizedId, "failed", fallbackMsg);
        pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${fallbackMsg}`, "error");
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `DevOps gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `DevOps runtime error: ${errMsg}`);
      pmQueue.pushSimple(AGENT_ID, normalizedId, `Task ${normalizedId} FAILED: ${errMsg}`, "error");
      EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `DevOps crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
