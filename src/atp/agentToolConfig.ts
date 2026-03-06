/**
 * Agent Tool Configuration — catalog of all tools per agent + persistent enable/disable config.
 * Stored in data/agent-tool-config.json as { [agentId]: string[] } (list of enabled tool IDs).
 * Default: all tools enabled (no file entry = all enabled).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config.js";

const CONFIG_PATH = join(config.dataDir, "agent-tool-config.json");

export interface ToolDef {
  id: string;
  name: string;
  description: string;
  group: string;
  locked?: boolean; // always-on, cannot be disabled from dashboard
}

export interface AgentProfile {
  agent_id: string;
  name: string;
  role: string;
  department: string;
  initials: string;
  color: string;
  implemented: boolean;
  tools: ToolDef[];
}

// ── Shared tool sets ──────────────────────────────────────────────────────────

const MEMORY_TOOLS: ToolDef[] = [
  { id: "read_stm",   name: "Read STM",   description: "Read short-term memory (daily scratchpad)", group: "Memory" },
  { id: "write_stm",  name: "Write STM",  description: "Write short-term memory",                   group: "Memory" },
  { id: "read_ltm",   name: "Read LTM",   description: "Read long-term memory journal",              group: "Memory" },
  { id: "write_ltm",  name: "Write LTM",  description: "Write long-term memory journal",             group: "Memory" },
  { id: "read_sltm",  name: "Read SLTM",  description: "Read permanent stable memory",               group: "Memory" },
  { id: "write_sltm", name: "Write SLTM", description: "Write permanent stable memory",              group: "Memory" },
];

// PM messaging — includes broadcast (PM is the only coordinator who broadcasts)
const MESSAGING_TOOLS: ToolDef[] = [
  { id: "message_agent",     name: "Message Agent",    description: "Send a direct message to any agent",       group: "Messaging", locked: true },
  { id: "read_inbox",        name: "Read Inbox",        description: "Check and clear own inbox",                group: "Messaging", locked: true },
  { id: "broadcast_message", name: "Broadcast Message", description: "Send to ALL agents at once — PM use only", group: "Messaging" },
];

// Worker messaging — point-to-point only (no broadcast)
const AGENT_MESSAGING_TOOLS: ToolDef[] = [
  { id: "message_agent", name: "Message Agent", description: "Send a direct message to any agent", group: "Messaging", locked: true },
  { id: "read_inbox",    name: "Read Inbox",    description: "Check and clear own inbox",           group: "Messaging", locked: true },
];

// BA file tools — documentation files only (.md and .mmd)
const BA_FILE_TOOLS: ToolDef[] = [
  { id: "read",  name: "read",  description: "Read .md and .mmd documentation files only",  group: "Files" },
  { id: "write", name: "write", description: "Write .md and .mmd documentation files only", group: "Files" },
  { id: "edit",  name: "edit",  description: "Edit .md and .mmd documentation files only",  group: "Files" },
];

const DATE_TOOL: ToolDef = { id: "get_current_date", name: "Get Current Date", description: "Get current date and time", group: "Utilities" };

const WEB_TOOLS: ToolDef[] = [
  { id: "web_search", name: "Web Search", description: "Search the web via SearXNG", group: "Web" },
  { id: "web_read",   name: "Read Web Page", description: "Fetch and read a web page's text content", group: "Web" },
];

const READONLY_FILE_TOOLS: ToolDef[] = [
  { id: "read", name: "read", description: "Read files from disk",           group: "Files" },
  { id: "grep", name: "grep", description: "Search file content by pattern", group: "Files" },
  { id: "find", name: "find", description: "Find files by glob pattern",     group: "Files" },
  { id: "ls",   name: "ls",   description: "List directory contents",        group: "Files" },
];

const CODING_FILE_TOOLS: ToolDef[] = [
  { id: "read",  name: "read",  description: "Read files from disk",           group: "Files" },
  { id: "write", name: "write", description: "Create or overwrite files",      group: "Files" },
  { id: "edit",  name: "edit",  description: "Make targeted edits to a file", group: "Files" },
  { id: "bash",  name: "bash",  description: "Execute shell commands",         group: "Files" },
];

const SPECIALIST_TASK_TOOLS: ToolDef[] = [
  { id: "read_my_tasks",      name: "Read My Tasks",      description: "View tasks assigned to me",                  group: "Task Management" },
  { id: "read_task_details",  name: "Task Details",       description: "Get full task information",                  group: "Task Management" },
  { id: "update_my_task",     name: "Update My Task",     description: "Update task status & result",                group: "Task Management" },
  { id: "read_task_messages", name: "Read Task Messages", description: "Read PM messages for a specific task",       group: "Task Management" },
  { id: "self_assign_task",   name: "Self-Assign Task",   description: "Create & claim a task from direct request",  group: "Task Management" },
];

// ── Full agent catalog ────────────────────────────────────────────────────────

export const AGENT_PROFILES: AgentProfile[] = [
  {
    agent_id: "pm",
    name: "Arjun Sharma",
    role: "Project Manager",
    department: "Management",
    initials: "AS",
    color: "#1158c7",
    implemented: true,
    tools: [
      { id: "create_and_assign_task",  name: "Create & Assign Task", description: "Create a task and auto-assign to an agent",  group: "Task Management" },
      { id: "start_task",              name: "Start Task",           description: "Trigger a pending task by ID",               group: "Task Management" },
      { id: "start_tasks",             name: "Start Multiple Tasks", description: "Trigger multiple pending tasks at once",      group: "Task Management" },
      { id: "reschedule_task",         name: "Reschedule Task",      description: "Change a task's scheduled date",             group: "Task Management" },
      { id: "send_task_message",       name: "Send Task Message",    description: "Message the agent assigned to a task",       group: "Task Management" },
      { id: "send_priority_message",   name: "Priority Message",     description: "Send a priority interrupt to an agent",      group: "Task Management" },
      { id: "check_task_status",       name: "Check Task Status",    description: "Check current status of any task",           group: "Task Management" },
      { id: "list_all_tasks",          name: "List All Tasks",       description: "View the full ATP task board",               group: "Task Management" },
      { id: "read_messages",           name: "Read Messages",        description: "Read notifications from agents",             group: "Task Management" },
      { id: "restart_task",            name: "Restart Task",         description: "Force-restart a stuck or stalled task",      group: "Task Management" },
      { id: "cancel_task",             name: "Cancel Task",          description: "Cancel a task (keeps record)",               group: "Task Management" },
      { id: "delete_task",             name: "Delete Task",          description: "Permanently delete a completed task",        group: "Task Management" },
      { id: "interrupt_agent",         name: "Interrupt Agent",      description: "Abort a running agent mid-stream",           group: "Task Management" },
      { id: "unblock_agent",           name: "Unblock Agent",        description: "Clear interrupt flags on an agent",          group: "Task Management" },
      { id: "view_employee_directory", name: "Employee Directory",   description: "List all employees and their status",     group: "HR" },
      { id: "lookup_employee",         name: "Lookup Employee",      description: "Get full details on any employee",        group: "HR" },
      { id: "set_employee_status",     name: "Set Employee Status",  description: "Mark an employee available/busy/offline",    group: "HR" },
      ...READONLY_FILE_TOOLS,
      ...MEMORY_TOOLS,
      ...MESSAGING_TOOLS,
      DATE_TOOL,
      ...WEB_TOOLS,
    ],
  },
  {
    agent_id: "architect",
    name: "Priya Nair",
    role: "Architect",
    department: "Engineering",
    initials: "PN",
    color: "#e36209",
    implemented: true,
    tools: [
      ...SPECIALIST_TASK_TOOLS,
      ...READONLY_FILE_TOOLS,
      ...MEMORY_TOOLS,
      ...AGENT_MESSAGING_TOOLS,
      DATE_TOOL,
      ...WEB_TOOLS,
    ],
  },
  {
    agent_id: "ba",
    name: "Kavya Nair",
    role: "Business Analyst",
    department: "Product",
    initials: "KN",
    color: "#7928ca",
    implemented: true,
    tools: [
      ...SPECIALIST_TASK_TOOLS,
      ...BA_FILE_TOOLS,
      ...MEMORY_TOOLS,
      ...AGENT_MESSAGING_TOOLS,
      DATE_TOOL,
      ...WEB_TOOLS,
    ],
  },
  {
    agent_id: "researcher",
    name: "Shreya Joshi",
    role: "Researcher",
    department: "Product",
    initials: "SJ",
    color: "#0891b2",
    implemented: true,
    tools: [
      ...SPECIALIST_TASK_TOOLS,
      ...READONLY_FILE_TOOLS,
      ...MEMORY_TOOLS,
      ...AGENT_MESSAGING_TOOLS,
      DATE_TOOL,
      ...WEB_TOOLS,
    ],
  },
  {
    agent_id: "dev",
    name: "Rohan Mehta",
    role: "Senior Developer",
    department: "Engineering",
    initials: "RM",
    color: "#3fb950",
    implemented: true,
    tools: [
      ...SPECIALIST_TASK_TOOLS,
      ...CODING_FILE_TOOLS,
      { id: "glob", name: "glob", description: "Find files matching a glob pattern", group: "Files" },
      ...MEMORY_TOOLS,
      ...AGENT_MESSAGING_TOOLS,
      DATE_TOOL,
      ...WEB_TOOLS,
    ],
  },
  {
    agent_id: "qa",
    name: "Preethi Raj",
    role: "QA Engineer",
    department: "Engineering",
    initials: "PR",
    color: "#f59e0b",
    implemented: true,
    tools: [
      ...SPECIALIST_TASK_TOOLS,
      ...READONLY_FILE_TOOLS,
      { id: "bash", name: "bash", description: "Run test commands and scripts", group: "Files" },
      ...MEMORY_TOOLS,
      ...AGENT_MESSAGING_TOOLS,
      DATE_TOOL,
      ...WEB_TOOLS,
      { id: "run_code_scan", name: "Run Code Scan", description: "Trigger SonarQube code scan via OCTO-FLOWS", group: "OCTO-Flows" },
      { id: "run_flow", name: "Run OCTO-Flow", description: "Trigger any named OCTO-FLOW pipeline", group: "OCTO-Flows" },
    ],
  },
  {
    agent_id: "security",
    name: "Vikram Singh",
    role: "Security Engineer",
    department: "Engineering",
    initials: "VS",
    color: "#ef4444",
    implemented: true,
    tools: [
      ...SPECIALIST_TASK_TOOLS,
      ...READONLY_FILE_TOOLS,
      { id: "bash", name: "bash", description: "Run security tools and scans", group: "Files" },
      ...MEMORY_TOOLS,
      ...AGENT_MESSAGING_TOOLS,
      DATE_TOOL,
      ...WEB_TOOLS,
      { id: "run_sast_scan", name: "Run SAST Scan", description: "Trigger Semgrep SAST scan via OCTO-FLOWS", group: "OCTO-Flows" },
      { id: "run_secret_scan", name: "Run Secret Scan", description: "Trigger Gitleaks secret scan via OCTO-FLOWS", group: "OCTO-Flows" },
      { id: "run_sca_scan", name: "Run SCA Scan", description: "Trigger Trivy dependency vulnerability scan via OCTO-FLOWS", group: "OCTO-Flows" },
      { id: "run_flow", name: "Run OCTO-Flow", description: "Trigger any named OCTO-FLOW pipeline", group: "OCTO-Flows" },
    ],
  },
  {
    agent_id: "devops",
    name: "Aditya Kumar",
    role: "DevOps Engineer",
    department: "Engineering",
    initials: "AK",
    color: "#8b5cf6",
    implemented: true,
    tools: [
      ...SPECIALIST_TASK_TOOLS,
      ...CODING_FILE_TOOLS,
      { id: "grep", name: "grep", description: "Search files", group: "Files" },
      { id: "find", name: "find", description: "Find files by pattern", group: "Files" },
      { id: "ls",   name: "ls",   description: "List directory contents", group: "Files" },
      ...MEMORY_TOOLS,
      ...AGENT_MESSAGING_TOOLS,
      DATE_TOOL,
      ...WEB_TOOLS,
    ],
  },
  {
    agent_id: "techwriter",
    name: "Anjali Patel",
    role: "Tech Writer",
    department: "Product",
    initials: "AP",
    color: "#ec4899",
    implemented: true,
    tools: [
      ...SPECIALIST_TASK_TOOLS,
      { id: "read",  name: "read",  description: "Read files from disk",        group: "Files" },
      { id: "write", name: "write", description: "Write documentation files",   group: "Files" },
      { id: "edit",  name: "edit",  description: "Edit existing documents",     group: "Files" },
      { id: "grep",  name: "grep",  description: "Search file content",         group: "Files" },
      { id: "find",  name: "find",  description: "Find files by pattern",       group: "Files" },
      { id: "ls",    name: "ls",    description: "List directory contents",     group: "Files" },
      ...MEMORY_TOOLS,
      ...AGENT_MESSAGING_TOOLS,
      DATE_TOOL,
      ...WEB_TOOLS,
    ],
  },
];

// ── Persistence ───────────────────────────────────────────────────────────────

export function readToolConfig(): Record<string, string[]> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function writeToolConfig(cfg: Record<string, string[]>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

/** Returns list of enabled tool IDs for an agent. Locked tools are always included. */
export function getEnabledTools(agentId: string): string[] {
  const profile = AGENT_PROFILES.find((a) => a.agent_id === agentId);
  const lockedIds = profile?.tools.filter((t) => t.locked).map((t) => t.id) ?? [];
  const stored = readToolConfig();
  if (stored[agentId]) {
    // Merge locked tools into stored list so they always appear enabled
    const merged = new Set([...stored[agentId], ...lockedIds]);
    return [...merged];
  }
  return profile ? profile.tools.map((t) => t.id) : [];
}

