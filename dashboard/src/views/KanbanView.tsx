import { useState, useMemo } from "react";
import Markdown from "react-markdown";
import { usePolling } from "../hooks/useApi";
import { useAgentStream } from "../hooks/useSSE";
import { useEmployees } from "../context/EmployeesContext";
import Dropdown from "../components/Dropdown";
import type { Task, Employee, TaskStatus } from "../types";

const COLUMNS: { status: TaskStatus; label: string; color: string }[] = [
  { status: "todo",        label: "Todo",        color: "var(--text-muted)" },
  { status: "in_progress", label: "In Progress", color: "var(--blue)" },
  { status: "completed",   label: "Done",        color: "var(--green)" },
  { status: "failed",      label: "Failed",      color: "var(--red)" },
  { status: "cancelled",   label: "Cancelled",   color: "var(--text-muted)" },
];


function timeAgo(ts: string): string {
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function TaskCard({ task, employees, streaming }: { task: Task; employees: Employee[]; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const emp = employees.find((e) => e.agent_key === task.agent_id);
  const agentColor = emp?.color || "var(--text-muted)";

  return (
    <div
      className="vec-card task-card fade-in"
      onClick={() => setOpen((v) => !v)}
      style={{ padding: "8px 10px", marginBottom: 4 }}
    >
      {/* Top: task id + time */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace" }}>{task.task_id}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)" }}>{timeAgo(task.updated_at)}</span>
      </div>

      {/* Description — markdown */}
      <div
        className={open ? "md-content" : "md-content md-clamp"}
        style={{ marginBottom: 6 }}
      >
        <Markdown>{task.description}</Markdown>
      </div>

      {/* Expanded result — markdown */}
      {open && task.result && (
        <div className="md-content md-result" style={{ marginBottom: 6 }}>
          <Markdown>{task.result}</Markdown>
        </div>
      )}

      {/* Assigned to */}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <div style={{
          width: 16, height: 16, borderRadius: 4, background: agentColor, opacity: 0.85,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 8, fontWeight: 700, color: "#fff", flexShrink: 0,
        }}>
          {emp ? emp.name.charAt(0) : task.agent_id.charAt(0).toUpperCase()}
        </div>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)", fontWeight: 500 }}>
          {emp ? emp.name.split(" ")[0] : task.agent_id}
        </span>
        {streaming && task.status === "in_progress" && (
          <span style={{ fontSize: 9, color: "var(--blue)", fontWeight: 500, marginLeft: "auto" }}>working…</span>
        )}
      </div>
    </div>
  );
}

type AgentFilter = "all" | string;

export default function KanbanView() {
  const { data: tasks } = usePolling<Task[]>("/api/tasks", 3000);
  const { employees } = useEmployees();
  const { activeAgents } = useAgentStream();
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");

  const all = tasks ?? [];
  const emps = employees ?? [];
  const filtered = agentFilter === "all" ? all : all.filter((t) => t.agent_id === agentFilter);

  const agentKeys = Array.from(new Set(all.map((t) => t.agent_id)));

  const dropdownOptions = useMemo(() => [
    { value: "all", label: "All agents" },
    ...agentKeys.map((k) => {
      const emp = emps.find((e) => e.agent_key === k);
      return {
        value: k,
        label: emp ? emp.name : k,
        dot: (emp?.color ?? "").replace("var(--", "").replace(")", ""),
      };
    }),
  ], [agentKeys, emps]);

  // Minimum column height: header (~38px) + padding (12px) + one card (~80px)
  const hasAnyTasks = filtered.length > 0;
  const colMinHeight = hasAnyTasks ? 130 : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div className="page-header" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div>
          <h1 className="page-title">Kanban</h1>
          <div className="page-subtitle">{all.length} tasks</div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <Dropdown
            value={agentFilter}
            onChange={setAgentFilter}
            options={dropdownOptions}
            placeholder="All agents"
          />
        </div>
      </div>

      {/* Board */}
      <div style={{
        flex: 1, minHeight: 0,
        overflowX: "auto", overflowY: "hidden",
        padding: "12px 20px", display: "flex", gap: 10,
        alignItems: "flex-start",
      }}>
        {COLUMNS.map((col) => {
          const colTasks = filtered.filter((t) => t.status === col.status);

          return (
            <div key={col.status} style={{
              flex: 1, minWidth: 200,
              minHeight: colMinHeight,
              maxHeight: "100%",
              display: "flex", flexDirection: "column",
              background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8,
              overflow: "hidden",
            }}>
              {/* Column header */}
              <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: col.color, flexShrink: 0, opacity: 0.8 }} />
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)", flex: 1 }}>{col.label}</span>
                <span style={{ fontSize: 10, color: "var(--text-muted)", background: "var(--bg-tertiary)", padding: "1px 5px", borderRadius: 4 }}>
                  {colTasks.length}
                </span>
              </div>

              {/* Cards */}
              <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "8px 8px 4px" }}>
                {colTasks.length === 0 ? (
                  <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 11, padding: "20px 0" }}>No tasks</div>
                ) : colTasks.map((task) => (
                  <TaskCard
                    key={task.task_id}
                    task={task}
                    employees={emps}
                    streaming={activeAgents[task.agent_id] ?? false}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
