import { useState, useMemo } from "react";
import { Inbox, ChevronDown } from "lucide-react";
import { usePolling } from "../hooks/useApi";
import { useEmployees } from "../context/EmployeesContext";
import type { QueueMessage } from "../types";

function getInitials(name: string): string {
  const parts = name.split(" ");
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

export default function SnoopView() {
  const { employees } = useEmployees();
  const agents = useMemo(() => employees ?? [], [employees]);
  const [selected, setSelected] = useState("pm");
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: inbox, lastRefresh } = usePolling<QueueMessage[]>(
    `/api/inbox/${selected}`,
    3000
  );
  const messages = inbox ?? [];

  const selectedEmp = agents.find((e) => e.agent_key === selected);
  const selectedName = selectedEmp?.name ?? selected;
  const selectedColor = selectedEmp?.color ?? "var(--text-muted)";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div className="page-header" style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
      }}>
        <div>
          <div className="page-title">Snoop</div>
          <div className="page-subtitle">
            {messages.length} message{messages.length !== 1 ? "s" : ""} in inbox
            {lastRefresh && <span> · {lastRefresh.toLocaleTimeString()}</span>}
          </div>
        </div>

        {/* Agent picker */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "7px 14px", borderRadius: 20,
              border: "1px solid var(--border)", background: "var(--bg-tertiary)",
              cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 500,
              color: "var(--text-primary)", transition: "border-color 0.08s",
            }}
          >
            {/* Mini avatar */}
            <div style={{
              width: 22, height: 22, borderRadius: 6,
              background: selectedColor, opacity: 0.9,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 9, fontWeight: 600, color: "#fff",
            }}>
              {selectedEmp?.initials ?? getInitials(selectedName)}
            </div>
            <span>{selectedName}</span>
            <ChevronDown size={13} style={{
              color: "var(--text-muted)",
              transform: pickerOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.15s",
            }} />
          </button>

          {/* Dropdown */}
          {pickerOpen && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 50 }}
                onClick={() => setPickerOpen(false)}
              />
              <div style={{
                position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 51,
                background: "var(--bg-card)", border: "1px solid var(--border)",
                borderRadius: 10, padding: 4, width: 220, maxHeight: 320, overflowY: "auto",
                boxShadow: "var(--shadow-lg)",
              }}>
                {agents.map((emp) => {
                  const isActive = emp.agent_key === selected;
                  return (
                    <button
                      key={emp.agent_key}
                      onClick={() => { setSelected(emp.agent_key); setPickerOpen(false); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%",
                        padding: "7px 10px", border: "none", borderRadius: 7,
                        background: isActive ? "var(--bg-hover)" : "transparent",
                        color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                        cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                        fontWeight: isActive ? 500 : 400, textAlign: "left",
                        transition: "background 0.06s",
                      }}
                      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                    >
                      <div style={{
                        width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                        background: emp.color ?? "var(--text-muted)", opacity: 0.9,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, fontWeight: 600, color: "#fff",
                      }}>
                        {emp.initials ?? getInitials(emp.name)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12 }}>{emp.name}</div>
                        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>@{emp.agent_key}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Message list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 24px 20px" }}>
        {messages.length === 0 ? (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            height: "100%", gap: 8, color: "var(--text-muted)",
          }}>
            <Inbox size={32} style={{ opacity: 0.4 }} />
            <span style={{ fontSize: 13 }}>Inbox empty</span>
          </div>
        ) : (
          messages.map((msg, i) => {
            const text = msg.message ?? msg.text ?? JSON.stringify(msg);
            const from = msg.from_agent ?? msg.sender ?? "system";
            const to = msg.to_agent ?? "pm";
            const priority = msg.priority ?? "normal";
            const ts = msg.timestamp;
            const pColor = priority === "priority" ? "var(--red)"
              : priority === "high" ? "var(--yellow)"
              : "var(--text-muted)";
            const fromEmp = agents.find((e) => e.agent_key === from);

            return (
              <div key={i} style={{
                padding: "12px 0",
                borderBottom: i < messages.length - 1 ? "1px solid var(--border)" : "none",
                display: "flex", gap: 10, alignItems: "flex-start",
              }}>
                {/* Sender avatar */}
                <div style={{
                  width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                  background: fromEmp?.color ?? "var(--text-muted)", opacity: 0.85,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 600, color: "#fff",
                }}>
                  {fromEmp ? (fromEmp.initials ?? getInitials(fromEmp.name)) : from.slice(0, 2).toUpperCase()}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Meta row */}
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)" }}>
                      {fromEmp?.name ?? from}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>→</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "var(--accent)" }}>{to}</span>
                    {msg.task_id && (
                      <span style={{
                        fontSize: 10, fontFamily: "monospace", color: "var(--text-muted)",
                        background: "var(--bg-tertiary)", padding: "1px 5px", borderRadius: 3,
                      }}>
                        {msg.task_id}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 10, color: pColor, fontWeight: 500 }}>
                      {priority}
                    </span>
                    {ts && (
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                        {new Date(ts).toLocaleTimeString()}
                      </span>
                    )}
                  </div>

                  {/* Message body */}
                  <div style={{
                    fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55,
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                  }}>
                    {text}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