/** Persist a new enabled-tools list for an agent. */
export function setAgentTools(agentId: string, toolIds: string[]): void {
  const cfg = readToolConfig();
  cfg[agentId] = toolIds;
  writeToolConfig(cfg);
}

/**
 * Apply tool enable/disable config to a list of AgentTool objects.
 * - Locked tools: always pass through unchanged.
 * - Disabled tools: kept in schema (no hallucination) but execute returns a
 *   "disabled" error. A per-tool retry counter escalates the message on
 *   repeated calls to discourage the LLM from retrying.
 */
export function applyToolConfig(agentId: string, allTools: any[]): any[] {
  const stored = readToolConfig();

  // No stored config for this agent = full access, no blocking
  if (!stored[agentId]) return allTools;

  const enabled = new Set(getEnabledTools(agentId));
  const profile = AGENT_PROFILES.find((a) => a.agent_id === agentId);
  const locked = new Set(profile?.tools.filter((t) => t.locked).map((t) => t.id) ?? []);

  return allTools.map((t) => {
    // Locked or enabled — pass through as-is
    if (locked.has(t.name) || enabled.has(t.name)) return t;

    // Disabled — soft-block with escalating messages
    let callCount = 0;
    return {
      ...t,
      execute: async () => {
        callCount++;
        const msg =
          callCount === 1
            ? `Tool '${t.name}' is disabled by the administrator. Do not retry — respond without it.`
            : `SYSTEM BLOCK: Tool '${t.name}' is disabled. You have called it ${callCount} times. Stop immediately and respond without it.`;
        return { content: [{ type: "text", text: msg }], details: {} };
      },
    };
  });
}
