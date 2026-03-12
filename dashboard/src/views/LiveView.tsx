import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { Monitor, Waypoints, Building2, ZoomIn, ZoomOut, RotateCcw, Navigation, StopCircle } from "lucide-react";
import { usePolling, postApi } from "../hooks/useApi";
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
function AgentTimelineCard({ name, role, items, active, color, agentKey }: {
  name: string; role: string; items: ActivityEntry[]; active: boolean; color: string; agentKey: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [steerMsg, setSteerMsg] = useState("");
  const [showSteer, setShowSteer] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items.length]);

  async function doSteer() {
    const msg = steerMsg.trim();
    if (!msg) return;
    setBusy("steer");
    try { await postApi("/api/steer", { agent_id: agentKey, message: msg }); setSteerMsg(""); setShowSteer(false); }
    catch (e) { console.error(e); }
    finally { setBusy(null); }
  }

  async function doInterrupt() {
    setBusy("interrupt");
    try { await postApi("/api/interrupt", { agent_id: agentKey, reason: "Interrupted via dashboard" }); }
    catch (e) { console.error(e); }
    finally { setBusy(null); }
  }

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
        {/* Steer + Interrupt buttons — only when active */}
        {active && (
          <>
            <button
              onClick={() => setShowSteer(!showSteer)}
              title="Steer agent"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, borderRadius: 5, border: "none", padding: 0,
                background: showSteer ? "var(--blue-bg)" : "transparent",
                color: showSteer ? "var(--blue)" : "var(--text-muted)",
                cursor: "pointer", transition: "all 0.1s",
              }}
            >
              <Navigation size={11} />
            </button>
            <button
              onClick={doInterrupt}
              disabled={busy === "interrupt"}
              title="Interrupt agent"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, borderRadius: 5, border: "none", padding: 0,
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer", transition: "all 0.1s",
                opacity: busy === "interrupt" ? 0.5 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--red)"; e.currentTarget.style.background = "var(--red-bg)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
            >
              <StopCircle size={11} />
            </button>
          </>
        )}
      </div>
      {/* Steer input bar */}
      {showSteer && (
        <div style={{
          display: "flex", gap: 6, padding: "6px 10px",
          borderBottom: "1px solid var(--border)", flexShrink: 0,
        }}>
          <input
            value={steerMsg}
            onChange={(e) => setSteerMsg(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSteer()}
            placeholder="Steer message..."
            autoFocus
            style={{
              flex: 1, fontSize: 11, padding: "5px 8px", borderRadius: 6,
              border: "1px solid var(--border)", background: "var(--bg-tertiary)",
              color: "var(--text-primary)", fontFamily: "inherit", outline: "none",
            }}
          />
          <button
            onClick={doSteer}
            disabled={busy === "steer" || !steerMsg.trim()}
            style={{
              fontSize: 11, padding: "5px 10px", borderRadius: 6, border: "none",
              background: "var(--accent)", color: "#fff", cursor: "pointer",
              fontFamily: "inherit", fontWeight: 500,
              opacity: busy === "steer" || !steerMsg.trim() ? 0.5 : 1,
            }}
          >
            Send
          </button>
        </div>
      )}
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
          agentKey={emp.agent_key}
        />
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ISOMETRIC OFFICE — Top-down isometric room with agents that
   sit at desks and roam between positions.
   ═══════════════════════════════════════════════════════════════════ */

const TILE = { w: 72, h: 36 };
const ROOM = { cols: 12, rows: 8 };

/** Convert grid (col, row) → screen (x, y) pixel position */
function g2s(col: number, row: number) {
  const ox = ROOM.rows * TILE.w / 2 + 60;
  const oy = 60 + WALL_H;
  return {
    x: ox + (col - row) * TILE.w / 2,
    y: oy + (col + row) * TILE.h / 2,
  };
}

const WALL_H = 80;
const FLOOR_W = (ROOM.cols + ROOM.rows) * TILE.w / 2 + 140;
const FLOOR_H = (ROOM.cols + ROOM.rows) * TILE.h / 2 + 180 + WALL_H;

/** Desk slot positions on the grid */
const DESK_SLOTS = [
  { col: 1, row: 1 }, { col: 2, row: 1 },                        // Management
  { col: 1, row: 3 }, { col: 2, row: 3 },                        // Product
  { col: 5, row: 1 }, { col: 6, row: 1 }, { col: 7, row: 1 },   // Engineering row 1
  { col: 5, row: 2 }, { col: 6, row: 2 }, { col: 7, row: 2 },   // Engineering row 2
  { col: 9, row: 1 }, { col: 10, row: 1 },                       // Analysis
  { col: 9, row: 3 }, { col: 10, row: 3 },                       // Design/Docs
  { col: 5, row: 4 }, { col: 6, row: 4 },                        // Governance
];

const COFFEE_SPOT = { col: 0, row: 6 };
const WANDER = [
  { col: 3, row: 0 }, { col: 8, row: 0 }, { col: 11, row: 0 },
  { col: 0, row: 4 }, { col: 11, row: 4 },
  { col: 3, row: 6 }, { col: 8, row: 6 },
];

/** SVG room with 3D walls + warm floor + grid lines */
function IsoRoom() {
  const tl = g2s(0, 0);                    // back corner (top of diamond)
  const tr = g2s(ROOM.cols, 0);            // right corner
  const br = g2s(ROOM.cols, ROOM.rows);    // front corner (bottom)
  const bl = g2s(0, ROOM.rows);            // left corner
  const floorPts = `${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`;

  // Grid lines
  const lines: JSX.Element[] = [];
  for (let r = 0; r <= ROOM.rows; r++) {
    const a = g2s(0, r), b = g2s(ROOM.cols, r);
    lines.push(<line key={`r${r}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />);
  }
  for (let c = 0; c <= ROOM.cols; c++) {
    const a = g2s(c, 0), b = g2s(c, ROOM.rows);
    lines.push(<line key={`c${c}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />);
  }

  // Door cutout position on left wall (near row 7)
  const doorBot = g2s(0, 7);
  const doorTop = g2s(0, 5.8);
  const doorH = 56;

  return (
    <svg style={{ position: "absolute", inset: 0, width: FLOOR_W, height: FLOOR_H, pointerEvents: "none" }}>
      {/* Back-left wall (from tl down to bl) */}
      <polygon
        points={`${tl.x},${tl.y} ${bl.x},${bl.y} ${bl.x},${bl.y - WALL_H} ${tl.x},${tl.y - WALL_H}`}
        fill="#7A7570"
      />
      {/* Door cutout (dark opening) */}
      <polygon
        points={`${doorTop.x},${doorTop.y} ${doorBot.x},${doorBot.y} ${doorBot.x},${doorBot.y - doorH} ${doorTop.x},${doorTop.y - doorH}`}
        fill="#2A2520"
      />
      {/* Back-right wall (from tl across to tr) */}
      <polygon
        points={`${tl.x},${tl.y} ${tr.x},${tr.y} ${tr.x},${tr.y - WALL_H} ${tl.x},${tl.y - WALL_H}`}
        fill="#908A84"
      />
      {/* Wall top caps (highlight) */}
      <line x1={tl.x} y1={tl.y - WALL_H} x2={bl.x} y2={bl.y - WALL_H}
        stroke="#B0A8A0" strokeWidth="2" />
      <line x1={tl.x} y1={tl.y - WALL_H} x2={tr.x} y2={tr.y - WALL_H}
        stroke="#C0B8B0" strokeWidth="2" />
      {/* Wall bottom edge (where walls meet floor) */}
      <line x1={tl.x} y1={tl.y} x2={bl.x} y2={bl.y}
        stroke="rgba(0,0,0,0.15)" strokeWidth="1" />
      <line x1={tl.x} y1={tl.y} x2={tr.x} y2={tr.y}
        stroke="rgba(0,0,0,0.15)" strokeWidth="1" />

      {/* Floor */}
      <polygon points={floorPts} fill="#C8B89A" />
      <polygon points={floorPts} fill="none" stroke="rgba(0,0,0,0.1)" strokeWidth="1" />

      {/* Grid lines */}
      <g stroke="rgba(0,0,0,0.07)" strokeWidth="0.5">{lines}</g>
    </svg>
  );
}

/** Isometric desk with monitor on top */
function IsoDesk({ col, row, occupied }: { col: number; row: number; occupied: boolean }) {
  const { x, y } = g2s(col, row);
  const w = 56, h = 28, d = 10;
  const topC = occupied ? "#A0906C" : "#888880";
  const leftC = occupied ? "#7A6C52" : "#666660";
  const rightC = occupied ? "#8F8170" : "#777770";
  // Monitor geometry (sits on desk top surface)
  const mw = 20, mh = 14, standH = 6;
  const mx = w / 2 - mw / 2 + 3; // offset slightly right on desk
  const my = -mh - standH + 2;   // above desk top apex
  const screenFill = occupied ? "rgba(100,180,255,0.35)" : "#1A1A1A";

  return (
    <div style={{
      position: "absolute", left: x - w / 2, top: y - h / 2 - mh - standH,
      width: w, height: h + d + mh + standH, pointerEvents: "none", zIndex: Math.floor(y),
    }}>
      <svg width={w} height={h + d + mh + standH} style={{ display: "block", overflow: "visible" }}>
        {/* Drop shadow */}
        <ellipse cx={w / 2} cy={h + d + mh + standH - 2} rx={w / 3} ry={4} fill="rgba(0,0,0,0.1)" />
        {/* Desk top */}
        <polygon points={`${w/2},${mh+standH} ${w},${h/2+mh+standH} ${w/2},${h+mh+standH} 0,${h/2+mh+standH}`}
          fill={topC} stroke="rgba(0,0,0,0.12)" strokeWidth="0.5" />
        {/* Desk left face */}
        <polygon points={`0,${h/2+mh+standH} ${w/2},${h+mh+standH} ${w/2},${h+d+mh+standH} 0,${h/2+d+mh+standH}`}
          fill={leftC} />
        {/* Desk right face */}
        <polygon points={`${w},${h/2+mh+standH} ${w/2},${h+mh+standH} ${w/2},${h+d+mh+standH} ${w},${h/2+d+mh+standH}`}
          fill={rightC} />
        {/* Monitor stand */}
        <rect x={w / 2 - 2 + 3} y={mh} width={4} height={standH} fill="#3A3A3A" rx={1} />
        {/* Monitor base */}
        <ellipse cx={w / 2 + 3} cy={mh + standH - 1} rx={6} ry={2} fill="#3A3A3A" />
        {/* Monitor bezel */}
        <rect x={mx} y={0} width={mw} height={mh} rx={1} fill="#2A2A2A" />
        {/* Screen */}
        <rect x={mx + 1.5} y={1.5} width={mw - 3} height={mh - 3} rx={0.5}
          fill={screenFill}
          className={occupied ? "iso-monitor-active" : undefined} />
        {occupied && (
          <line x1={mx + 2} y1={2} x2={mx + mw - 2} y2={2}
            stroke="rgba(150,200,255,0.5)" strokeWidth="0.5" />
        )}
      </svg>
    </div>
  );
}

const HAIR_COLORS = ["#3D2B1F", "#8B4513", "#F4C542", "#CC3333", "#555555", "#1A1A1A"];
function hashToHair(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return HAIR_COLORS[Math.abs(h) % HAIR_COLORS.length];
}

/** Pixel-art agent sprite (SVG, 22x38) */
function IsoSprite({ color, walking, agentKey }: { color: string; walking: boolean; agentKey: string }) {
  const hair = hashToHair(agentKey);
  return (
    <div className={walking ? "iso-walking" : undefined} style={{
      width: 22, height: 38, position: "relative",
    }}>
      <svg width={22} height={38} style={{ display: "block", overflow: "visible" }}>
        {/* Shadow */}
        <ellipse cx={11} cy={36} rx={8} ry={3} fill="rgba(0,0,0,0.15)" />
        {/* Left leg — pivots from hip */}
        <rect className={walking ? "iso-leg-l" : undefined} x={5} y={27} width={4} height={9} rx={1} fill="#3A3A4E" style={{ transformOrigin: "7px 27px" }} />
        {/* Right leg */}
        <rect className={walking ? "iso-leg-r" : undefined} x={13} y={27} width={4} height={9} rx={1} fill="#3A3A4E" style={{ transformOrigin: "15px 27px" }} />
        {/* Body / shirt */}
        <rect x={3} y={17} width={16} height={11} rx={2} fill={color} />
        {/* Left arm — swings opposite to right leg */}
        <rect className={walking ? "iso-arm-l" : undefined} x={0} y={18} width={3} height={9} rx={1} fill={color} opacity={0.85} style={{ transformOrigin: "1.5px 18px" }} />
        {/* Right arm — swings opposite to left leg */}
        <rect className={walking ? "iso-arm-r" : undefined} x={19} y={18} width={3} height={9} rx={1} fill={color} opacity={0.85} style={{ transformOrigin: "20.5px 18px" }} />
        {/* Neck */}
        <rect x={9} y={14} width={4} height={4} fill="#F0C8A0" />
        {/* Head */}
        <rect x={5} y={5} width={12} height={11} rx={3} fill="#F0C8A0" />
        {/* Hair */}
        <rect x={5} y={4} width={12} height={5} rx={2} fill={hair} />
        {/* Eyes */}
        <rect x={8} y={9} width={1.5} height={1.5} rx={0.5} fill="#2A2A2A" />
        <rect x={12.5} y={9} width={1.5} height={1.5} rx={0.5} fill="#2A2A2A" />
      </svg>
    </div>
  );
}

/** Positioned agent with name label + speech bubble */
function IsoAgent({ employee, col, row, walking, active, bubbleText, isToolUse }: {
  employee: Employee; col: number; row: number; walking: boolean;
  active: boolean; bubbleText: string; isToolUse: boolean;
}) {
  const { x, y } = g2s(col, row);
  const color = employee.color || "var(--text-muted)";
  return (
    <div style={{
      position: "absolute", left: x - 11, top: y - 50,
      transition: "left 2.5s ease-in-out, top 2.5s ease-in-out",
      zIndex: Math.floor(y) + 1,
      display: "flex", flexDirection: "column", alignItems: "center",
    }}>
      {active && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 4px)", left: "50%",
          transform: "translateX(-50%)",
          animation: "iso-bubble-in 0.2s ease-out forwards",
          maxWidth: 130, minWidth: 40,
          background: "var(--bg-card)", border: "1px solid var(--border)",
          borderLeft: `3px solid ${color}`,
          borderRadius: "6px 6px 6px 2px",
          padding: "3px 6px", fontSize: 9, lineHeight: "1.3",
          color: "var(--text-secondary)",
          fontFamily: isToolUse ? "monospace" : "inherit",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          boxShadow: "0 2px 6px rgba(0,0,0,0.2)", pointerEvents: "none",
        }}>
          {!bubbleText ? (
            <span style={{ display: "inline-flex", gap: 2 }}>
              <span className="office-typing-dot" /><span className="office-typing-dot" /><span className="office-typing-dot" />
            </span>
          ) : bubbleText.slice(-50).replace(/\n/g, " ")}
        </div>
      )}
      <IsoSprite color={color} walking={walking} agentKey={employee.agent_key} />
      {/* Dark name badge */}
      <div style={{
        marginTop: 3,
        background: "rgba(0,0,0,0.75)",
        borderRadius: 10,
        padding: "1px 6px",
        display: "flex", alignItems: "center", gap: 3,
        border: "1px solid rgba(255,255,255,0.08)",
      }}>
        <div style={{
          width: 5, height: 5, borderRadius: "50%",
          background: active ? color : "rgba(255,255,255,0.25)",
          boxShadow: active ? `0 0 4px ${color}` : "none",
        }} />
        <span style={{
          fontSize: 8, fontWeight: 700, color: "#fff",
          letterSpacing: "0.02em", whiteSpace: "nowrap",
        }}>
          {employee.name.split(" ")[0]}
        </span>
      </div>
    </div>
  );
}

