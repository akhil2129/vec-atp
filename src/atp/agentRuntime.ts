/**
 * AgentRuntime — Central lifecycle manager for dynamic agent instances.
 * Manages creation, deletion, pausing, and resuming of specialist agents at runtime.
 */

import type { VECAgent } from "./inboxLoop.js";
import { startInboxLoop } from "./inboxLoop.js";
import { unregisterInboxWaker } from "./agentMessageQueue.js";
import { refreshAgentMeta } from "./agentMessageQueue.js";
import { ATPDatabase } from "./database.js";
import { clearAgentHistory } from "../memory/messageHistory.js";
import { EventLog } from "./eventLog.js";
import { EventType } from "./models.js";
import { BaseSpecialistAgent } from "../ar/baseSpecialist.js";
import type { SpecialistDeps } from "../ar/baseSpecialist.js";
import {
  loadRoster,
  getSpecialistEntries,
  addAgentToRoster,
  removeAgentFromRoster,
  toggleAgentInRoster,
  getRoleTemplates,
  type RosterEntry,
} from "../ar/roster.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentHandle {
  agent: VECAgent;
  loop: NodeJS.Timeout | null;   // null = paused
  entry: RosterEntry;
}

export type AgentStatus = "running" | "paused" | "stopped";

export interface AgentStatusEntry {
  agent_id: string;
  employee_id: string;
  name: string;
  template: string;
  status: AgentStatus;
  enabled: boolean;
}

// ── AgentRuntime ──────────────────────────────────────────────────────────────

export class AgentRuntime {
  private handles = new Map<string, AgentHandle>();
  /** Shared agents map — includes PM. Dashboard server and PM reference this directly. */
  readonly allAgents: Map<string, VECAgent>;
  private deps: SpecialistDeps;

  constructor(deps: SpecialistDeps, pmAgent: VECAgent) {
    this.deps = deps;
    this.allAgents = new Map<string, VECAgent>([["pm", pmAgent]]);

    // Boot all enabled specialists from roster
    const entries = getSpecialistEntries();
    for (const entry of entries) {
      const agent = new BaseSpecialistAgent(entry, deps);
      this.handles.set(entry.agent_id, { agent, loop: null, entry });
      this.allAgents.set(entry.agent_id, agent);
      console.log(`  [AR] Registered: ${entry.employee_id} ${entry.name} (${entry.agent_id}) [${entry.tool_profile}]`);
    }
    console.log(`  [AR] ${this.handles.size} specialist agent(s) registered from roster.`);
  }

  /** Get the specialist agent registry (excluding PM) for use by task dispatch. */
  getSpecialistRegistry(): Map<string, VECAgent> {
    const reg = new Map<string, VECAgent>();
    for (const [id, h] of this.handles) reg.set(id, h.agent);
    return reg;
  }

  // ── Inbox loop management ───────────────────────────────────────────────────

  /**
   * Start inbox loops for all registered specialists.
   * Called once after construction. Returns all interval handles.
   */
  startAllLoops(
    afterPromptFactory?: (agentId: string, agent: VECAgent) => (() => Promise<void>) | undefined
  ): NodeJS.Timeout[] {
    const timers: NodeJS.Timeout[] = [];
    for (const [agentId, handle] of this.handles) {
      if (handle.loop) continue; // already running
      const afterPrompt = afterPromptFactory?.(agentId, handle.agent);
      const timer = startInboxLoop(handle.agent, agentId, undefined, afterPrompt);
      handle.loop = timer;
      timers.push(timer);
    }
    return timers;
  }

  // ── Dynamic agent operations ────────────────────────────────────────────────

