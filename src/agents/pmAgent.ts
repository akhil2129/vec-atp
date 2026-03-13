/**
 * PM (Project Manager) Agent — VEC orchestrator.
 * Creates tasks in ATP, delegates to specialists, reads message queue for updates.
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
import { getEffectiveModel } from "../atp/modelConfig.js";
import { getPMTaskTools } from "../tools/pm/taskTools.js";
import { getPMEmployeeTools } from "../tools/pm/employeeTools.js";
import { getMemoryToolsSlim } from "../tools/shared/memoryTools.js";
import { getReadOnlyTools, sandboxFileTools } from "../tools/shared/fileTools.js";
import { getWebTools } from "../tools/shared/webTools.js";
import { getMCPTools } from "../mcp/mcpBridge.js";
import { getMessagingTools } from "../tools/shared/messagingTools.js";
import { getDateTool } from "../tools/shared/dateTools.js";
import { founder } from "../identity.js";
import { makeCompactionTransform } from "../memory/compaction.js";
import { AutoCompactor } from "../memory/autoCompaction.js";
import { saveAgentHistory, loadAgentHistory, clearAgentHistory } from "../memory/messageHistory.js";
import { startPromptDebugMonitor } from "../atp/llmDebug.js";
import { applyToolConfig } from "../atp/agentToolConfig.js";
import { buildSunsetPrompt } from "../memory/sessionLifecycle.js";
import { loadPrompt } from "../ar/promptLoader.js";
import { getPMEntry, getSpecialistEntries } from "../ar/roster.js";

/** Build the {{team_roster}} variable from roster.json. */
function buildTeamRoster(): string {
  return getSpecialistEntries()
    .map((e) => `- ${e.name} (${e.role}, ${e.employee_id}) — agent key: '${e.agent_id}'. Skills: ${e.skills.join(", ")}`)
    .join("\n");
}

/** Build PM system prompt from template + roster data. */
function buildPMSystemPrompt(): string {
  const pm = getPMEntry();
  return loadPrompt(pm.prompt_file, {
    name: pm.name,
    role: pm.role,
    agent_id: pm.agent_id,
    employee_id: pm.employee_id,
    founder_name: founder.name,
    founder_agent_key: founder.agentKey,
    founder_raw: founder.raw,
    company_name: config.companyName,
    team_roster: buildTeamRoster(),
  });
}

const PM_SYSTEM_PROMPT = buildPMSystemPrompt();


export class PMAgent implements VECAgent {
  readonly inbox: AgentInbox;
  private agent: Agent;
  private allTools: any[];
  private compactor: AutoCompactor;
  private _isPrompting = false;
  get isRunning(): boolean { return this._isPrompting; }

  private _filteredTools() {
    return applyToolConfig("pm", this.allTools);
  }

  constructor(deps: {
    db: typeof ATPDatabase;
    pmQueue: typeof MessageQueue;
    agentQueue: typeof AgentMessageQueue;
    agents: Map<string, VECAgent>;
  }) {
    this.inbox = new AgentInbox("pm", AgentMessageQueue);

    this.allTools = [
      ...getPMTaskTools({ db: deps.db, pmQueue: deps.pmQueue, agentQueue: deps.agentQueue, agents: deps.agents }),
      ...getPMEmployeeTools(deps.db),
      ...getMessagingTools("pm", this.inbox),
      ...sandboxFileTools("pm", getReadOnlyTools()),
      ...getMemoryToolsSlim("pm"),
      getDateTool(),
      ...getWebTools(),
      ...getMCPTools(),
    ];

    const effectiveModel = getEffectiveModel("pm");
    this.agent = new Agent({
      initialState: {
        systemPrompt: PM_SYSTEM_PROMPT,
        model: getModel(effectiveModel.provider as any, effectiveModel.model as any),
        thinkingLevel: config.thinkingLevel,
        tools: this._filteredTools(),
        messages: [],
      },
      // Backstop trim — fires only if AutoCompactor somehow misses a turn.
      transformContext: makeCompactionTransform(100),
      getApiKey: codexApiKeyResolver(),
    });

    this.compactor = new AutoCompactor(this.agent, {
      agentId: "pm",
      enablePreFlush: true, // PM has memory tools — flush to LTM before compacting
    });

    // Restore conversation history from previous session
    const savedHistory = loadAgentHistory("pm");
    if (savedHistory.length > 0) {
      this.agent.replaceMessages(savedHistory);
    }

    // Persist history after every prompt completes
    this.agent.subscribe((event: AgentEvent) => {
      if (event.type === "agent_end") {
        saveAgentHistory("pm", event.messages as AgentMessage[]);
      }
    });
  }

  async prompt(text: string): Promise<void> {
    // Apply latest tool config from dashboard before each prompt
    this.agent.setTools(this._filteredTools());
    const debug = startPromptDebugMonitor(this.agent, "pm", "PM", {
      enabled: config.debugLlm,
      stallMs: config.debugLlmStallSecs * 1_000,
      modelLabel: `${config.modelProvider}/${config.model}`,
      inputChars: text.length,
    });
    EventLog.log(EventType.AGENT_THINKING, "pm", "", "PM LLM request started (awaiting stream/tool events)");
    this._isPrompting = true;
    try {
      await this.compactor.run(() => this.agent.prompt(text));
      const lastAssistant = [...this.agent.state.messages]
        .reverse()
        .find((m: any) => m?.role === "assistant") as any;
      if (lastAssistant?.stopReason === "error" || (lastAssistant?.errorMessage ?? "").trim()) {
        throw new Error(lastAssistant?.errorMessage || "LLM provider error");
      }
      debug.stop("completed");
      EventLog.log(EventType.AGENT_THINKING, "pm", "", "PM LLM request completed");
    } catch (err) {
      debug.stop("error", err);
      EventLog.log(EventType.TASK_FAILED, "pm", "", `PM Agent prompt error: ${err}`);
      throw err;
    } finally {
      this._isPrompting = false;
    }
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    return this.agent.subscribe(fn);
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

  clearMessages(): void {
    this.agent.clearMessages();
  }

  clearHistory(): void {
    this.agent.clearMessages();
  }

  abort(): void {
    this.agent.abort();
  }

  /**
   * SUNSET — run before clearing a stale session.
   * Forces all tools on (bypasses tool config so memory tools are always available),
   * sends the PM a "save your memories" prompt, then wipes history for sunrise.
   */
  async runSunset(sessionDate: string): Promise<void> {
    console.log(`\n[VEC] Sunset triggered for session ${sessionDate} — asking PM to journal...`);
    try {
      // Force all tools on — memory tools must be available regardless of config
      this.agent.setTools(this.allTools);
      await this.agent.prompt(buildSunsetPrompt(sessionDate));
      console.log(`[VEC] Sunset complete — PM journaled session ${sessionDate}.`);
    } catch (err) {
      // Non-fatal — if sunset fails, we still clear history and continue
      console.warn(`[VEC] Sunset prompt failed (${err}) — clearing history anyway.`);
    } finally {
      // Sunrise: wipe in-memory + disk history so next session starts clean
      this.agent.clearMessages();
      clearAgentHistory("pm");
      console.log(`[VEC] Sunrise — PM history cleared. Fresh session ready.\n`);
    }
  }
}
