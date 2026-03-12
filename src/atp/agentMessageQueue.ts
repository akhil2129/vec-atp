/**
 * Agent-to-agent message queue for inter-agent coordination.
 * Supports normal queued messages and priority interrupt messages.
 */

import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { founder } from "../identity.js";
import { loadRoster, clearRosterCache } from "../ar/roster.js";
import type { AgentMessage } from "./models.js";

const QUEUE_PATH = path.join(config.dataDir, "agent_messages.json");
const FLOW_LOG_PATH = path.join(config.dataDir, "message_flow.json");
const MAX_FLOW_ENTRIES = 500;

// ── Instant wake registry ─────────────────────────────────────────────────────
// When a message is pushed to an agent's inbox, their wake fn fires immediately
// instead of waiting for the 15-second poll tick.
const inboxWakers = new Map<string, () => void>();

export function registerInboxWaker(agentId: string, fn: () => void): void {
  inboxWakers.set(agentId.trim().toLowerCase(), fn);
}

export function unregisterInboxWaker(agentId: string): void {
  inboxWakers.delete(agentId.trim().toLowerCase());
}

// ── Display names & agent IDs — built from roster.json ───────────────────────

function _buildDisplayNames(): Record<string, string> {
  const names: Record<string, string> = {};
  for (const entry of loadRoster().agents) {
    if (!entry.enabled) continue;
    const shortRole = entry.role.split(" ").pop() ?? entry.role;
    names[entry.agent_id] = `${entry.name} (${shortRole})`;
  }
  names.user = founder.displayName;
  return names;
}

/**
 * Roster-driven display names. Mutable — call refreshAgentMeta() after roster changes.
 * We mutate the object in-place so existing imports see the updated values.
 */
export const AGENT_DISPLAY_NAMES: Record<string, string> = _buildDisplayNames();

function _buildAllAgentIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of loadRoster().agents) {
    if (entry.enabled) ids.add(entry.agent_id);
  }
  ids.add("user");
  return ids;
}

/** Roster-driven agent ID set. Mutable — call refreshAgentMeta() after roster changes. */
export const ALL_AGENT_IDS: Set<string> = _buildAllAgentIds();

/**
 * Rebuild display names and agent ID set from the current roster.
 * Call after any roster mutation (add/remove/toggle agent).
 */
export function refreshAgentMeta(): void {
  clearRosterCache();

  // Mutate AGENT_DISPLAY_NAMES in-place
  for (const key of Object.keys(AGENT_DISPLAY_NAMES)) delete AGENT_DISPLAY_NAMES[key];
  Object.assign(AGENT_DISPLAY_NAMES, _buildDisplayNames());

  // Mutate ALL_AGENT_IDS in-place
  ALL_AGENT_IDS.clear();
  for (const id of _buildAllAgentIds()) ALL_AGENT_IDS.add(id);
}

function ensureFile(): void {
  if (!fs.existsSync(QUEUE_PATH)) {
    fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
    fs.writeFileSync(QUEUE_PATH, "[]", "utf-8");
  }
}

function read(): AgentMessage[] {
  ensureFile();
  const text = fs.readFileSync(QUEUE_PATH, "utf-8").trim();
  if (!text) return [];
  return JSON.parse(text) as AgentMessage[];
}