/** Isometric office chair behind a desk */
function IsoChair({ col, row }: { col: number; row: number }) {
  // Offset chair slightly toward the viewer (south-east in iso)
  const { x, y } = g2s(col + 0.35, row + 0.55);
  const w = 22, h = 11, d = 5, backH = 14;
  return (
    <div style={{
      position: "absolute", left: x - w / 2, top: y - backH - h / 2,
      width: w, height: backH + h + d, pointerEvents: "none", zIndex: Math.floor(y) - 1,
    }}>
      <svg width={w} height={backH + h + d} style={{ display: "block" }}>
        {/* Chair legs (4 tiny lines) */}
        <line x1={3} y1={backH + h} x2={3} y2={backH + h + d} stroke="#888890" strokeWidth={1.5} />
        <line x1={w - 3} y1={backH + h} x2={w - 3} y2={backH + h + d} stroke="#888890" strokeWidth={1.5} />
        <line x1={w / 2 - 4} y1={backH + h + 1} x2={w / 2 - 4} y2={backH + h + d} stroke="#888890" strokeWidth={1} />
        <line x1={w / 2 + 4} y1={backH + h + 1} x2={w / 2 + 4} y2={backH + h + d} stroke="#888890" strokeWidth={1} />
        {/* Seat top */}
        <polygon points={`${w/2},${backH} ${w},${backH+h/2} ${w/2},${backH+h} 0,${backH+h/2}`}
          fill="#4A4A5A" />
        {/* Seat left */}
        <polygon points={`0,${backH+h/2} ${w/2},${backH+h} ${w/2},${backH+h+3} 0,${backH+h/2+3}`}
          fill="#38383E" />
        {/* Seat right */}
        <polygon points={`${w},${backH+h/2} ${w/2},${backH+h} ${w/2},${backH+h+3} ${w},${backH+h/2+3}`}
          fill="#424248" />
        {/* Backrest */}
        <rect x={2} y={0} width={w - 4} height={backH} rx={2} fill="#3A3A44" />
        <rect x={3} y={1} width={w - 6} height={backH - 2} rx={1} fill="#44444E" />
      </svg>
    </div>
  );
}

