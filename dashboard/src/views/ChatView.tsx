import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ArrowUp, Search, X, Plus, Users, Trash2, Edit3, Check } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePolling, postApi } from "../hooks/useApi";
import { useAgentStream } from "../hooks/useSSE";
import { useEmployees } from "../context/EmployeesContext";
import type { ChatEntry, Employee } from "../types";

const SYSTEM_PREFIXES = ["SUNSET_COMPLETE", "SUNRISE_", "NO_ACTION_REQUIRED", "MEMORY_UPDATED", "JOURNAL_"];

// ── Group types ──────────────────────────────────────────────────────────────

interface AgentGroup {
  id: string;
  name: string;
  members: string[];
  color: string;
}

const GROUP_COLORS = ["#6366f1", "#f43f5e", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#ef4444"];
const STORAGE_KEY = "vec-agent-groups";

function loadGroups(): AgentGroup[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}
function saveGroups(groups: AgentGroup[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

function timeLabel(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function ChatView() {
  const [selectedAgent, setSelectedAgent] = useState("pm");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [agentSearch, setAgentSearch] = useState("");
  const [sidebarTab, setSidebarTab] = useState<"agents" | "groups">("agents");
  const [groups, setGroups] = useState<AgentGroup[]>(loadGroups);
  const [showCreateGroup, setShowCreateGroup] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { data: allEntries, refresh } = usePolling<ChatEntry[]>("/api/chat-log", 2000);
  const { employees } = useEmployees();
  const { activeAgents } = useAgentStream();

  const agents = useMemo(() => {
    const emps = employees ?? [];
    return emps.filter((e) => e.agent_key !== "user");
  }, [employees]);

  // Filtered agents for search
  const filteredAgents = useMemo(() => {
    if (!agentSearch.trim()) return agents;
    const q = agentSearch.toLowerCase();
    return agents.filter((a) =>
      a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q) || a.agent_key.toLowerCase().includes(q)
    );
  }, [agents, agentSearch]);

  // Persist groups
  useEffect(() => { saveGroups(groups); }, [groups]);

  // ── Selection helpers ──────────────────────────────────────────────────────

  const activeGroup = selectedGroupId ? groups.find((g) => g.id === selectedGroupId) ?? null : null;
  const isGroupMode = activeGroup !== null;

  function selectAgent(key: string) {
    setSelectedAgent(key);
    setSelectedGroupId(null);
  }
  function selectGroup(id: string) {
    setSelectedGroupId(id);
  }

  // ── Individual agent info ──────────────────────────────────────────────────

  const selectedEmp = agents.find((a) => a.agent_key === selectedAgent);
  const agentName = selectedEmp?.name ?? selectedAgent;
  const agentRole = selectedEmp?.role ?? "";
  const agentColor = selectedEmp?.color || "var(--text-muted)";
  const agentInitials = selectedEmp?.initials || (selectedEmp ? getInitials(selectedEmp.name) : selectedAgent.slice(0, 2).toUpperCase());

  // ── Entries for individual agent ───────────────────────────────────────────

  const entries = (allEntries ?? []).filter((e) => {
    if (isGroupMode) {
      const members = activeGroup!.members;
      const match = (e.from === "user" && members.includes(e.to)) || (members.includes(e.from) && e.to === "user");
      if (!match) return false;
    } else {
      if (!(e.from === "user" && e.to === selectedAgent) && !(e.from === selectedAgent && e.to === "user")) return false;
    }
    return !SYSTEM_PREFIXES.some((p) => (e.message ?? "").trim().startsWith(p));
  });

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter((e) => e.message.toLowerCase().includes(q));
  }, [entries, searchQuery]);

  const displayEntries = searchOpen ? filteredEntries : entries;

  const lastMsg = useCallback(
    (key: string) => (allEntries ?? [])
      .filter((e) => {
        if (!(e.from === key && e.to === "user") && !(e.from === "user" && e.to === key)) return false;
        return !SYSTEM_PREFIXES.some((p) => (e.message ?? "").trim().startsWith(p));
      }).slice(-1)[0],
    [allEntries]
  );

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [entries.length, selectedAgent, selectedGroupId]);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  // ── Send ───────────────────────────────────────────────────────────────────

  async function send() {
    const msg = input.trim();
    if (!msg || sending) return;
    setSending(true); setInput("");
    try {
      if (isGroupMode) {
        await Promise.all(activeGroup!.members.map((key) => postApi("/api/send-message", { to: key, message: msg })));
      } else {
        await postApi("/api/send-message", { to: selectedAgent, message: msg });
      }
      await refresh();
    } catch { setInput(msg); }
    finally { setSending(false); inputRef.current?.focus(); }
  }

  const isTyping = isGroupMode
    ? activeGroup!.members.some((m) => activeAgents[m])
    : (activeAgents[selectedAgent] ?? false);

  // ── Group CRUD ─────────────────────────────────────────────────────────────

  function createGroup(name: string, members: string[], color: string) {
    const g: AgentGroup = { id: crypto.randomUUID(), name, members, color };
    setGroups((prev) => [...prev, g]);
    setShowCreateGroup(false);
    selectGroup(g.id);
  }
  function deleteGroup(id: string) {
    setGroups((prev) => prev.filter((g) => g.id !== id));
    if (selectedGroupId === id) { setSelectedGroupId(null); setSelectedAgent("pm"); }
  }

  // ── Helper: get employee for agent key ─────────────────────────────────────

  function empFor(key: string): Employee | undefined {
    return agents.find((a) => a.agent_key === key);
  }

  // ── Chat header info for group mode ────────────────────────────────────────

  const chatHeaderName = isGroupMode ? activeGroup!.name : agentName;
  const chatHeaderSub = isGroupMode
    ? `${activeGroup!.members.length} members${isTyping ? " — someone is typing..." : ""}`
    : (isTyping ? "typing..." : agentRole);
  const chatHeaderColor = isGroupMode ? activeGroup!.color : agentColor;
  const chatHeaderInitials = isGroupMode ? activeGroup!.name.slice(0, 2).toUpperCase() : agentInitials;

  // ── Placeholder name for input ─────────────────────────────────────────────

  const inputPlaceholder = isGroupMode ? `Message ${activeGroup!.name}...` : `Message ${agentName.split(" ")[0]}...`;

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Sidebar ── */}
      <div style={{
        width: 270, flexShrink: 0,
        borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column",
      }}>
        <div className="page-header" style={{ paddingBottom: 8 }}>
          <div className="page-title">Chat</div>
          <div className="page-subtitle">Direct messages with agents</div>
        </div>

        {/* Tabs: Agents | Groups */}
        <div style={{
          display: "flex", gap: 0, padding: "0 12px 8px",
          borderBottom: "1px solid var(--border)",
        }}>
          {(["agents", "groups"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setSidebarTab(tab)}
              style={{
                flex: 1, padding: "6px 0", border: "none",
                background: "transparent", cursor: "pointer", fontFamily: "inherit",
                fontSize: 12, fontWeight: sidebarTab === tab ? 600 : 400,
                color: sidebarTab === tab ? "var(--accent)" : "var(--text-muted)",
                borderBottom: sidebarTab === tab ? "2px solid var(--accent)" : "2px solid transparent",
                transition: "all 0.15s",
              }}
            >
              {tab === "agents" ? "Agents" : "Groups"}
            </button>
          ))}
        </div>

        {/* ── Agents tab ── */}
        {sidebarTab === "agents" && (
          <>
            {/* Agent search */}
            <div style={{ padding: "8px 12px 4px" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                background: "var(--bg-tertiary)", border: "1px solid var(--border)",
                borderRadius: 18, padding: "5px 12px",
              }}>
                <Search size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                <input
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder="Search agents..."
                  style={{
                    flex: 1, border: "none", outline: "none",
                    background: "transparent", color: "var(--text-primary)",
                    fontSize: 12, fontFamily: "inherit",
                  }}
                />
                {agentSearch && (
                  <button
                    onClick={() => setAgentSearch("")}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", padding: 0 }}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </div>

            {/* Agent list */}
            <div style={{ flex: 1, overflowY: "auto", padding: "4px 10px 10px" }}>
              {filteredAgents.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
                  No agents match "{agentSearch}"
                </div>
              ) : (
                filteredAgents.map((ag) => {
                  const sel = !isGroupMode && selectedAgent === ag.agent_key;
                  const last = lastMsg(ag.agent_key);
                  const typing = activeAgents[ag.agent_key] ?? false;
                  const color = ag.color || "var(--text-muted)";
                  const initials = ag.initials || getInitials(ag.name);

                  return (
                    <button
                      key={ag.agent_key}
                      onClick={() => selectAgent(ag.agent_key)}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", gap: 12,
                        padding: "10px 12px", border: "none", borderRadius: 10,
                        background: sel ? "var(--bg-hover)" : "transparent",
                        cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                        transition: "background 0.08s", marginBottom: 2,
                      }}
                      onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = "transparent"; }}
                    >
                      <div style={{
                        width: 36, height: 36, borderRadius: 10,
                        background: color, opacity: 0.9,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 600, color: "#fff", flexShrink: 0,
                      }}>
                        {initials}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: sel ? 600 : 500, color: "var(--text-primary)" }}>
                            {ag.name.split(" ")[0]}
                          </span>
                          {last && (
                            <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>
                              {timeLabel(last.timestamp)}
                            </span>
                          )}
                        </div>
                        <div style={{
                          fontSize: 12, color: typing ? "var(--green)" : "var(--text-muted)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          marginTop: 1,
                        }}>
                          {typing ? "typing..." : last ? `${last.from === "user" ? "You: " : ""}${last.message.slice(0, 36)}` : ag.role}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* ── Groups tab ── */}
        {sidebarTab === "groups" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
            {/* Create group button */}
            <button
              onClick={() => setShowCreateGroup(true)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "10px 12px", border: "1px dashed var(--border)", borderRadius: 10,
                background: "transparent", cursor: "pointer", fontFamily: "inherit",
                color: "var(--text-muted)", fontSize: 13, width: "100%",
                transition: "all 0.1s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <Plus size={16} />
              New Group
            </button>

            {groups.length === 0 && (
              <div style={{ padding: "24px 12px", textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
                No groups yet. Create one to broadcast messages to multiple agents.
              </div>
            )}

            {groups.map((g) => {
              const sel = selectedGroupId === g.id;
              return (
                <button
                  key={g.id}
                  onClick={() => selectGroup(g.id)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 12,
                    padding: "10px 12px", border: "none", borderRadius: 10,
                    background: sel ? "var(--bg-hover)" : "transparent",
                    cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                    transition: "background 0.08s",
                  }}
                  onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = "transparent"; }}
                >
                  <div style={{
                    width: 36, height: 36, borderRadius: 10,
                    background: g.color, opacity: 0.9,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, color: "#fff", flexShrink: 0,
                  }}>
                    <Users size={16} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: sel ? 600 : 500, color: "var(--text-primary)" }}>
                      {g.name}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>
                      {g.members.length} member{g.members.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteGroup(g.id); }}
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      color: "var(--text-muted)", padding: 4, display: "flex",
                      borderRadius: 6, transition: "color 0.1s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--red, #ef4444)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
                    title="Delete group"
                  >
                    <Trash2 size={13} />
                  </button>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Chat area ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Chat header */}
        <div style={{
          padding: "14px 24px",
          borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
        }}>
          {isGroupMode ? (
            <>
              <div style={{
                width: 32, height: 32, borderRadius: 9,
                background: chatHeaderColor, opacity: 0.9,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff",
              }}>
                <Users size={15} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{chatHeaderName}</div>
                <div style={{ fontSize: 12, color: isTyping ? "var(--green)" : "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                  {chatHeaderSub}
                  {/* Stacked member avatars */}
                  <span style={{ display: "flex", marginLeft: 4 }}>
                    {activeGroup!.members.slice(0, 5).map((m, i) => {
                      const emp = empFor(m);
                      return (
                        <span
                          key={m}
                          title={emp?.name ?? m}
                          style={{
                            width: 18, height: 18, borderRadius: 5,
                            background: emp?.color || "var(--text-muted)",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            fontSize: 8, fontWeight: 700, color: "#fff",
                            marginLeft: i === 0 ? 0 : -5,
                            border: "1.5px solid var(--bg-primary)",
                            zIndex: 5 - i,
                          }}
                        >
                          {emp?.initials || m.slice(0, 2).toUpperCase()}
                        </span>
                      );
                    })}
                    {activeGroup!.members.length > 5 && (
                      <span style={{
                        width: 18, height: 18, borderRadius: 5,
                        background: "var(--bg-hover)", display: "inline-flex",
                        alignItems: "center", justifyContent: "center",
                        fontSize: 8, fontWeight: 600, color: "var(--text-muted)",
                        marginLeft: -5, border: "1.5px solid var(--bg-primary)",
                      }}>
                        +{activeGroup!.members.length - 5}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <>
              <div style={{
                width: 32, height: 32, borderRadius: 9,
                background: agentColor, opacity: 0.9,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 600, color: "#fff",
              }}>
                {agentInitials}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{agentName}</div>
                <div style={{ fontSize: 12, color: isTyping ? "var(--green)" : "var(--text-muted)" }}>
                  {isTyping ? "typing..." : agentRole}
                </div>
              </div>
            </>
          )}
          {/* Search toggle */}
          <button
            onClick={() => { setSearchOpen(!searchOpen); setSearchQuery(""); }}
            style={{
              background: searchOpen ? "var(--bg-hover)" : "transparent",
              border: "none", borderRadius: 8, padding: 6,
              cursor: "pointer", color: "var(--text-muted)",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "background 0.1s",
            }}
            title="Search messages"
          >
            {searchOpen ? <X size={16} /> : <Search size={16} />}
          </button>
        </div>

        {/* Search bar */}
        {searchOpen && (
          <div style={{
            padding: "8px 24px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search messages..."
              style={{
                width: "100%", padding: "6px 12px",
                border: "1px solid var(--border)", borderRadius: 8,
                background: "var(--bg-tertiary)", color: "var(--text-primary)",
                fontSize: 13, fontFamily: "inherit", outline: "none",
              }}
              onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); } }}
            />
            {searchQuery && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                {filteredEntries.length} result{filteredEntries.length !== 1 ? "s" : ""}
              </div>
            )}
          </div>
        )}

        {/* Messages */}
        <div style={{
          flex: 1, overflowY: "auto", padding: "20px 24px",
          display: "flex", flexDirection: "column", gap: 4,
        }}>
          {displayEntries.length === 0 ? (
            <div style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
              flexDirection: "column", gap: 8,
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: 14,
                background: chatHeaderColor, opacity: 0.15,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 14,
                  background: chatHeaderColor, opacity: 0.6,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16, fontWeight: 700, color: "#fff",
                }}>
                  {isGroupMode ? <Users size={20} /> : chatHeaderInitials}
                </div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)", marginTop: 4 }}>
                {chatHeaderName}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {searchOpen && searchQuery ? "No matching messages" : isGroupMode ? "Send a message to broadcast to all members" : "Send a message to start the conversation"}
              </div>
            </div>
          ) : (
            <>
              {displayEntries.map((entry, i) => {
                const isUser = entry.from === "user";
                const prev = displayEntries[i - 1];
                const showDate = i === 0 || new Date(entry.timestamp).toDateString() !== new Date(prev?.timestamp ?? 0).toDateString();
                const sameSender = prev && prev.from === entry.from;

                // In group mode, get the actual agent's info for their messages
                const msgEmp = isUser ? null : empFor(entry.from);
                const msgColor = isUser ? "var(--accent)" : (msgEmp?.color || "var(--text-muted)");
                const msgInitials = isUser ? "" : (msgEmp?.initials || getInitials(msgEmp?.name || entry.from));
                const msgName = isUser ? "" : (msgEmp?.name?.split(" ")[0] || entry.from);

                const msgContent = searchQuery.trim()
                  ? highlightText(entry.message, searchQuery)
                  : entry.message;

                return (
                  <div key={entry.id ?? i}>
                    {showDate && (
                      <div style={{ textAlign: "center", margin: "16px 0 12px" }}>
                        <span style={{
                          fontSize: 11, color: "var(--text-muted)",
                          background: "var(--bg-tertiary)",
                          padding: "3px 12px", borderRadius: 6, fontWeight: 500,
                        }}>
                          {new Date(entry.timestamp).toDateString() === new Date().toDateString()
                            ? "Today"
                            : new Date(entry.timestamp).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      </div>
                    )}
                    <div style={{
                      display: "flex",
                      justifyContent: isUser ? "flex-end" : "flex-start",
                      marginTop: sameSender ? 2 : 10,
                      alignItems: "flex-end", gap: 8,
                    }}>
                      {/* Agent avatar */}
                      {!isUser && (
                        <div style={{ width: 28, flexShrink: 0 }}>
                          {!sameSender && (
                            <div style={{
                              width: 28, height: 28, borderRadius: 8,
                              background: msgColor, opacity: 0.9,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 9, fontWeight: 700, color: "#fff",
                            }}>
                              {msgInitials}
                            </div>
                          )}
                        </div>
                      )}
                      <div style={{
                        maxWidth: "65%",
                        display: "flex", flexDirection: "column",
                        alignItems: isUser ? "flex-end" : "flex-start",
                      }}>
                        {/* In group mode, show agent name above their message */}
                        {isGroupMode && !isUser && !sameSender && (
                          <div style={{ fontSize: 11, fontWeight: 600, color: msgColor, marginBottom: 2, paddingInline: 4 }}>
                            {msgName}
                          </div>
                        )}
                        <div className={isUser ? undefined : "md-content"} style={{
                          padding: "8px 14px",
                          borderRadius: isUser
                            ? (sameSender ? "14px 14px 4px 14px" : "14px 14px 4px 14px")
                            : (sameSender ? "14px 14px 14px 4px" : "14px 14px 14px 4px"),
                          background: isUser ? "var(--accent)" : "var(--bg-tertiary)",
                          color: isUser ? "#fff" : "var(--text-primary)",
                          fontSize: 13, lineHeight: 1.55,
                          whiteSpace: "pre-wrap", wordBreak: "break-word",
                        }}>
                          {isUser ? msgContent : <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{entry.message}</Markdown>}
                        </div>
                        {(!displayEntries[i + 1] || displayEntries[i + 1]?.from !== entry.from) && (
                          <div style={{
                            fontSize: 10, color: "var(--text-muted)",
                            marginTop: 3, paddingInline: 4,
                          }}>
                            {timeLabel(entry.timestamp)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Typing indicator */}
              {isTyping && !searchOpen && (
                <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginTop: 10 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 8,
                    background: chatHeaderColor, opacity: 0.9,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 700, color: "#fff",
                  }}>
                    {isGroupMode ? <Users size={12} /> : agentInitials}
                  </div>
                  <div style={{
                    padding: "10px 16px",
                    borderRadius: "14px 14px 14px 4px",
                    background: "var(--bg-tertiary)",
                    display: "flex", gap: 4, alignItems: "center",
                  }}>
                    {[0, 1, 2].map((n) => (
                      <span
                        key={n}
                        style={{
                          width: 5, height: 5, borderRadius: "50%",
                          background: "var(--text-muted)",
                          animation: `pulse-dot 1.2s ease-in-out ${n * 0.2}s infinite`,
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={bottomRef} />
        </div>

        {/* ── Input bar ── */}
        <div style={{ padding: "12px 24px 16px", flexShrink: 0 }}>
          <div style={{
            display: "flex", alignItems: "flex-end", gap: 8,
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            borderRadius: 24, padding: "6px 6px 6px 18px",
          }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder={inputPlaceholder}
              rows={1}
              style={{
                flex: 1, border: "none", outline: "none", resize: "none",
                background: "transparent", color: "var(--text-primary)",
                fontSize: 14, lineHeight: 1.5, fontFamily: "inherit",
                maxHeight: 120, overflowY: "auto", padding: "4px 0",
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 120) + "px";
              }}
            />
            <button
              onClick={() => void send()}
              disabled={!input.trim() || sending}
              style={{
                width: 34, height: 34, borderRadius: "50%", border: "none",
                background: input.trim() && !sending ? "var(--accent)" : "var(--bg-hover)",
                color: input.trim() && !sending ? "#fff" : "var(--text-muted)",
                cursor: input.trim() && !sending ? "pointer" : "default",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0, transition: "background 0.15s",
              }}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Create Group Modal ── */}
      {showCreateGroup && (
        <CreateGroupModal
          agents={agents}
          onClose={() => setShowCreateGroup(false)}
          onCreate={createGroup}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE GROUP MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function CreateGroupModal({
  agents,
  onClose,
  onCreate,
}: {
  agents: Employee[];
  onClose: () => void;
  onCreate: (name: string, members: string[], color: string) => void;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [color, setColor] = useState(GROUP_COLORS[0]);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.toLowerCase();
    return agents.filter((a) => a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q));
  }, [agents, search]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function handleCreate() {
    if (!name.trim() || selected.size === 0) return;
    onCreate(name.trim(), Array.from(selected), color);
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div
        style={{
          background: "var(--bg-primary)", borderRadius: 16,
          width: 420, maxHeight: "80vh", display: "flex", flexDirection: "column",
          border: "1px solid var(--border)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid var(--border)",
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>Create Group</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            Broadcast messages to multiple agents at once
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px" }}>
          {/* Group name */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>
              Group name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Backend Team"
              autoFocus
              style={{
                width: "100%", padding: "8px 12px",
                border: "1px solid var(--border)", borderRadius: 8,
                background: "var(--bg-tertiary)", color: "var(--text-primary)",
                fontSize: 13, fontFamily: "inherit", outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* Color picker */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>
              Color
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  style={{
                    width: 24, height: 24, borderRadius: 6, border: "none",
                    background: c, cursor: "pointer",
                    outline: color === c ? "2px solid var(--text-primary)" : "none",
                    outlineOffset: 2,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {color === c && <Check size={12} color="#fff" strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>

          {/* Member search */}
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>
              Members ({selected.size} selected)
            </label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents..."
              style={{
                width: "100%", padding: "6px 12px",
                border: "1px solid var(--border)", borderRadius: 8,
                background: "var(--bg-tertiary)", color: "var(--text-primary)",
                fontSize: 12, fontFamily: "inherit", outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* Agent checklist */}
          <div style={{
            maxHeight: 240, overflowY: "auto",
            border: "1px solid var(--border)", borderRadius: 8,
          }}>
            {filtered.map((ag) => {
              const checked = selected.has(ag.agent_key);
              const initials = ag.initials || getInitials(ag.name);
              return (
                <label
                  key={ag.agent_key}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px", cursor: "pointer",
                    borderBottom: "1px solid var(--border)",
                    background: checked ? "var(--bg-hover)" : "transparent",
                    transition: "background 0.08s",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(ag.agent_key)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <div style={{
                    width: 26, height: 26, borderRadius: 7,
                    background: ag.color || "var(--text-muted)", opacity: 0.9,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 700, color: "#fff", flexShrink: 0,
                  }}>
                    {initials}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{ag.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{ag.role}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: "16px 24px",
          borderTop: "1px solid var(--border)",
          display: "flex", justifyContent: "flex-end", gap: 8,
        }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px", border: "1px solid var(--border)",
              borderRadius: 8, background: "transparent",
              color: "var(--text-primary)", cursor: "pointer",
              fontSize: 13, fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || selected.size === 0}
            style={{
              padding: "8px 20px", border: "none", borderRadius: 8,
              background: name.trim() && selected.size > 0 ? "var(--accent)" : "var(--bg-hover)",
              color: name.trim() && selected.size > 0 ? "#fff" : "var(--text-muted)",
              cursor: name.trim() && selected.size > 0 ? "pointer" : "default",
              fontSize: 13, fontWeight: 600, fontFamily: "inherit",
              transition: "background 0.15s",
            }}
          >
            Create Group
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Highlight matching text with a yellow background. */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} style={{ background: "var(--yellow, #fbbf24)", color: "#000", borderRadius: 2, padding: "0 1px" }}>{part}</mark>
          : part
      )}
    </>
  );
}