function write(data: AgentMessage[]): void {
  ensureFile();
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function logFlow(from_agent: string, to_agent: string, priority: string, task_id: string): void {
  try {
    fs.mkdirSync(path.dirname(FLOW_LOG_PATH), { recursive: true });
    let data: object[] = [];
    if (fs.existsSync(FLOW_LOG_PATH)) {
      const raw = fs.readFileSync(FLOW_LOG_PATH, "utf-8").trim();
      if (raw) data = JSON.parse(raw) as object[];
    }
    data.push({ from: from_agent, to: to_agent, priority, task_id, ts: new Date().toISOString() });
    if (data.length > MAX_FLOW_ENTRIES) data = data.slice(-MAX_FLOW_ENTRIES);
    fs.writeFileSync(FLOW_LOG_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Never break messaging due to flow logging
  }
}

export const AgentMessageQueue = {
  push(
    from_agent: string,
    to_agent: string,
    task_id: string,
    message: string,
    priority: "normal" | "priority" = "normal"
  ): AgentMessage {
    const msg: AgentMessage = {
      from_agent: from_agent.trim().toLowerCase(),
      to_agent: to_agent.trim().toLowerCase(),
      task_id: task_id.trim().toUpperCase(),
      priority,
      message,
      timestamp: new Date().toISOString(),
    };
    const data = read();
    data.push(msg);
    write(data);
    logFlow(msg.from_agent, msg.to_agent, msg.priority, msg.task_id);
    // Wake the recipient immediately — no need to wait for the 15s poll tick.
    // setImmediate so the push() call returns before the waker fires.
    setImmediate(() => inboxWakers.get(msg.to_agent)?.());
    return msg;
  },

  peekForAgent(
    to_agent: string,
    opts: { task_id?: string; priority?: string; from_agent?: string } = {}
  ): AgentMessage[] {
    const agent = to_agent.trim().toLowerCase();
    const taskId = opts.task_id?.trim().toUpperCase() ?? "";
    const prio = opts.priority?.trim().toLowerCase() ?? "";
    const fromAgent = opts.from_agent?.trim().toLowerCase() ?? "";

    return read().filter((m) => {
      if (m.to_agent !== agent) return false;
      if (taskId && m.task_id !== taskId) return false;
      if (prio && m.priority !== prio) return false;
      if (fromAgent && m.from_agent !== fromAgent) return false;
      return true;
    });
  },

  popForAgent(
    to_agent: string,
    opts: { task_id?: string; priority?: string; from_agent?: string; before?: string } = {}
  ): AgentMessage[] {
    const agent = to_agent.trim().toLowerCase();
    const taskId = opts.task_id?.trim().toUpperCase() ?? "";
    const prio = opts.priority?.trim().toLowerCase() ?? "";
    const fromAgent = opts.from_agent?.trim().toLowerCase() ?? "";
    const before = opts.before ?? ""; // ISO timestamp — only remove messages older than this

    const all = read();
    const popped: AgentMessage[] = [];
    const remaining: AgentMessage[] = [];

    for (const m of all) {
      const match =
        m.to_agent === agent &&
        (!taskId || m.task_id === taskId) &&
        (!prio || m.priority === prio) &&
        (!fromAgent || m.from_agent === fromAgent) &&
        (!before || (m.timestamp ?? "") <= before); // only pop msgs that existed at peek time
      if (match) popped.push(m);
      else remaining.push(m);
    }
    write(remaining);
    return popped;
  },

  broadcast(
    from_agent: string,
    message: string,
    task_id = "",
    priority: "normal" | "priority" = "normal",
    exclude: Set<string> = new Set()
  ): AgentMessage[] {
    const sender = from_agent.trim().toLowerCase();
    const skip = new Set([sender, ...exclude]);
    const recipients = [...ALL_AGENT_IDS].filter((id) => !skip.has(id));
    return recipients.map((recipient) =>
      this.push(sender, recipient, task_id, message, priority)
    );
  },

  clear(): void {
    write([]);
  },

  /**
   * On server restart: preserve recent user→agent messages so they survive
   * a crash or deliberate restart. Agent→agent messages (task coordination)
   * are cleared because they reference stale in-flight context.
   * @param maxAgeMs  Keep user messages newer than this (default: 2 hours)
   */
  clearTransient(maxAgeMs = 2 * 60 * 60_000): void {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const all = read();
    const keep = all.filter(
      (m) => m.from_agent === "user" && (m.timestamp ?? "") >= cutoff
    );
    write(keep);
  },

  clearFlowLog(): void {
    if (fs.existsSync(FLOW_LOG_PATH)) {
      fs.writeFileSync(FLOW_LOG_PATH, "[]", "utf-8");
    }
  },

  /** Read all pending messages without consuming them (for dashboard display). */
  peekAll(): AgentMessage[] {
    return read();
  },
};

export type AgentMessageQueueType = typeof AgentMessageQueue;

/** Per-agent scoped inbox backed by the shared AgentMessageQueue */
export class AgentInbox {
  constructor(
    public readonly agentId: string,
    private readonly queue: AgentMessageQueueType
  ) {}

  send(to_agent: string, message: string, task_id = "", priority: "normal" | "priority" = "normal"): AgentMessage {
    return this.queue.push(this.agentId, to_agent.trim().toLowerCase(), task_id, message, priority);
  }

  read(opts: { task_id?: string; priority?: string; from_agent?: string; before?: string } = {}): AgentMessage[] {
    return this.queue.popForAgent(this.agentId, opts);
  }

  peek(opts: { task_id?: string; priority?: string; from_agent?: string } = {}): AgentMessage[] {
    return this.queue.peekForAgent(this.agentId, opts);
  }

  hasMessages(opts: { priority?: string; from_agent?: string } = {}): boolean {
    return this.queue.peekForAgent(this.agentId, opts).length > 0;
  }

  count(opts: { priority?: string; from_agent?: string } = {}): number {
    return this.queue.peekForAgent(this.agentId, opts).length;
  }

  broadcast(message: string, task_id = "", priority: "normal" | "priority" = "normal", exclude?: Set<string>): AgentMessage[] {
    return this.queue.broadcast(this.agentId, message, task_id, priority, exclude);
  }
}