/** Coffee machine (SVG) */
function IsoCoffeeMachine() {
  const { x, y } = g2s(COFFEE_SPOT.col, COFFEE_SPOT.row);
  const w = 20, h = 10, d = 20;
  return (
    <div style={{
      position: "absolute", left: x - w / 2, top: y - d - h / 2,
      width: w, height: h + d + 8, pointerEvents: "none", zIndex: Math.floor(y),
    }}>
      <svg width={w} height={h + d + 8} style={{ display: "block", overflow: "visible" }}>
        {/* Steam particles */}
        <circle cx={10} cy={-2} r={2} fill="rgba(255,255,255,0.2)" className="iso-steam" />
        <circle cx={14} cy={-5} r={1.5} fill="rgba(255,255,255,0.15)" className="iso-steam-2" />
        {/* Machine body top */}
        <polygon points={`${w/2},0 ${w},${h/2} ${w/2},${h} 0,${h/2}`} fill="#5A5A5A" />
        {/* Machine body left */}
        <polygon points={`0,${h/2} ${w/2},${h} ${w/2},${h+d} 0,${h/2+d}`} fill="#404040" />
        {/* Machine body right */}
        <polygon points={`${w},${h/2} ${w/2},${h} ${w/2},${h+d} ${w},${h/2+d}`} fill="#4A4A4A" />
        {/* Screen on front-right face */}
        <rect x={w/2 + 2} y={h/2 + 3} width={6} height={4} rx={0.5} fill="rgba(0,150,255,0.3)" />
        {/* Spout */}
        <rect x={w/2 - 2} y={h + d - 3} width={4} height={3} fill="#333" rx={0.5} />
      </svg>
    </div>
  );
}

