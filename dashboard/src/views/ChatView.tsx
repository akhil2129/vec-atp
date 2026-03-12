import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ArrowUp, Search, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePolling, postApi } from "../hooks/useApi";
import { useAgentStream } from "../hooks/useSSE";
import { useEmployees } from "../context/EmployeesContext";
import type { ChatEntry, Employee } from "../types";

const SYSTEM_PREFIXES = ["SUNSET_COMPLETE", "SUNRISE_", "NO_ACTION_REQUIRED", "MEMORY_UPDATED", "JOURNAL_"];

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

export default function ChatView() {
  const [selectedAgent, setSelectedAgent] = useState("pm");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { data: allEntries, refresh } = usePolling<ChatEntry[]>("/api/chat-log", 2000);
  const { employees } = useEmployees();
  const { activeAgents } = useAgentStream();

  const agents = useMemo(() => {
    const emps = employees ?? [];
    // Exclude "user" — only show actual agents
    return emps.filter((e) => e.agent_key !== "user");
  }, [employees]);

  // Current agent info
  const selectedEmp = agents.find((a) => a.agent_key === selectedAgent);
  const agentName = selectedEmp?.name ?? selectedAgent;
  const agentRole = selectedEmp?.role ?? "";
  const agentColor = selectedEmp?.color || "var(--text-muted)";
  const agentInitials = selectedEmp?.initials || (selectedEmp ? getInitials(selectedEmp.name) : selectedAgent.slice(0, 2).toUpperCase());

  const entries = (allEntries ?? []).filter((e) => {
    if (!(e.from === "user" && e.to === selectedAgent) && !(e.from === selectedAgent && e.to === "user")) return false;
    return !SYSTEM_PREFIXES.some((p) => (e.message ?? "").trim().startsWith(p));
  });

  // Search filtered entries
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

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [entries.length, selectedAgent]);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  async function send() {
    const msg = input.trim();
    if (!msg || sending) return;
    setSending(true); setInput("");
    try { await postApi("/api/send-message", { to: selectedAgent, message: msg }); await refresh(); }
    catch { setInput(msg); }
    finally { setSending(false); inputRef.current?.focus(); }
  }

  const isTyping = activeAgents[selectedAgent] ?? false;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Agent list panel ── */}
      <div style={{
        width: 260, flexShrink: 0,
        borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column",
      }}>
        <div className="page-header" style={{ paddingBottom: 12 }}>
          <div className="page-title">Chat</div>
          <div className="page-subtitle">Direct messages with agents</div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 10px" }}>
          {agents.map((ag) => {
            const sel = selectedAgent === ag.agent_key;
            const last = lastMsg(ag.agent_key);
            const typing = activeAgents[ag.agent_key] ?? false;
            const color = ag.color || "var(--text-muted)";
            const initials = ag.initials || getInitials(ag.name);

            return (
              <button
                key={ag.agent_key}
                onClick={() => setSelectedAgent(ag.agent_key)}
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
          })}
        </div>
      </div>

      {/* ── Chat area ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Chat header */}
        <div style={{
          padding: "14px 24px",
          borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
        }}>
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
                background: agentColor, opacity: 0.15,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 14,
                  background: agentColor, opacity: 0.6,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16, fontWeight: 700, color: "#fff",
                }}>
                  {agentInitials}
                </div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)", marginTop: 4 }}>
                {agentName}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {searchOpen && searchQuery ? "No matching messages" : "Send a message to start the conversation"}
              </div>
            </div>
          ) : (
            <>
              {displayEntries.map((entry, i) => {
                const isUser = entry.from === "user";
                const prev = displayEntries[i - 1];
                const showDate = i === 0 || new Date(entry.timestamp).toDateString() !== new Date(prev?.timestamp ?? 0).toDateString();
                const sameSender = prev && prev.from === entry.from;

                // Highlight search matches
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
                      {/* Agent avatar — only show on first in a group */}
                      {!isUser && (
                        <div style={{ width: 28, flexShrink: 0 }}>
                          {!sameSender && (
                            <div style={{
                              width: 28, height: 28, borderRadius: 8,
                              background: agentColor, opacity: 0.9,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 9, fontWeight: 700, color: "#fff",
                            }}>
                              {agentInitials}
                            </div>
                          )}
                        </div>
                      )}
                      <div style={{
                        maxWidth: "65%",
                        display: "flex", flexDirection: "column",
                        alignItems: isUser ? "flex-end" : "flex-start",
                      }}>
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
                        {/* Timestamp — show on last of group or always */}
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
                    background: agentColor, opacity: 0.9,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 700, color: "#fff",
                  }}>
                    {agentInitials}
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
              placeholder={`Message ${agentName.split(" ")[0]}...`}
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
    </div>
  );
}

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
