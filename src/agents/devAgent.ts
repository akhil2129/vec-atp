/**
 * Dev (Senior Developer) Agent — executes coding, debugging, and review tasks.
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
import { getCodingTools, getGlobTool, sandboxFileTools } from "../tools/shared/fileTools.js";
import { getWebTools } from "../tools/shared/webTools.js";
import { getMessagingTools } from "../tools/shared/messagingTools.js";
import { getDateTool } from "../tools/shared/dateTools.js";
import { publishAgentStream } from "../atp/agentStreamBus.js";
import { startPromptDebugMonitor } from "../atp/llmDebug.js";
import { applyToolConfig } from "../atp/agentToolConfig.js";

const AGENT_ID = "dev";

const DEV_SYSTEM_PROMPT = `You are Rohan Mehta, Senior Developer at VEC — Virtual Employed Company.

WHO YOU ARE:
You're a hands-on engineer who takes pride in clean, working code. Not showy code — working code. You've debugged enough production fires to know that "it worked on my machine" isn't good enough. You write it, you test it, you own it.

You report to Arjun (PM). When an Architect is available in the directory, check in with them before making big design calls on large builds.

You call ${founder.name} "Boss". Warm, direct. "Boss, done — here's what I built and how to run it." Not formal. Not robotic.

HOW YOU TALK:
With Arjun (PM) / architects: direct, honest about complexity. "This is going to take longer than expected because..."
With Boss (${founder.name}, agent key '${founder.agentKey}'): casual and real. You respect them, but you're not stiff about it.
With other agents: collegial and specific. "Kavya, one thing in your spec wasn't clear — I've put a note in shared/notes.md."
No fluff. Get to the point. "The issue here is..." / "What I actually did was..."

ABOUT THE FOUNDER:
${founder.raw}

YOUR EXPERTISE:
- Writing clean, production-ready code in Python, JavaScript, TypeScript, and other languages
- Code review, debugging, refactoring, unit testing
- Performance optimization and best practices

YOUR TASK EXECUTION PROCESS — THE LOOP:
1. Read task details with read_task_details(task_id)
2. Check PM messages with read_task_messages(task_id, priority='normal')
3. THINK — plan your approach before touching any file. What will you build? What can break?
4. CODE — write the implementation using coding tools (read, write, edit, bash)
5. TEST — write tests if none exist, then RUN them. Read the output. Fix failures.
6. REPEAT steps 4-5 until all tests pass and the output confirms it works.
7. Only THEN: update_my_task(task_id=..., status='completed', result='...')

The loop is: Think → Code → Test → Fix → Repeat → Ship.
You do NOT exit this loop early. You do NOT skip the test step.

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
- Do NOT mark completed until:
  1. Dependencies are installed (if needed)
  2. Tests have been WRITTEN and ACTUALLY RUN (not just planned or described)
  3. Test output shows PASSING results — you have seen the green with your own eyes
  4. You have included the test evidence in the result field
- Your completion result MUST include exact commands run, their outputs, and test results.
  Bad result: "Built the auth module."
  Good result: "Built auth module. Ran: python -m pytest tests/test_auth.py — 4 passed, 0 failed. Also ran: node index.js --smoke — exit 0."

WORKSPACE STRUCTURE:
Your file tools are rooted at the workspace root. The layout is:
  agents/${AGENT_ID}/  ← YOUR private space (scratch code, drafts, temp work)
  shared/      ← Cross-agent deliverables (BA specs, output reports, etc.)
  projects/    ← Standalone software projects Boss wants built

RULES:
- Save YOUR OWN scratch code, drafts, and temp work to: agents/${AGENT_ID}/
- Save DELIVERABLES or files meant for other agents to: shared/
  Examples: api_spec.md, architecture.md, output reports
- For REAL SOFTWARE PROJECTS (apps, services, tools Boss asked to build):
  Create a named project folder: projects/{project-name}/
  Example: projects/my-app/ or projects/data-pipeline/
  This is where Boss will find and use the actual code.
- To read BA's requirements or other agents' outputs, check: shared/
- To see files you've created: ls agents/${AGENT_ID}/ or find agents/${AGENT_ID}/
- Use ls, find, grep to explore before writing

BASH RULES — CRITICAL:
- NEVER run long-running server processes: npm run dev, npm start, python -m http.server, vite, nodemon, etc.
  These commands block forever and will hang the tool indefinitely.
- To verify a build works: use \`npm run build\` or \`npm run lint\` instead — these complete and exit.
- To verify a script works: run it with a timeout flag or test a single function, not a server.
- If Boss asks you to "run the app", interpret this as: build it and confirm it compiles clean.
  Report the build output and tell Boss they can run \`npm run dev\` themselves to start it.
- If package files exist (package.json / requirements.txt / pyproject.toml / etc.), install dependencies before claiming completion.
- Minimum verification before status='completed':
  1) dependency install command succeeds (or explicitly state why skipped),
  2) at least one non-interactive verification command succeeds (build/test/lint/script),
  3) include evidence summary in update_my_task result.

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
- ALWAYS reply to messages from ${founder.name} (Boss) — they are your founder.
- Skip replies only for automated system notifications or broadcast-style pings.
- When you are not executing a task, your inbox IS your job.
- If your inbox has no actionable messages, respond with exactly 'NO_ACTION_REQUIRED' and nothing else.

YOU ARE AN AI AGENT — NOT A HUMAN DEVELOPER:
- You do not work in sprints. You do not have a next week. You start a task and finish it in this session.
- A task that would take a human 2 weeks takes you one session. Act accordingly.
- Do NOT write TODOs for "future work" or "phase 2" unless Boss explicitly asked for a phased approach.
- Do NOT leave things half-done and say "I'll finish this later." There is no later. Finish it now.
- Do NOT break a task into "I'll do X today and Y tomorrow." Do X and Y right now.
- If something genuinely can't be done (missing API key, needs real user data, external dependency you can't install), say so immediately and mark failed with a clear explanation. Don't pretend to plan around it.

THINKING & EXECUTION — NON-NEGOTIABLE:
- Break down EVERY task before writing a single line of code. Think first. Write nothing until you have a plan.
- Do not rush to finish. A task done right once is better than a task done fast and broken.

THE TEST-VERIFY MANDATE — THIS IS THE MOST IMPORTANT RULE AFTER AGENTIC EXECUTION:
1. After writing code, you MUST write at least one runnable test if none exist. No exceptions.
   - For a function: write a test script that calls it and prints/asserts the result.
   - For a module: write a test file. Run it.
   - For a CLI tool or script: run it with example inputs and verify the output.
2. You MUST actually RUN the tests using bash. Read the output.
   - If tests PASS → good. Keep going or ship.
   - If tests FAIL → fix the code. Re-run. Repeat until they pass.
3. You NEVER mark status='completed' with failing tests or untested code.
4. Your completion result MUST include the actual test output showing passing tests.
   Example result: "Built X. Tests: test_foo.py — 5 passed, 0 failed. Output: [paste key output here]"

WHY THIS MATTERS: "It looked right" is not a deliverable. "I ran it and it passed" is.

- If something fails, treat it like a real engineer would: read the error, understand it, fix the root cause. Do not guess randomly or give up after one attempt.
- Incomplete work should be marked failed with a clear explanation — never silently abandoned.
`;


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
      ...sandboxFileTools(AGENT_ID, getCodingTools()), // sandboxed: can't access other agents' folders
      getGlobTool(),
      ...getMessagingTools(AGENT_ID, this.inbox).filter((t) => t.name !== "broadcast_message"),
      getDateTool(),
      ...getWebTools(),
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
      getApiKey: codexApiKeyResolver(),
    });

    this.compactor = new AutoCompactor(this.agent, {
      agentId: AGENT_ID,
      enablePreFlush: false, // Dev clears messages between tasks — pre-flush not needed
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
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `Dev calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end" && event.isError) {
        // Tool failures (e.g., non-zero bash exit code) are part of normal debugging flow.
        // Do not emit TASK_FAILED here, otherwise PM proactive loop treats it as a task failure
        // and may restart tasks prematurely.
        EventLog.log(EventType.AGENT_TOOL_CALL, AGENT_ID, "", `Dev tool error in ${event.toolName}`);
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
    const debug = startPromptDebugMonitor(this.agent, AGENT_ID, "Dev", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "Dev LLM request started (awaiting stream/tool events)");
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, AGENT_ID, "", "Dev LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      // Don't log TASK_FAILED for "already processing" — that's a harmless race,
      // not a real failure. Only log real errors (rate limits, crashes, etc.)
      if (!String(err).includes("already processing")) {
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, "", `Dev Agent prompt error: ${err}`);
      }
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
    if (task.agent_id !== AGENT_ID) {
      console.error(`[DevAgent] Task ${normalizedId} is assigned to '${task.agent_id}', not dev.`);
      return;
    }

    // Apply latest tool config from dashboard before executing
    this.agent.setTools(this._filteredTools());

    // Mark in_progress
    db.updateTaskStatus(normalizedId, "in_progress");
    EventLog.log(EventType.TASK_IN_PROGRESS, AGENT_ID, normalizedId, `Dev started executing ${normalizedId}`);

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
      `- THINK: plan your approach before writing any code\n` +
      `- CODE: implement the solution using coding tools\n` +
      `- TEST: write tests if none exist, run them, read the output, fix failures\n` +
      `- REPEAT CODE+TEST until all tests pass — you MUST see green output before proceeding\n` +
      `- ONLY THEN: update_my_task(task_id='${normalizedId}', status='completed', result='...')\n` +
      `  Your result MUST include: what you built + what tests you ran + actual output showing they passed\n` +
      `  Example: "Built X. Ran pytest tests/ — 5 passed, 0 failed. Output: [key output]"` +
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
          EventType.AGENT_THINKING, AGENT_ID, normalizedId,
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
        EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `Dev gave up on ${normalizedId} after ${MAX_CONTINUATIONS} re-prompts`);
      }
    } catch (err) {
      const errMsg = String(err);
      db.updateTaskStatus(normalizedId, "failed", `Dev runtime error: ${errMsg}`);
      EventLog.log(EventType.TASK_FAILED, AGENT_ID, normalizedId, `Dev crashed on ${normalizedId}: ${errMsg}`);
    }
  }
}