/** Decorative plant */
function IsoPlant({ col, row }: { col: number; row: number }) {
  const { x, y } = g2s(col, row);
  return (
    <div style={{
      position: "absolute", left: x - 10, top: y - 28,
      width: 20, height: 32, pointerEvents: "none", zIndex: Math.floor(y),
    }}>
      <svg width={20} height={32} style={{ display: "block" }}>
        {/* Pot */}
        <polygon points="5,22 15,22 14,28 6,28" fill="#8B6914" />
        <polygon points="4,20 16,20 15,22 5,22" fill="#A07818" />
        {/* Foliage (overlapping ellipses) */}
        <ellipse cx={10} cy={12} rx={8} ry={7} fill="#2D6A3F" />
        <ellipse cx={7} cy={8} rx={5} ry={5} fill="#3D8A50" />
        <ellipse cx={14} cy={10} rx={5} ry={4} fill="#1F4D2E" />
        <ellipse cx={10} cy={5} rx={4} ry={4} fill="#4CA060" />
      </svg>
    </div>
  );
}

/** Meeting table (hexagonal) */
function IsoMeetingTable({ col, row }: { col: number; row: number }) {
  const { x, y } = g2s(col, row);
  const rx = 44, ry = 22, d = 8;
  // Generate hex points for top face
  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    pts.push(`${rx + rx * Math.cos(a)},${ry + ry * Math.sin(a)}`);
  }
  return (
    <div style={{
      position: "absolute", left: x - rx, top: y - ry,
      width: rx * 2, height: ry * 2 + d, pointerEvents: "none", zIndex: Math.floor(y),
    }}>
      <svg width={rx * 2} height={ry * 2 + d} style={{ display: "block" }}>
        {/* Shadow */}
        <ellipse cx={rx} cy={ry * 2 + d - 2} rx={rx - 4} ry={6} fill="rgba(0,0,0,0.08)" />
        {/* Side (lower arc extruded) */}
        <path d={`M ${rx - rx * Math.cos(Math.PI/8)},${ry + ry * Math.sin(Math.PI/8)}
          L ${rx - rx * Math.cos(Math.PI/8)},${ry + ry * Math.sin(Math.PI/8) + d}
          Q ${rx},${ry * 2 + d + 4} ${rx + rx * Math.cos(Math.PI/8)},${ry + ry * Math.sin(Math.PI/8) + d}
          L ${rx + rx * Math.cos(Math.PI/8)},${ry + ry * Math.sin(Math.PI/8)} Z`}
          fill="#6B5940" />
        {/* Table top */}
        <polygon points={pts.join(" ")} fill="#8B7355" stroke="rgba(0,0,0,0.1)" strokeWidth="0.5" />
      </svg>
    </div>
  );
}

