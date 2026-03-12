import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { Monitor, Waypoints, Building2 } from "lucide-react";
import { usePolling } from "../hooks/useApi";
import { useAgentStream, type ActivityEntry } from "../hooks/useSSE";
import { useEmployees } from "../context/EmployeesContext";
import type { Employee, MessageFlowEntry } from "../types";
import NetworkPanel from "./NetworkView";

type Mode = "live" | "network" | "office";

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function getInitials(name: string): string {
  const parts = name.split(" ");
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function hexToRgb(hex: string): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return "255,255,255";
  const h = m[1];
  return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
}

function getLatestActivity(activity: ActivityEntry[], agentKey: string): ActivityEntry | null {
  for (let i = activity.length - 1; i >= 0; i--) {
    if (activity[i].agentId === agentKey) return activity[i];
  }
  return null;
}

/* ── Timeline item (dot + line + content) — used inside per-agent cards ── */
function TimelineItem({ entry, isLast, color }: { entry: ActivityEntry; isLast: boolean; color: string }) {
  const isToolStart = entry.type === "tool_start";
  const isToolEnd = entry.type === "tool_end";
  const isText = entry.type === "text";
  const isThinking = entry.type === "thinking";
  const isAgentEnd = entry.type === "agent_end";

  let label = "";
  let detail = "";

  if (isToolStart) {
    label = entry.toolName ?? "tool";
    if (entry.toolArgs) {
      const args = Object.entries(entry.toolArgs);
      if (args.length > 0) {
        detail = args.map(([k, v]) => {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          return `${k}: ${s && s.length > 50 ? s.slice(0, 47) + "..." : s}`;
        }).join(", ");
      }
    }
  } else if (isToolEnd) {
    label = `${entry.toolName ?? "tool"} ${entry.isError ? "failed" : "done"}`;
    if (entry.toolResult) {
      detail = entry.toolResult.length > 120 ? entry.toolResult.slice(0, 117) + "..." : entry.toolResult;
    }
  } else if (isText) {
    label = "output";
    detail = entry.content.length > 200 ? entry.content.slice(0, 197) + "..." : entry.content;
  } else if (isThinking) {
    label = "thinking";
    detail = entry.content.length > 120 ? entry.content.slice(0, 117) + "..." : entry.content;
  } else if (isAgentEnd) {
    label = "finished";
  }

  const dotSize = isToolStart ? 8 : isAgentEnd ? 7 : 5;
  const dotBg = isToolEnd
    ? (entry.isError ? "var(--red)" : "var(--green)")
    : isAgentEnd ? "var(--text-muted)" : color;
  const dotBorder = isToolStart ? `2px solid ${color}` : "none";
  const dotFill = isToolStart ? "transparent" : dotBg;

  return (
    <div style={{ display: "flex", gap: 0, minHeight: 24 }}>
      {/* Rail */}
      <div style={{ width: 24, display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <div style={{
          width: dotSize, height: dotSize, borderRadius: "50%",
          background: dotFill, border: dotBorder,
          marginTop: 5, flexShrink: 0,
          boxShadow: (isToolStart || isText) ? `0 0 5px ${color}` : "none",
        }} />
        {!isLast && (
          <div style={{ width: 1, flex: 1, minHeight: 6, background: "var(--border)" }} />
        )}
      </div>
      {/* Content */}
      <div style={{ flex: 1, paddingBottom: 4, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 5, flexWrap: "wrap" }}>
          <span style={{
            fontSize: 11, fontWeight: 500,
            color: isToolEnd && entry.isError ? "var(--red)" : "var(--text-primary)",
          }}>
            {label}
          </span>
          <span style={{ fontSize: 9, color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0 }}>
            {timeStr(entry.timestamp)}
          </span>
        </div>
        {detail && (
          <div style={{
            fontSize: 10, color: "var(--text-muted)", lineHeight: 1.4,
            marginTop: 1,
            fontFamily: isText || isThinking ? "inherit" : "'Cascadia Code', 'Fira Code', monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            maxHeight: 48, overflow: "hidden",
          }}>
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Per-agent card with timeline inside ── */
function AgentTimelineCard({ name, role, items, active, color }: {
  name: string; role: string; items: ActivityEntry[]; active: boolean; color: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items.length]);

  return (
    <div style={{
      background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
      display: "flex", flexDirection: "column", overflow: "hidden",
      minHeight: 160, maxHeight: 360,
    }}>
      <div style={{
        padding: "7px 12px", borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: "50%",
          background: active ? color : "var(--text-muted)",
          opacity: active ? 1 : 0.3,
          boxShadow: active ? `0 0 6px ${color}` : "none",
        }} />
        <span style={{ fontSize: 12, fontWeight: 600, color }}>{name}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{role}</span>
        <span style={{
          marginLeft: "auto", fontSize: 9, fontWeight: 500,
          color: active ? "var(--blue)" : "var(--text-muted)",
        }}>
          {active ? "streaming" : "idle"}
        </span>
      </div>
      <div ref={scrollRef} style={{
        flex: 1, overflowY: "auto", padding: "8px 10px 6px",
        background: "var(--bg-tertiary)",
      }}>
        {items.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 11, padding: "12px 0", textAlign: "center" }}>
            No activity yet
          </div>
        ) : (
          items.map((entry, i) => (
            <TimelineItem key={entry.id} entry={entry} isLast={i === items.length - 1} color={color} />
          ))
        )}
      </div>
    </div>
  );
}

/* ── Live Mode: per-agent cards with dot-and-line timeline inside ── */
function LiveMode({ activity, activeAgents, agents }: {
  activity: ActivityEntry[]; activeAgents: Record<string, boolean>; agents: Employee[];
}) {
  const items = activity.filter((e) =>
    e.type === "text" || e.type === "tool_start" || e.type === "tool_end" ||
    e.type === "thinking" || e.type === "agent_end"
  );

  const byAgent = new Map<string, ActivityEntry[]>();
  for (const entry of items) {
    const list = byAgent.get(entry.agentId) ?? [];
    list.push(entry);
    byAgent.set(entry.agentId, list);
  }

  const sorted = [...agents].sort((a, b) => {
    const aActive = activeAgents[a.agent_key] ? 1 : 0;
    const bActive = activeAgents[b.agent_key] ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aHas = byAgent.has(a.agent_key) ? 1 : 0;
    const bHas = byAgent.has(b.agent_key) ? 1 : 0;
    return bHas - aHas;
  });

  return (
    <div style={{
      flex: 1, overflowY: "auto", padding: "12px 20px 60px",
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
      gap: 10, alignContent: "start",
    }}>
      {sorted.map((emp) => (
        <AgentTimelineCard
          key={emp.agent_key}
          name={emp.name.split(" ")[0]}
          role={emp.role}
          items={byAgent.get(emp.agent_key) ?? []}
          active={activeAgents[emp.agent_key] ?? false}
          color={emp.color || "var(--text-muted)"}
        />
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   OFFICE MODE — Virtual office floor with desks, speech bubbles,
   and animated message flow lines between agents.
   ═══════════════════════════════════════════════════════════════════ */

const DEPT_ORDER = ["Management", "Product", "Engineering", "Analysis", "Design", "Documentation", "Governance"];
const DEPT_COLOR: Record<string, string> = {
  Management: "var(--blue)", Product: "var(--purple)", Engineering: "var(--green)",
  Analysis: "var(--yellow)", Design: "var(--purple)", Documentation: "var(--orange)",
  Governance: "var(--red)",
};

/* ── Speech bubble above active desks ── */
function SpeechBubble({ text, color, isToolUse }: {
  text: string; color: string; isToolUse: boolean;
}) {
  return (
    <div style={{
      position: "absolute",
      bottom: "calc(100% + 8px)",
      left: "50%",
      animation: "office-bubble-in 0.18s ease-out forwards",
      zIndex: 10,
      maxWidth: 170, minWidth: 50,
      background: "var(--bg-card)",
      border: "1px solid var(--border)",
      borderLeft: `3px solid ${color}`,
      borderRadius: "6px 6px 6px 2px",
      padding: "5px 8px",
      fontSize: 10, lineHeight: 1.4,
      color: "var(--text-secondary)",
      fontFamily: isToolUse ? "'Cascadia Code', 'Fira Code', monospace" : "inherit",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
      pointerEvents: "none",
    }}>
      {/* Triangle pointer */}
      <div style={{
        position: "absolute", bottom: -5, left: "50%", transform: "translateX(-50%)",
        width: 0, height: 0,
        borderLeft: "5px solid transparent", borderRight: "5px solid transparent",
        borderTop: "5px solid var(--border)",
      }} />
      <div style={{
        position: "absolute", bottom: -3, left: "50%", transform: "translateX(-50%)",
        width: 0, height: 0,
        borderLeft: "4px solid transparent", borderRight: "4px solid transparent",
        borderTop: "4px solid var(--bg-card)",
      }} />
      {!text.trim() ? (
        <span style={{ display: "inline-flex", gap: 3, alignItems: "center", padding: "1px 0" }}>
          <span className="office-typing-dot" />
          <span className="office-typing-dot" />
          <span className="office-typing-dot" />
        </span>
      ) : (
        <span>{text.slice(-60).replace(/\n/g, " ")}</span>
      )}
    </div>
  );
}

/* ── Single desk with avatar, chair, status dot ── */
function AgentDesk({ employee, active, latestActivity, tokenPreview, onRef }: {
  employee: Employee; active: boolean;
  latestActivity: ActivityEntry | null; tokenPreview: string;
  onRef: (el: HTMLDivElement | null) => void;
}) {
  const color = employee.color || "var(--text-muted)";
  const rgb = employee.color ? hexToRgb(employee.color) : "255,255,255";
  const initials = employee.initials ?? getInitials(employee.name);

  let bubbleText = "";
  let isToolUse = false;
  if (active && latestActivity) {
    if (latestActivity.type === "tool_start") {
      bubbleText = latestActivity.toolName ?? "tool";
      isToolUse = true;
    } else {
      bubbleText = tokenPreview;
    }
  }

  return (
    <div
      ref={onRef}
      style={{
        position: "relative", width: 80,
        display: "flex", flexDirection: "column", alignItems: "center",
      }}
    >
      {/* Speech bubble */}
      {active && (
        <SpeechBubble text={bubbleText} color={color} isToolUse={isToolUse} />
      )}

      {/* Desk surface */}
      <div style={{
        position: "relative", width: 80, height: 52,
        background: "var(--bg-card)", border: "1px solid var(--border)",
        borderRadius: 6,
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: active ? `0 0 12px ${color}22` : "none",
        transition: "box-shadow 0.3s",
      }}>
        {/* Avatar */}
        <div style={{
          width: 32, height: 32, borderRadius: "50%",
          background: color,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 700, color: "#fff",
          ...(active ? {
            "--color-rgb": rgb,
            animation: "office-avatar-pulse 1.8s ease-out infinite",
          } as React.CSSProperties : {}),
        }}>
          {initials}
        </div>

        {/* Status dot */}
        <div
          className={active ? "office-status-active" : undefined}
          style={{
            position: "absolute", top: 5, right: 5,
            width: 6, height: 6, borderRadius: "50%",
            ...(!active ? { background: "var(--text-muted)", opacity: 0.25 } : {}),
          }}
        />
      </div>

      {/* Chair nub */}
      <div style={{
        width: 28, height: 8,
        background: "var(--bg-tertiary)",
        borderRadius: "0 0 5px 5px",
        border: "1px solid var(--border)",
        borderTop: "none",
        marginTop: -1,
      }} />

      {/* Name label */}
      <div style={{
        marginTop: 4, fontSize: 9, fontWeight: 500,
        color: active ? "var(--text-primary)" : "var(--text-muted)",
        textAlign: "center", whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis",
        maxWidth: 80, transition: "color 0.3s",
      }}>
        {employee.name.split(" ")[0]}
      </div>
    </div>
  );
}

/* ── Department zone with labeled border ── */
function DepartmentZone({ name, color, agents, activeAgents, tokens, activity, onDeskRef }: {
  name: string; color: string; agents: Employee[];
  activeAgents: Record<string, boolean>; tokens: Record<string, string>;
  activity: ActivityEntry[];
  onDeskRef: (key: string, el: HTMLDivElement | null) => void;
}) {
  return (
    <div style={{
      position: "relative",
      border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      borderRadius: 10,
      padding: "24px 14px 14px",
      background: `color-mix(in srgb, ${color} 4%, transparent)`,
      flexShrink: 0,
    }}>
      {/* Zone label */}
      <div style={{
        position: "absolute", top: -9, left: 12,
        background: "var(--bg-primary)",
        padding: "0 6px",
        fontSize: 10, fontWeight: 700, letterSpacing: "0.05em",
        textTransform: "uppercase" as const,
        color: color,
      }}>
        {name}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, minWidth: 80 }}>
        {agents.map((emp) => (
          <AgentDesk
            key={emp.agent_key}
            employee={emp}
            active={activeAgents[emp.agent_key] ?? false}
            latestActivity={getLatestActivity(activity, emp.agent_key)}
            tokenPreview={tokens[emp.agent_key] ?? ""}
            onRef={(el) => onDeskRef(emp.agent_key, el)}
          />
        ))}
      </div>
    </div>
  );
}

/* ── SVG overlay for message flow lines ── */
function OfficeSvgOverlay({ flow, deskPositions, containerRef }: {
  flow: MessageFlowEntry[];
  deskPositions: Map<string, { cx: number; cy: number }>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const now = Date.now();
  const WINDOW = 20_000;

  // Deduplicate: newest per from→to pair
  const deduped = new Map<string, MessageFlowEntry>();
  for (const f of flow) {
    const k = `${f.from}->${f.to}`;
    const prev = deduped.get(k);
    if (!prev || new Date(f.ts).getTime() > new Date(prev.ts).getTime()) {
      deduped.set(k, f);
    }
  }

  const lines: JSX.Element[] = [];
  for (const [key, f] of deduped) {
    const age = now - new Date(f.ts).getTime();
    if (age >= WINDOW) continue;
    const from = deskPositions.get(f.from);
    const to = deskPositions.get(f.to);
    if (!from || !to) continue;

    const opacity = Math.max(0, 1 - age / WINDOW);
    lines.push(
      <line
        key={key}
        x1={from.cx} y1={from.cy} x2={to.cx} y2={to.cy}
        stroke="var(--text-muted)"
        strokeWidth="1.5"
        strokeDasharray="4 3"
        opacity={opacity}
        className="office-flow-line"
        markerEnd="url(#office-arrow)"
      />
    );
  }

  if (lines.length === 0) return null;

  return (
    <svg style={{
      position: "absolute", inset: 0, zIndex: 5,
      width: "100%", height: "100%",
      pointerEvents: "none", overflow: "visible",
    }}>
      <defs>
        <marker id="office-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="var(--text-muted)" opacity="0.5" />
        </marker>
      </defs>
      {lines}
    </svg>
  );
}

/* ── Office Mode root ── */
function OfficeMode({ agents, activeAgents, tokens, activity, flow }: {
  agents: Employee[];
  activeAgents: Record<string, boolean>;
  tokens: Record<string, string>;
  activity: ActivityEntry[];
  flow: MessageFlowEntry[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const deskRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [deskPositions, setDeskPositions] = useState<Map<string, { cx: number; cy: number }>>(new Map());

  const departments = useMemo(() => {
    const map = new Map<string, Employee[]>();
    for (const emp of agents) {
      const dept = emp.department ?? "Other";
      if (!map.has(dept)) map.set(dept, []);
      map.get(dept)!.push(emp);
    }
    return [...map.entries()].sort(([a], [b]) => {
      const ai = DEPT_ORDER.indexOf(a), bi = DEPT_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [agents]);

  const recalcPositions = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const cr = container.getBoundingClientRect();
    const next = new Map<string, { cx: number; cy: number }>();
    for (const [key, el] of deskRefs.current) {
      const r = el.getBoundingClientRect();
      next.set(key, {
        cx: r.left - cr.left + r.width / 2 + container.scrollLeft,
        cy: r.top - cr.top + r.height / 2 + container.scrollTop,
      });
    }
    setDeskPositions(next);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const obs = new ResizeObserver(recalcPositions);
    obs.observe(container);
    recalcPositions();
    return () => obs.disconnect();
  }, [recalcPositions]);

  useEffect(() => { recalcPositions(); }, [agents.length, recalcPositions]);

  const handleDeskRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) deskRefs.current.set(key, el);
    else deskRefs.current.delete(key);
  }, []);

  // Recalc positions when desks finish rendering
  useEffect(() => {
    const t = setTimeout(recalcPositions, 100);
    return () => clearTimeout(t);
  }, [departments, recalcPositions]);

  return (
    <div
      ref={containerRef}
      className="office-floor"
      style={{
        flex: 1, overflowY: "auto", overflowX: "hidden",
        padding: "28px 24px 60px",
        position: "relative",
      }}
    >
      <OfficeSvgOverlay
        flow={flow}
        deskPositions={deskPositions}
        containerRef={containerRef}
      />

      <div style={{
        display: "flex", flexWrap: "wrap", gap: 20,
        alignItems: "flex-start",
        position: "relative", zIndex: 1,
      }}>
        {departments.map(([dept, emps]) => (
          <DepartmentZone
            key={dept}
            name={dept}
            color={DEPT_COLOR[dept] ?? "var(--text-muted)"}
            agents={emps}
            activeAgents={activeAgents}
            tokens={tokens}
            activity={activity}
            onDeskRef={handleDeskRef}
          />
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TAB BAR + MAIN VIEW
   ═══════════════════════════════════════════════════════════════════ */

const TABS: { id: Mode; label: string; icon: React.ReactNode }[] = [
  { id: "live",    label: "Live",    icon: <Monitor size={14} /> },
  { id: "network", label: "Network", icon: <Waypoints size={14} /> },
  { id: "office",  label: "Office",  icon: <Building2 size={14} /> },
];

function ModeBar({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div style={{
      position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
      display: "flex", gap: 2,
      background: "var(--bg-secondary)", border: "1px solid var(--border)",
      borderRadius: 10, padding: 3,
      zIndex: 10,
      boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
    }}>
      {TABS.map((tab) => {
        const isActive = mode === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => setMode(tab.id)}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "5px 12px", borderRadius: 8, border: "none",
              background: isActive ? "var(--bg-hover)" : "transparent",
              color: isActive ? "var(--text-primary)" : "var(--text-muted)",
              fontSize: 11, fontWeight: isActive ? 500 : 400,
              cursor: "pointer", fontFamily: "inherit",
              transition: "background 0.08s, color 0.08s",
            }}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Main LiveView ── */
export default function LiveView() {
  const [mode, setMode] = useState<Mode>("live");
  const { tokens, activity, connected, activeAgents } = useAgentStream();
  const { employees } = useEmployees();
  const { data: flowData } = usePolling<MessageFlowEntry[]>("/api/message-flow", 3000);
  const emps = employees ?? [];
  const flow = flowData ?? [];

  const activeCount = Object.keys(activeAgents).filter((k) => activeAgents[k]).length;
  const agents = emps.length > 0
    ? emps
    : Object.keys(tokens).map((k) => ({ employee_id: k, name: k, role: "", agent_key: k, status: "available" }));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative" }}>
      <div className="page-header">
        <h1 className="page-title">Live</h1>
        <div className="page-subtitle">
          {connected ? "Connected" : "Disconnected"} · {activeCount} active
        </div>
      </div>

      {mode === "live" && <LiveMode activity={activity} activeAgents={activeAgents} agents={agents} />}
      {mode === "network" && <NetworkPanel />}
      {mode === "office" && (
        <OfficeMode
          agents={agents}
          activeAgents={activeAgents}
          tokens={tokens}
          activity={activity}
          flow={flow}
        />
      )}

      <ModeBar mode={mode} setMode={setMode} />
    </div>
  );
}
