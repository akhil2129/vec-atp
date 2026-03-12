export type TaskStatus = "todo" | "in_progress" | "completed" | "failed" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "critical";
export type Theme = "dark" | "light" | "midnight";

export interface Task {
  task_id: string;
  agent_id: string;
  status: TaskStatus;
  priority: TaskPriority;
  description: string;
  result: string | null;
  created_at: string;
  updated_at: string;
  folder_access: string | null;
}

export interface Employee {
  employee_id: string;
  name: string;
  role: string;
  agent_key: string;
  status: string;
  department?: string;
  color?: string;
  initials?: string;
}

export interface VECEvent {
  id?: number;
  timestamp: string;
  event_type: string;
  agent_id: string;
  task_id: string;
  message: string;
}

export interface QueueMessage {
  id?: string;
  from_agent?: string;
  to_agent?: string;
  task_id?: string;
  message: string;
  priority?: string;
  timestamp?: string;
  type?: string;
  subject?: string;
  sender?: string;
  text?: string;
}

export interface AgentProfile {
  agent_id: string;
  name: string;
  role: string;
  enabled_tools: string[];
  all_tools: string[];
}

export interface ErrorEntry {
  timestamp: string;
  agent_id: string;
  task_id: string;
  message: string;
  kind: string;
  label: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string }>;
  timestamp?: number;
}

/** Actual structure returned by /api/chat-log */
export interface ChatEntry {
  id: string;
  timestamp: string;
  from: string;  // "user" or agent key (pm / dev / ba)
  to: string;    // "user" or agent key
  message: string;
  channel: "cli" | "telegram" | "dashboard" | "agent";
}

export interface ChatAgent {
  key: string;
  name: string;
  role: string;
}

export interface MessageFlowEntry {
  from: string;
  to: string;
  priority: string;
  task_id: string;
  ts: string;
}

export interface AgentRuntimeEntry {
  agent_id: string;
  employee_id: string;
  name: string;
  template: string;
  status: "running" | "paused";
  enabled: boolean;
}

export interface RoleTemplateSummary {
  id: string;
  role: string;
  department: string;
  category: "pm" | "specialist";
  mandatory: boolean;
  default_skills: string[];
}