/** Sofa / couch */
function IsoSofa({ col, row }: { col: number; row: number }) {
  const { x, y } = g2s(col, row);
  const w = 52, h = 26, d = 8, backH = 14;
  return (
    <div style={{
      position: "absolute", left: x - w / 2, top: y - backH - h / 2,
      width: w, height: backH + h + d, pointerEvents: "none", zIndex: Math.floor(y),
    }}>
      <svg width={w} height={backH + h + d} style={{ display: "block" }}>
        {/* Backrest */}
        <polygon points={`${w/2},0 ${w},${h/2} ${w},${h/2+backH} ${w/2},${backH} 0,${h/2+backH} 0,${h/2}`}
          fill="#374151" />
        <polygon points={`${w/2},1 ${w-1},${h/2} ${w-1},${h/2+backH-1} ${w/2},${backH-1} 1,${h/2+backH-1} 1,${h/2}`}
          fill="#4A5568" />
        {/* Seat cushion top */}
        <polygon points={`${w/2},${backH} ${w},${h/2+backH} ${w/2},${h+backH} 0,${h/2+backH}`}
          fill="#5A6A7E" />
        {/* Seat left */}
        <polygon points={`0,${h/2+backH} ${w/2},${h+backH} ${w/2},${h+backH+d} 0,${h/2+backH+d}`}
          fill="#3E4C5E" />
        {/* Seat right */}
        <polygon points={`${w},${h/2+backH} ${w/2},${h+backH} ${w/2},${h+backH+d} ${w},${h/2+backH+d}`}
          fill="#4A5A6E" />
      </svg>
    </div>
  );
}