  /**
   * Add a new agent instance from a role template.
   * Creates the roster entry, instantiates the agent, starts its inbox loop.
   */
  addAgent(
    templateId: string,
    name: string,
    overrides?: Partial<Pick<RosterEntry, "skills" | "color" | "initials" | "agent_id">>
  ): AgentStatusEntry {
    // 1. Create roster entry (validates + persists)
    const entry = addAgentToRoster(templateId, name, overrides);

    // 2. Register in employee database
    ATPDatabase.registerEmployee({
      employee_id: entry.employee_id,
      agent_id: entry.agent_id,
      name: entry.name,
      designation: entry.designation,
      department: entry.department,
      hierarchy_level: entry.hierarchy_level,
      reports_to: entry.reports_to,
      skills: entry.skills.join(","),
    });

    // 3. Instantiate the agent
    const agent = new BaseSpecialistAgent(entry, this.deps);

    // 4. Start inbox loop
    const afterPrompt = this._makeAfterPrompt(entry.agent_id, agent);
    const loop = startInboxLoop(agent, entry.agent_id, undefined, afterPrompt);

    // 5. Register in handles + allAgents
    this.handles.set(entry.agent_id, { agent, loop, entry });
    this.allAgents.set(entry.agent_id, agent);

    // 6. Refresh display names + agent ID set
    refreshAgentMeta();

    EventLog.log(EventType.AGENT_THINKING, entry.agent_id, "", `Agent '${entry.name}' (${entry.agent_id}) created from template '${templateId}'`);
    console.log(`  [AR] Added: ${entry.employee_id} ${entry.name} (${entry.agent_id}) [${entry.tool_profile}]`);

    return {
      agent_id: entry.agent_id,
      employee_id: entry.employee_id,
      name: entry.name,
      template: templateId,
      status: "running",
      enabled: true,
    };
  }

  /**
   * Remove an agent instance completely.
   * Aborts any running work, cleans up all state, removes from roster.
   */
  async removeAgent(agentId: string): Promise<void> {
    if (agentId === "pm") throw new Error("Cannot remove PM agent — it is mandatory.");
    const handle = this.handles.get(agentId);
    if (!handle) throw new Error(`Agent '${agentId}' not found in runtime.`);

    // 1. Abort any in-flight LLM call
    handle.agent.abort();

    // 2. Stop inbox loop
    if (handle.loop) {
      clearInterval(handle.loop);
      handle.loop = null;
    }

    // 3. Unregister inbox waker
    unregisterInboxWaker(agentId);

    // 4. Fail any in-progress tasks
    const inProgressTasks = ATPDatabase.getAllTasks("in_progress").filter(
      (t) => t.agent_id === agentId
    );
    for (const task of inProgressTasks) {
      ATPDatabase.updateTaskStatus(task.task_id, "failed", `Agent '${agentId}' was removed.`);
    }

    // 5. Mark employee offline
    ATPDatabase.updateEmployeeStatus(agentId, "offline");

    // 6. Clear conversation history
    clearAgentHistory(agentId);

    // 7. Remove from runtime maps
    this.handles.delete(agentId);
    this.allAgents.delete(agentId);

    // 8. Remove from roster.json
    const removed = removeAgentFromRoster(agentId);

    // 9. Refresh display names + agent ID set
    refreshAgentMeta();

    EventLog.log(EventType.AGENT_THINKING, agentId, "", `Agent '${removed.name}' (${agentId}) removed from runtime`);
    console.log(`  [AR] Removed: ${removed.employee_id} ${removed.name} (${agentId})`);
  }

  /**
   * Pause an agent — stops its inbox loop but keeps the agent in memory.
   * Messages accumulate in the inbox and are processed when resumed.
   */
  pauseAgent(agentId: string): void {
    if (agentId === "pm") throw new Error("Cannot pause PM agent — it is mandatory.");
    const handle = this.handles.get(agentId);
    if (!handle) throw new Error(`Agent '${agentId}' not found in runtime.`);
    if (!handle.loop) return; // already paused

    clearInterval(handle.loop);
    handle.loop = null;
    unregisterInboxWaker(agentId);
    console.log(`  [AR] Paused: ${handle.entry.name} (${agentId})`);
  }

  /**
   * Resume a paused agent — restarts its inbox loop.
   */
  resumeAgent(agentId: string): void {
    const handle = this.handles.get(agentId);
    if (!handle) throw new Error(`Agent '${agentId}' not found in runtime.`);
    if (handle.loop) return; // already running

    const afterPrompt = this._makeAfterPrompt(agentId, handle.agent);
    handle.loop = startInboxLoop(handle.agent, agentId, undefined, afterPrompt);
    console.log(`  [AR] Resumed: ${handle.entry.name} (${agentId})`);
  }

  /**
   * Toggle an agent's enabled state.
   * If disabling: pauses the agent + updates roster.
   * If enabling: creates agent if not in memory, resumes it, updates roster.
   */
  toggleAgent(agentId: string, enabled: boolean): AgentStatusEntry {
    if (agentId === "pm" && !enabled) throw new Error("Cannot disable PM agent — it is mandatory.");

    // Update roster.json
    const entry = toggleAgentInRoster(agentId, enabled);

    if (enabled) {
      // If agent exists in memory, just resume it
      if (this.handles.has(agentId)) {
        this.resumeAgent(agentId);
      } else {
        // Re-create from roster entry
        const agent = new BaseSpecialistAgent(entry, this.deps);
        const afterPrompt = this._makeAfterPrompt(agentId, agent);
        const loop = startInboxLoop(agent, agentId, undefined, afterPrompt);
        this.handles.set(agentId, { agent, loop, entry });
        this.allAgents.set(agentId, agent);

        // Re-register employee
        ATPDatabase.registerEmployee({
          employee_id: entry.employee_id,
          agent_id: entry.agent_id,
          name: entry.name,
          designation: entry.designation,
          department: entry.department,
          hierarchy_level: entry.hierarchy_level,
          reports_to: entry.reports_to,
          skills: entry.skills.join(","),
        });
      }
      ATPDatabase.updateEmployeeStatus(agentId, "available");
    } else {
      this.pauseAgent(agentId);
      ATPDatabase.updateEmployeeStatus(agentId, "offline");
    }

    refreshAgentMeta();

    return {
      agent_id: entry.agent_id,
      employee_id: entry.employee_id,
      name: entry.name,
      template: entry.template,
      status: enabled ? "running" : "paused",
      enabled,
    };
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  /** Get runtime status for all registered agents. */
  getStatus(): AgentStatusEntry[] {
    const result: AgentStatusEntry[] = [];

    // PM is always running
    result.push({
      agent_id: "pm",
      employee_id: "EMP-001",
      name: loadRoster().agents.find((a) => a.agent_id === "pm")?.name ?? "PM",
      template: "pm",
      status: "running",
      enabled: true,
    });

    // All specialists
    for (const [agentId, handle] of this.handles) {
      result.push({
        agent_id: agentId,
        employee_id: handle.entry.employee_id,
        name: handle.entry.name,
        template: handle.entry.template,
        status: handle.loop ? "running" : "paused",
        enabled: handle.entry.enabled,
      });
    }

    return result;
  }

  // ── Shutdown ────────────────────────────────────────────────────────────────

  /** Stop all agent loops. Called on process shutdown. */
  shutdown(): void {
    for (const [_, handle] of this.handles) {
      if (handle.loop) {
        clearInterval(handle.loop);
        handle.loop = null;
      }
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Build the afterPrompt callback for an agent — drives in_progress tasks
   * to completion after each inbox prompt.
   */
  private _makeAfterPrompt(
    agentId: string,
    agent: VECAgent
  ): (() => Promise<void>) | undefined {
    if (typeof agent.executeTask !== "function") return undefined;
    return async () => {
      const inProgress = ATPDatabase.getAllTasks("in_progress").filter(
        (t) => t.agent_id === agentId
      );
      for (const task of inProgress) {
        await agent.executeTask!(task.task_id).catch(() => {});
      }
    };
  }
}