/** Office mode root — isometric floor with roaming agents */
function OfficeMode({ agents, activeAgents, tokens, activity }: {
  agents: Employee[];
  activeAgents: Record<string, boolean>;
  tokens: Record<string, string>;
  activity: ActivityEntry[];
  flow: MessageFlowEntry[];
}) {
  const assignments = useMemo(() => {
    const map = new Map<string, number>();
    agents.forEach((emp, i) => map.set(emp.agent_key, i % DESK_SLOTS.length));
    return map;
  }, [agents]);

  const [positions, setPositions] = useState<Map<string, { col: number; row: number; walking: boolean }>>(new Map());

  // Initialize agents at their desks
  useEffect(() => {
    const pos = new Map<string, { col: number; row: number; walking: boolean }>();
    agents.forEach((emp) => {
      const desk = DESK_SLOTS[assignments.get(emp.agent_key) ?? 0];
      pos.set(emp.agent_key, { col: desk.col, row: desk.row, walking: false });
    });
    setPositions(pos);
  }, [agents, assignments]);

  // Roaming timer — idle agents randomly wander, active agents stay at desk
  useEffect(() => {
    const timer = setInterval(() => {
      setPositions(prev => {
        const next = new Map(prev);
        for (const [key, pos] of next) {
          const deskIdx = assignments.get(key) ?? 0;
          const desk = DESK_SLOTS[deskIdx];
          if (activeAgents[key]) {
            // Active agents return to desk
            if (pos.col !== desk.col || pos.row !== desk.row) {
              next.set(key, { col: desk.col, row: desk.row, walking: true });
            } else if (pos.walking) {
              next.set(key, { ...pos, walking: false });
            }
            continue;
          }
          if (pos.walking) {
            // Just arrived — stop walking
            next.set(key, { ...pos, walking: false });
          } else if (Math.random() < 0.2) {
            // Pick a random destination
            const r = Math.random();
            const target = r < 0.1
              ? COFFEE_SPOT
              : r < 0.5
                ? WANDER[Math.floor(Math.random() * WANDER.length)]
                : desk; // return to desk
            next.set(key, { col: target.col, row: target.row, walking: true });
          }
        }
        return next;
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [activeAgents, assignments]);

  // Zoom + pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const clampZoom = (z: number) => Math.min(3, Math.max(0.3, z));

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => clampZoom(z + delta));
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    isPanning.current = true;
    panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [pan]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;
    setPan({
      x: panStart.current.panX + (e.clientX - panStart.current.x),
      y: panStart.current.panY + (e.clientY - panStart.current.y),
    });
  }, []);

  const handlePointerUp = useCallback(() => { isPanning.current = false; }, []);

  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      style={{
        flex: 1, overflow: "hidden", position: "relative",
        cursor: isPanning.current ? "grabbing" : "grab",
      }}
    >
      {/* Zoom controls */}
      <div style={{
        position: "absolute", top: 12, right: 12, zIndex: 20,
        display: "flex", flexDirection: "column", gap: 2,
        background: "var(--bg-secondary)", border: "1px solid var(--border)",
        borderRadius: 8, padding: 3,
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
      }}>
        <button onClick={() => setZoom(z => clampZoom(z + 0.15))} title="Zoom in"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-primary)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
        ><ZoomIn size={14} /></button>
        <div style={{ fontSize: 9, textAlign: "center", color: "var(--text-muted)", padding: "1px 0" }}>
          {Math.round(zoom * 100)}%
        </div>
        <button onClick={() => setZoom(z => clampZoom(z - 0.15))} title="Zoom out"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-primary)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
        ><ZoomOut size={14} /></button>
        <button onClick={resetView} title="Reset view"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-primary)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
        ><RotateCcw size={14} /></button>
      </div>

      {/* Zoomable + pannable floor */}
      <div style={{
        position: "relative",
        width: FLOOR_W, height: FLOOR_H,
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: "center center",
        transition: isPanning.current ? "none" : "transform 0.15s ease-out",
        margin: "20px auto",
      }}>
        <IsoRoom />
        {/* Furniture: plants, meeting table, sofa, coffee */}
        <IsoPlant col={4} row={0} />
        <IsoPlant col={11} row={2.5} />
        <IsoPlant col={0} row={5} />
        <IsoMeetingTable col={9} row={5.5} />
        <IsoSofa col={2} row={6.5} />
        <IsoCoffeeMachine />
        {/* Desks + chairs */}
        {DESK_SLOTS.map((slot, i) => {
          const occupied = agents.some((emp) => {
            const pos = positions.get(emp.agent_key);
            return pos && pos.col === slot.col && pos.row === slot.row;
          });
          return <IsoDesk key={`d${i}`} col={slot.col} row={slot.row} occupied={occupied} />;
        })}
        {DESK_SLOTS.map((slot, i) => (
          <IsoChair key={`c${i}`} col={slot.col} row={slot.row} />
        ))}
        {agents.map((emp) => {
          const pos = positions.get(emp.agent_key);
          if (!pos) return null;
          const isActive = activeAgents[emp.agent_key] ?? false;
          let bubbleText = "";
          let isToolUse = false;
          if (isActive) {
            const latest = getLatestActivity(activity, emp.agent_key);
            if (latest?.type === "tool_start") {
              bubbleText = latest.toolName ?? "tool";
              isToolUse = true;
            } else {
              bubbleText = tokens[emp.agent_key] ?? "";
            }
          }
          return (
            <IsoAgent
              key={emp.agent_key}
              employee={emp}
              col={pos.col}
              row={pos.row}
              walking={pos.walking}
              active={isActive}
              bubbleText={bubbleText}
              isToolUse={isToolUse}
            />
          );
        })}
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
