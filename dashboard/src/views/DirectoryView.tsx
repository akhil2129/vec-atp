import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import {
  Lock, X, Search, ChevronLeft,
  UserPlus, Power, Trash2,
  LayoutGrid, Building2, Cpu, Check,
} from "lucide-react";
import { usePolling, postApi, deleteApi } from "../hooks/useApi";
import { useAgentStream } from "../hooks/useSSE";
import { useEmployees } from "../context/EmployeesContext";
import type {
  Task, AgentProfile,
  AgentRuntimeEntry, RoleTemplateSummary,
} from "../types";

interface ModelSlot { provider: string; model: string; }
interface ProviderInfo { id: string; name: string; configured: boolean; models: string[]; }
interface ModelConfigData {
  providers: ProviderInfo[];
  config: { primary: ModelSlot; secondary: ModelSlot | null; fallback: ModelSlot | null; agentModels: Record<string, ModelSlot>; };
}

const ROLE_COLORS: Record<string, string> = {
  "Project Manager": "var(--purple)", "Senior Developer": "var(--blue)",
  "Business Analyst": "var(--green)", "QA Engineer": "var(--yellow)",
  "Security Engineer": "var(--red)", "DevOps Engineer": "var(--orange)",
  "Technical Writer": "var(--purple)", "Solutions Architect": "var(--blue)",
  "Research Specialist": "var(--green)",
  // New roles
  "Frontend Developer": "var(--blue)", "Backend Developer": "var(--orange)",
  "Mobile Developer": "var(--purple)", "Data Engineer": "var(--green)",
  "Database Administrator": "var(--blue)", "ML/AI Engineer": "var(--green)",
  "Site Reliability Engineer": "var(--orange)", "Product Owner": "var(--blue)",
  "UI/UX Designer": "var(--purple)", "Scrum Master": "var(--purple)",
  "Data Analyst": "var(--green)", "Release Manager": "var(--green)",
  "Compliance Officer": "var(--red)", "Support Engineer": "var(--yellow)",
};

const LOCKED = new Set(["message_agent", "read_inbox"]);

const TOOL_GROUPS: { label: string; match: (t: string) => boolean }[] = [
  { label: "Messaging", match: (t) => t.includes("message") || t.includes("inbox") },
  { label: "Memory",    match: (t) => t.includes("memory") || t.includes("stm") || t.includes("ltm") || t.includes("sltm") },
  { label: "Tasks",     match: (t) => t.includes("task") || t.includes("assign") || t.includes("start") },
  { label: "Files",     match: (t) => t.includes("read") || t.includes("write") || t.includes("edit") || t.includes("file") || t.includes("find") || t.includes("grep") || t.includes("ls") },
  { label: "Shell",     match: (t) => t.includes("bash") || t.includes("shell") || t.includes("exec") },
  { label: "Directory", match: (t) => t.includes("director") || t.includes("employee") || t.includes("lookup") },
  { label: "Utils",     match: (t) => t.includes("date") || t.includes("time") || t.includes("search") },
];

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const DUR = "0.44s";

function getInitials(name: string): string {
  const parts = name.split(" ");
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function groupTools(tools: string[]) {
  const used = new Set<string>();
  const groups: { label: string; tools: string[] }[] = [];
  for (const g of TOOL_GROUPS) {
    const m = tools.filter((t) => !used.has(t) && g.match(t));
    if (m.length) { m.forEach((t) => used.add(t)); groups.push({ label: g.label, tools: m }); }
  }
  const rest = tools.filter((t) => !used.has(t));
  if (rest.length) groups.push({ label: "Other", tools: rest });
  return groups;
}

/* ── Status badge component ── */

function StatusBadge({ runtime }: { runtime?: AgentRuntimeEntry }) {
  if (!runtime) return null;
  if (!runtime.enabled) {
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4,
        background: "var(--bg-tertiary)", color: "var(--text-muted)",
        border: "1px solid var(--border)",
      }}>
        DISABLED
      </span>
    );
  }
  if (runtime.status === "paused") {
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4,
        background: "var(--yellow-bg, rgba(245,158,11,0.1))", color: "var(--yellow)",
        border: "1px solid var(--yellow)",
      }}>
        PAUSED
      </span>
    );
  }
  return null; // Running is the default — shown via green dot
}

/* ── Department colors for hire modal ── */

const DEPT_COLORS: Record<string, string> = {
  Engineering: "var(--blue)",
  Management: "var(--purple)",
  "Quality Assurance": "var(--yellow)",
  Security: "var(--red)",
  Operations: "var(--orange)",
  Research: "var(--green)",
  Documentation: "var(--purple)",
  Design: "var(--purple)",
  Data: "var(--green)",
  Support: "var(--yellow)",
};

function getDeptColor(dept: string): string {
  return DEPT_COLORS[dept] ?? "var(--accent)";
}

/* ── Hire Agent modal ── */

function HireModal({
  templates,
  onHire,
  onClose,
}: {
  templates: RoleTemplateSummary[];
  onHire: (template: string, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const hireableTemplates = templates.filter((t) => !t.mandatory);

  // Group by department
  const departments = useMemo(() => {
    const map = new Map<string, RoleTemplateSummary[]>();
    for (const t of hireableTemplates) {
      const arr = map.get(t.department) ?? [];
      arr.push(t);
      map.set(t.department, arr);
    }
    return [...map.entries()];
  }, [hireableTemplates]);

  const selectedInfo = hireableTemplates.find((t) => t.id === selectedTemplate);

  async function submit() {
    if (!selectedTemplate || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onHire(selectedTemplate, name.trim());
      onClose();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
        }}
      />
      {/* Modal */}
      <div style={{
        position: "fixed", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)", zIndex: 101,
        background: "var(--bg-secondary)", border: "1px solid var(--border)",
        borderRadius: 16, padding: 0, width: 720, maxWidth: "92vw",
        maxHeight: "85vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px var(--border)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "18px 24px 14px",
          borderBottom: "1px solid var(--border)", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 10,
              background: "var(--accent-subtle)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <UserPlus size={16} style={{ color: "var(--accent)" }} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
                Hire New Agent
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                Select a department and role
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28, border: "1px solid var(--border)", borderRadius: 8,
            background: "var(--bg-tertiary)", color: "var(--text-muted)",
            cursor: "pointer", padding: 0, transition: "all 0.12s",
          }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-tertiary)"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 20px" }}>
          {/* Departments + roles */}
          {departments.map(([dept, roles]) => {
            const deptColor = getDeptColor(dept);
            return (
              <div key={dept} style={{ marginBottom: 16 }}>
                {/* Department header */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  marginBottom: 8, padding: "0 2px",
                }}>
                  <Building2 size={12} style={{ color: deptColor, opacity: 0.7 }} />
                  <span style={{
                    fontSize: 11, fontWeight: 600, color: "var(--text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.06em",
                  }}>
                    {dept}
                  </span>
                  <span style={{
                    fontSize: 10, color: "var(--text-muted)", opacity: 0.5,
                  }}>
                    {roles.length} {roles.length === 1 ? "role" : "roles"}
                  </span>
                  <div style={{
                    flex: 1, height: 1, background: "var(--border)", marginLeft: 4,
                  }} />
                </div>

                {/* Role cards grid */}
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                  gap: 6,
                }}>
                  {roles.map((t) => {
                    const sel = selectedTemplate === t.id;
                    const roleColor = ROLE_COLORS[t.role] ?? deptColor;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSelectedTemplate(t.id)}
                        style={{
                          fontSize: 12, padding: "10px 12px", borderRadius: 10,
                          cursor: "pointer", border: "1px solid",
                          fontFamily: "inherit", fontWeight: 500, textAlign: "left",
                          borderColor: sel ? "var(--accent)" : "var(--border)",
                          background: sel ? "var(--accent-subtle)" : "var(--bg-card)",
                          color: sel ? "var(--accent)" : "var(--text-secondary)",
                          transition: "all 0.12s",
                        }}
                        onMouseEnter={(e) => { if (!sel) e.currentTarget.style.borderColor = "var(--text-muted)"; }}
                        onMouseLeave={(e) => { if (!sel) e.currentTarget.style.borderColor = sel ? "var(--accent)" : "var(--border)"; }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span style={{
                            width: 7, height: 7, borderRadius: "50%",
                            background: sel ? "var(--accent)" : roleColor,
                            flexShrink: 0, opacity: sel ? 1 : 0.7,
                          }} />
                          <span style={{ lineHeight: 1.3 }}>{t.role}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {hireableTemplates.length === 0 && (
            <div style={{
              padding: 24, textAlign: "center",
              color: "var(--text-muted)", fontSize: 13,
            }}>
              No additional roles available to hire.
            </div>
          )}
        </div>

        {/* Footer — name + actions (sticky at bottom) */}
        <div style={{
          padding: "14px 24px 18px",
          borderTop: "1px solid var(--border)", flexShrink: 0,
          background: "var(--bg-secondary)",
        }}>
          {/* Selected role indicator */}
          {selectedInfo && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              marginBottom: 12, fontSize: 12, color: "var(--text-secondary)",
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: ROLE_COLORS[selectedInfo.role] ?? "var(--accent)",
              }} />
              <span style={{ fontWeight: 500 }}>
                {selectedInfo.role}
              </span>
              <span style={{ color: "var(--text-muted)" }}>
                — {selectedInfo.department}
              </span>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder={selectedTemplate ? "Enter agent name..." : "Select a role first"}
              disabled={!selectedTemplate}
              style={{
                flex: 1, fontSize: 13, padding: "10px 14px", borderRadius: 10,
                border: "1px solid var(--border)", background: "var(--bg-card)",
                color: "var(--text-primary)", fontFamily: "inherit",
                outline: "none", boxSizing: "border-box",
                transition: "border-color 0.12s",
                opacity: selectedTemplate ? 1 : 0.5,
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
            />
            <button onClick={onClose} style={{
              fontSize: 12, padding: "10px 16px", borderRadius: 10,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit",
              fontWeight: 500, transition: "all 0.12s", flexShrink: 0,
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy || !selectedTemplate || !name.trim()}
              style={{
                fontSize: 12, padding: "10px 22px", borderRadius: 10, border: "none",
                background: "var(--accent)", color: "#fff", cursor: "pointer",
                fontFamily: "inherit", fontWeight: 600, flexShrink: 0,
                opacity: busy || !selectedTemplate || !name.trim() ? 0.4 : 1,
                transition: "all 0.12s",
                boxShadow: busy || !selectedTemplate || !name.trim() ? "none" : "0 2px 12px rgba(91,141,239,0.3)",
              }}
            >
              {busy ? "Hiring..." : "Hire Agent"}
            </button>
          </div>

          {error && (
            <div style={{
              fontSize: 12, color: "var(--red)", marginTop: 10,
              padding: "8px 12px", background: "var(--red-bg)",
              borderRadius: 8, border: "1px solid rgba(232,100,90,0.15)",
            }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ── Agent model selector ── */

function AgentModelSelector({ agentId }: { agentId: string }) {
  const { data: modelData } = usePolling<ModelConfigData>("/api/model-config", 10000);
  const [saving, setSaving] = useState(false);
  const [selProvider, setSelProvider] = useState("");
  const [selModel, setSelModel] = useState("");
  const [editing, setEditing] = useState(false);

  const providers = (modelData?.providers ?? []).filter((p) => p.configured);
  const override = modelData?.config.agentModels[agentId] ?? null;
  const primary = modelData?.config.primary;
  const effective = override ?? primary;

  // Sync selectors when override changes
  useEffect(() => {
    if (override) {
      setSelProvider(override.provider);
      setSelModel(override.model);
    } else if (primary) {
      setSelProvider(primary.provider);
      setSelModel(primary.model);
    }
  }, [override?.provider, override?.model, primary?.provider, primary?.model]);

  const currentProvider = providers.find((p) => p.id === selProvider);
  const models = currentProvider?.models ?? [];

  async function handleSave() {
    setSaving(true);
    try {
      await postApi("/api/agent-model", { agent_id: agentId, provider: selProvider, model: selModel });
    } catch (e) { console.error(e); }
    finally { setSaving(false); setEditing(false); }
  }

  async function handleClear() {
    setSaving(true);
    try {
      await postApi("/api/agent-model", { agent_id: agentId });
    } catch (e) { console.error(e); }
    finally { setSaving(false); setEditing(false); }
  }

  if (!modelData) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Cpu size={13} style={{ color: "var(--purple)" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Model</span>
          {override && (
            <span style={{
              fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
              background: "color-mix(in srgb, var(--purple) 12%, transparent)",
              color: "var(--purple)",
            }}>
              OVERRIDE
            </span>
          )}
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            style={{
              fontSize: 11, fontWeight: 500, padding: "4px 12px", borderRadius: 6,
              border: "1px solid var(--border)", background: "var(--bg-tertiary)",
              color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit",
            }}
          >
            Change
          </button>
        )}
      </div>

      {editing ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 12px", borderRadius: 8,
          background: "var(--bg-tertiary)", border: "1px solid var(--border)",
        }}>
          <select
            value={selProvider}
            onChange={(e) => { setSelProvider(e.target.value); setSelModel(""); }}
            style={{
              fontSize: 12, padding: "6px 10px", borderRadius: 6,
              border: "1px solid var(--border)", background: "var(--bg-card)",
              color: "var(--text-primary)", fontFamily: "inherit", outline: "none",
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            value={selModel}
            onChange={(e) => setSelModel(e.target.value)}
            style={{
              fontSize: 12, padding: "6px 10px", borderRadius: 6, flex: 1,
              border: "1px solid var(--border)", background: "var(--bg-card)",
              color: "var(--text-primary)", fontFamily: "monospace", outline: "none",
            }}
          >
            <option value="">Select model...</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button
            onClick={handleSave}
            disabled={saving || !selModel}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, borderRadius: 6, border: "none", flexShrink: 0,
              background: selModel ? "var(--accent)" : "var(--bg-tertiary)",
              color: selModel ? "#fff" : "var(--text-muted)",
              cursor: selModel ? "pointer" : "default", padding: 0,
            }}
          >
            <Check size={13} />
          </button>
          {override && (
            <button
              onClick={handleClear}
              disabled={saving}
              title="Reset to primary"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, borderRadius: 6, flexShrink: 0,
                border: "1px solid var(--border)", background: "transparent",
                color: "var(--text-muted)", cursor: "pointer", padding: 0,
              }}
            >
              <X size={12} />
            </button>
          )}
          <button
            onClick={() => setEditing(false)}
            style={{
              fontSize: 11, padding: "5px 10px", borderRadius: 6,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-muted)", cursor: "pointer", fontFamily: "inherit",
              flexShrink: 0,
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 12px", borderRadius: 8,
          background: "var(--bg-tertiary)", border: "1px solid var(--border)",
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: "var(--green)",
          }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)" }}>
              {effective?.provider ?? "—"}
            </div>
            <div style={{
              fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace",
            }}>
              {effective?.model ?? "Not configured"}
            </div>
          </div>
          {!override && (
            <span style={{
              fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
              background: "var(--bg-card)", color: "var(--text-muted)",
              border: "1px solid var(--border)",
            }}>
              PRIMARY
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Expanded tools grid (used inside the full-page panel) ── */

function ExpandedToolsGrid({ profile }: { profile: AgentProfile }) {
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(profile.enabled_tools));
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify([...enabled].sort()) !== JSON.stringify([...profile.enabled_tools].sort());

  function toggle(t: string) {
    if (LOCKED.has(t)) return;
    setEnabled((p) => { const n = new Set(p); n.has(t) ? n.delete(t) : n.add(t); return n; });
  }

  async function save() {
    setSaving(true);
    try { await postApi("/api/agent-config", { agent_id: profile.agent_id, tools: Array.from(enabled) }); }
    catch (e) { console.error(e); }
    finally { setSaving(false); }
  }

  const groups = groupTools(profile.all_tools);
  const count = profile.all_tools.filter((t) => enabled.has(t)).length;

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 14,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Tools</span>
          <span style={{
            fontSize: 11, color: "var(--text-muted)", background: "var(--bg-tertiary)",
            padding: "2px 8px", borderRadius: 5, fontFamily: "monospace",
          }}>
            {count}/{profile.all_tools.length}
          </span>
        </div>
        {dirty && (
          <button onClick={save} disabled={saving} style={{
            fontSize: 11, fontWeight: 500, padding: "4px 14px", borderRadius: 6, border: "none",
            background: "var(--accent)", color: "#fff", cursor: "pointer", fontFamily: "inherit",
            opacity: saving ? 0.5 : 1,
          }}>
            {saving ? "Saving..." : "Save changes"}
          </button>
        )}
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
        gap: 10,
      }}>
        {groups.map((g) => (
          <div key={g.label} style={{
            border: "1px solid var(--border)",
            borderRadius: 8, overflow: "hidden",
          }}>
            <div style={{
              fontSize: 10, fontWeight: 600, color: "var(--text-muted)",
              textTransform: "uppercase", letterSpacing: "0.05em",
              padding: "7px 12px 5px",
              background: "var(--bg-tertiary)",
              borderBottom: "1px solid var(--border)",
            }}>
              {g.label}
            </div>
            {g.tools.map((tool, i) => {
              const on = enabled.has(tool);
              const locked = LOCKED.has(tool);
              return (
                <div key={tool}
                  className={`tool-row${locked ? " locked" : ""}`}
                  onClick={() => toggle(tool)}
                  style={{
                    borderBottom: i < g.tools.length - 1 ? "1px solid var(--border)" : "none",
                    height: 32,
                  }}
                >
                  <span style={{
                    flex: 1, fontSize: 11, fontFamily: "monospace",
                    color: on ? "var(--text-primary)" : "var(--text-muted)",
                  }}>
                    {tool}
                  </span>
                  {locked ? (
                    <Lock size={9} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  ) : (
                    <div style={{
                      width: 28, height: 16, borderRadius: 8, flexShrink: 0,
                      background: on ? "var(--green)" : "var(--bg-tertiary)",
                      border: on ? "none" : "1px solid var(--border)",
                      position: "relative",
                      transition: "background 0.15s",
                      cursor: "pointer",
                    }}>
                      <div style={{
                        width: 12, height: 12, borderRadius: "50%",
                        background: on ? "#fff" : "var(--text-muted)",
                        position: "absolute", top: 2,
                        left: on ? 14 : 2,
                        transition: "left 0.15s, background 0.15s",
                      }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Main DirectoryView ── */

export default function DirectoryView() {
  const { employees, refresh: refreshEmployees } = useEmployees();
  const { data: tasks } = usePolling<Task[]>("/api/tasks", 5000);
  const { data: companyData } = usePolling<{ agents: AgentProfile[] }>("/api/company", 15000);
  const { data: runtimeData, refresh: refreshRuntime } = usePolling<{ agents: AgentRuntimeEntry[] }>("/api/agents/runtime", 4000);
  const { data: templatesData } = usePolling<{ templates: RoleTemplateSummary[] }>("/api/role-templates", 30000);
  const { tokens, activeAgents: activeMap } = useAgentStream();

  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "department">("grid");
  const [busy, setBusy] = useState<Record<string, string | null>>({});
  const [hireOpen, setHireOpen] = useState(false);

  // Expand animation state
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [expandFrom, setExpandFrom] = useState<{
    top: number; left: number; width: number; height: number;
    rootW: number; rootH: number;
  } | null>(null);
  const [animPhase, setAnimPhase] = useState<"idle" | "measure" | "entered" | "exiting">("idle");
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const allEmployees = employees ?? [];
  const allTasks = tasks ?? [];
  const profiles = companyData?.agents ?? [];
  const runtimeAgents = runtimeData?.agents ?? [];
  const roleTemplates = templatesData?.templates ?? [];
  const isOpen = animPhase === "entered";

  const runtimeMap = useMemo(() => {
    const m = new Map<string, AgentRuntimeEntry>();
    for (const a of runtimeAgents) m.set(a.agent_id, a);
    return m;
  }, [runtimeAgents]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allEmployees;
    const q = search.toLowerCase();
    return allEmployees.filter((e) =>
      e.name.toLowerCase().includes(q) ||
      e.role.toLowerCase().includes(q) ||
      e.agent_key.toLowerCase().includes(q)
    );
  }, [allEmployees, search]);

  /** Group employees by department for department view. */
  const departments = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const emp of filtered) {
      const dept = emp.department ?? "Other";
      if (!map.has(dept)) map.set(dept, []);
      map.get(dept)!.push(emp);
    }
    // Sort: Management first, then alphabetical
    const order = ["Management", "Product", "Engineering", "Analysis", "Design", "Documentation", "Governance"];
    return [...map.entries()].sort(([a], [b]) => {
      const ai = order.indexOf(a), bi = order.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  /* ── Expand / Collapse ── */

  const openSettings = useCallback((agentKey: string) => {
    const card = cardRefs.current.get(agentKey);
    const root = rootRef.current;
    if (!card || !root) return;
    const cr = card.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    setExpandFrom({
      top: cr.top - rr.top,
      left: cr.left - rr.left,
      width: cr.width,
      height: cr.height,
      rootW: rr.width,
      rootH: rr.height,
    });
    setExpandedAgent(agentKey);
    setAnimPhase("measure");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimPhase("entered"));
    });
  }, []);

  const closeSettings = useCallback(() => {
    setAnimPhase("exiting");
    setTimeout(() => {
      setExpandedAgent(null);
      setExpandFrom(null);
      setAnimPhase("idle");
    }, 450);
  }, []);

  /* ── AR lifecycle actions ── */

  async function doToggle(agentId: string, enabled: boolean) {
    setBusy((p) => ({ ...p, [agentId]: "toggle" }));
    try {
      await postApi(`/api/agents/${agentId}/toggle`, { enabled });
      refreshRuntime();
      refreshEmployees();
    } catch (e) { console.error(e); }
    finally { setBusy((p) => ({ ...p, [agentId]: null })); }
  }

  async function doRemove(agentId: string) {
    if (!confirm(`Remove agent @${agentId}? This will delete them from the roster.`)) return;
    setBusy((p) => ({ ...p, [agentId]: "remove" }));
    try {
      await deleteApi(`/api/agents/${agentId}`);
      refreshRuntime();
      refreshEmployees();
    } catch (e) { console.error(e); }
    finally { setBusy((p) => ({ ...p, [agentId]: null })); }
  }

  async function doHire(template: string, name: string) {
    await postApi("/api/agents", { template, name });
    refreshRuntime();
    refreshEmployees();
  }

  /* ── Render a single employee card (shared by grid & department views) ── */

  function renderCard(emp: typeof allEmployees[number]) {
    const key = emp.agent_key;
    const color = ROLE_COLORS[emp.role] ?? "var(--text-muted)";
    const active = activeMap[key] ?? false;
    const rt = runtimeMap.get(key);
    const empTasks = allTasks.filter((t) => t.agent_id === key);
    const inProg = empTasks.filter((t) => t.status === "in_progress").length;
    const done = empTasks.filter((t) => t.status === "completed").length;
    const todo = empTasks.filter((t) => t.status === "todo").length;
    const preview = tokens[key] ?? "";
    const isPM = rt?.template === "pm";

    return (
      <div
        key={key}
        ref={(el) => { if (el) cardRefs.current.set(key, el); }}
        onClick={() => openSettings(key)}
        className="card-hover"
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 14,
          cursor: "pointer",
          transition: "border-color 0.12s, box-shadow 0.12s",
          position: "relative",
          display: "flex", flexDirection: "column", gap: 10,
          opacity: rt && !rt.enabled ? 0.55 : 1,
        }}
      >
        {/* Top row: avatar + name + status badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ position: "relative", flexShrink: 0 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 9,
              background: color, opacity: 0.9,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 600, color: "#fff",
            }}>
              {emp.initials ?? getInitials(emp.name)}
            </div>
            {active && (
              <div style={{
                position: "absolute", bottom: -1, right: -1,
                width: 9, height: 9, borderRadius: "50%",
                background: "var(--green)",
                border: "2px solid var(--bg-card)",
              }} />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <span style={{
                fontSize: 13, fontWeight: 600, color: "var(--text-primary)",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {emp.name}
              </span>
              <StatusBadge runtime={rt} />
            </div>
            <div style={{ fontSize: 11, color: color, fontWeight: 500, marginTop: 1 }}>
              {emp.role}
            </div>
          </div>
          <span style={{
            fontSize: 10, fontFamily: "monospace", color: "var(--text-muted)",
            flexShrink: 0,
          }}>
            @{key}
          </span>
        </div>

        {/* Task stats row */}
        {empTasks.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {inProg > 0 && (
              <span style={{
                fontSize: 10, fontWeight: 500, color: "var(--blue)",
                background: "var(--blue-bg, rgba(17,88,199,0.1))",
                padding: "2px 7px", borderRadius: 4,
              }}>
                {inProg} active
              </span>
            )}
            {todo > 0 && (
              <span style={{
                fontSize: 10, fontWeight: 500, color: "var(--text-muted)",
                background: "var(--bg-tertiary)",
                padding: "2px 7px", borderRadius: 4,
              }}>
                {todo} pending
              </span>
            )}
            {done > 0 && (
              <span style={{
                fontSize: 10, fontWeight: 500, color: "var(--green)",
                background: "var(--green-bg, rgba(16,185,129,0.1))",
                padding: "2px 7px", borderRadius: 4,
              }}>
                {done} done
              </span>
            )}
          </div>
        )}

        {/* Live token preview */}
        {preview && (
          <div style={{
            fontSize: 10.5, fontFamily: "monospace", color: "var(--text-muted)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            background: "var(--bg-tertiary)",
            padding: "4px 8px", borderRadius: 5,
          }}>
            {preview.length > 120 ? preview.slice(-120) : preview}
          </div>
        )}

        {/* Lifecycle controls */}
        {rt && !isPM && (
          <div
            style={{ display: "flex", gap: 4, marginTop: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => doToggle(key, !rt.enabled)}
              disabled={busy[key] === "toggle"}
              title={rt.enabled ? "Disable" : "Enable"}
              style={{
                display: "flex", alignItems: "center", gap: 3,
                fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 5,
                border: "1px solid", cursor: "pointer", fontFamily: "inherit",
                borderColor: rt.enabled ? "var(--green)" : "var(--border)",
                background: rt.enabled ? "var(--green-bg, rgba(16,185,129,0.1))" : "var(--bg-tertiary)",
                color: rt.enabled ? "var(--green)" : "var(--text-muted)",
                opacity: busy[key] === "toggle" ? 0.5 : 1,
              }}
            >
              <Power size={10} />
              {rt.enabled ? "On" : "Off"}
            </button>
            <button
              onClick={() => doRemove(key)}
              disabled={busy[key] === "remove"}
              title="Remove"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, borderRadius: 5, padding: 0, marginLeft: "auto",
                border: "1px solid var(--border)", cursor: "pointer",
                background: "transparent", color: "var(--text-muted)",
                opacity: busy[key] === "remove" ? 0.5 : 1,
                transition: "color 0.08s, border-color 0.08s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--red)";
                e.currentTarget.style.color = "var(--red)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
            >
              <Trash2 size={10} />
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ── Expanded panel data ── */

  const expandedEmp = expandedAgent
    ? allEmployees.find((e) => e.agent_key === expandedAgent)
    : null;
  const expandedProfile = expandedAgent
    ? profiles.find((a) => a.agent_id === expandedAgent)
    : null;
  const expandedColor = expandedEmp ? (ROLE_COLORS[expandedEmp.role] ?? "var(--text-muted)") : "var(--text-muted)";
  const expandedTasks = expandedAgent ? allTasks.filter((t) => t.agent_id === expandedAgent) : [];
  const expandedRuntime = expandedAgent ? runtimeMap.get(expandedAgent) : undefined;

  return (
    <div ref={rootRef} style={{
      position: "relative",
      display: "flex", flexDirection: "column",
      height: "100%", overflow: "hidden",
    }}>
      {/* ── Header ── */}
      <div className="page-header" style={{
        display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", gap: 16,
      }}>
        <div>
          <div className="page-title">Directory</div>
          <div className="page-subtitle">
            {filtered.length === allEmployees.length
              ? `${allEmployees.length} employees`
              : `${filtered.length} of ${allEmployees.length} employees`}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* View mode toggle */}
          <div style={{
            display: "flex", borderRadius: 8, overflow: "hidden",
            border: "1px solid var(--border)", flexShrink: 0,
          }}>
            {([["grid", LayoutGrid, "Grid"], ["department", Building2, "Dept"]] as const).map(([mode, Icon, label]) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                title={`${label} view`}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  fontSize: 11, fontWeight: 500, padding: "5px 10px",
                  border: "none", cursor: "pointer", fontFamily: "inherit",
                  background: viewMode === mode ? "var(--accent)" : "transparent",
                  color: viewMode === mode ? "#fff" : "var(--text-muted)",
                  transition: "all 0.08s",
                }}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>

          {/* Hire Agent button */}
          <button
            onClick={() => setHireOpen(true)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 12, fontWeight: 600, padding: "7px 14px", borderRadius: 20,
              border: "none", background: "var(--accent)", color: "#fff",
              cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
              transition: "opacity 0.08s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
          >
            <UserPlus size={13} />
            Hire
          </button>

          {/* Search */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            borderRadius: 20, padding: "6px 14px",
            flexShrink: 0,
          }}>
            <Search size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              style={{
                border: "none", outline: "none", background: "transparent",
                color: "var(--text-primary)", fontSize: 12.5,
                width: 180, fontFamily: "inherit", padding: 0,
              }}
            />
            {search && (
              <button onClick={() => setSearch("")} style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 14, height: 14, border: "none", background: "var(--bg-hover)",
                color: "var(--text-muted)", cursor: "pointer", borderRadius: 3,
                padding: 0, flexShrink: 0,
              }}>
                <X size={9} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Employee cards ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 24px 20px" }}>
        {viewMode === "department" ? (
          /* ── Department grouped view ── */
          <div>
            {departments.map(([dept, emps]) => (
              <div key={dept} style={{ marginBottom: 24 }}>
                {/* Department header */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 10,
                  marginBottom: 10, paddingBottom: 6,
                  borderBottom: "1px solid var(--border)",
                }}>
                  <Building2 size={14} style={{ color: "var(--text-muted)" }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "0.01em" }}>
                    {dept}
                  </span>
                  <span style={{
                    fontSize: 11, color: "var(--text-muted)", background: "var(--bg-tertiary)",
                    padding: "1px 8px", borderRadius: 5, fontFamily: "monospace",
                  }}>
                    {emps.length}
                  </span>
                </div>
                {/* Cards grid */}
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                  gap: 12,
                }}>
                  {emps.map((emp) => renderCard(emp))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* ── Flat grid view ── */
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 12,
          }}>
            {filtered.map((emp) => renderCard(emp))}
          </div>
        )}

        {filtered.length === 0 && allEmployees.length > 0 && (
          <div style={{ textAlign: "center", padding: "48px 24px", color: "var(--text-muted)", fontSize: 13 }}>
            No employees matching &ldquo;{search}&rdquo;
          </div>
        )}
      </div>

      {/* ── Backdrop (fades in behind expanded panel) ── */}
      {expandedAgent && expandFrom && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 19,
          background: "var(--bg-card)",
          opacity: isOpen ? 1 : 0,
          transition: animPhase === "measure" ? "none" : `opacity 0.3s ease`,
          pointerEvents: "none",
        }} />
      )}

      {/* ── Expanded settings panel ── */}
      {expandedAgent && expandFrom && expandedEmp && (() => {
        const eInProg = expandedTasks.filter((t) => t.status === "in_progress").length;
        const eDone = expandedTasks.filter((t) => t.status === "completed").length;
        const eTodo = expandedTasks.filter((t) => t.status === "todo").length;
        const active = activeMap[expandedAgent] ?? false;
        const isPM = expandedRuntime?.template === "pm";

        return (
          <div style={{
            position: "absolute", zIndex: 20,
            top: isOpen ? 0 : expandFrom.top,
            left: isOpen ? 0 : expandFrom.left,
            width: isOpen ? expandFrom.rootW : expandFrom.width,
            height: isOpen ? expandFrom.rootH : expandFrom.height,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: isOpen ? 0 : 8,
            overflow: "hidden",
            boxShadow: isOpen ? "none" : "var(--shadow-lg)",
            transition: animPhase === "measure" ? "none"
              : `top ${DUR} ${EASE}, left ${DUR} ${EASE}, width ${DUR} ${EASE}, height ${DUR} ${EASE}, border-radius ${DUR} ${EASE}, box-shadow ${DUR} ${EASE}`,
          }}>
            {/* Content — fades in after panel expands */}
            <div style={{
              opacity: isOpen ? 1 : 0,
              transition: isOpen
                ? "opacity 0.22s ease-in 0.2s"
                : "opacity 0.1s ease-out",
              height: "100%",
              display: "flex", flexDirection: "column",
              overflow: "hidden",
            }}>
              {/* ── Panel header ── */}
              <div style={{
                display: "flex", alignItems: "center", gap: 14,
                padding: "16px 24px",
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}>
                <button
                  onClick={closeSettings}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 32, height: 32, border: "none", borderRadius: 8,
                    background: "var(--bg-tertiary)", color: "var(--text-secondary)",
                    cursor: "pointer", flexShrink: 0, padding: 0,
                    transition: "background 0.08s, color 0.08s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-primary)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-tertiary)"; e.currentTarget.style.color = "var(--text-secondary)"; }}
                >
                  <ChevronLeft size={16} />
                </button>

                <div style={{ position: "relative", flexShrink: 0 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 11,
                    background: expandedColor, opacity: 0.9,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, fontWeight: 600, color: "#fff",
                  }}>
                    {getInitials(expandedEmp.name)}
                  </div>
                  {active && (
                    <div style={{
                      position: "absolute", bottom: -1, right: -1,
                      width: 10, height: 10, borderRadius: "50%",
                      background: "var(--green)",
                      border: "2px solid var(--bg-card)",
                    }} />
                  )}
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8,
                  }}>
                    <span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
                      {expandedEmp.name}
                    </span>
                    <StatusBadge runtime={expandedRuntime} />
                  </div>
                  <div style={{ fontSize: 12, color: expandedColor, fontWeight: 500, marginTop: 1 }}>
                    {expandedEmp.role} · @{expandedAgent}
                  </div>
                </div>

                {/* Lifecycle buttons in expanded header */}
                {expandedRuntime && !isPM && (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, marginRight: 8 }}>
                    <button
                      onClick={() => doToggle(expandedAgent, !expandedRuntime.enabled)}
                      disabled={busy[expandedAgent] === "toggle"}
                      title={expandedRuntime.enabled ? "Disable agent" : "Enable agent"}
                      style={{
                        display: "flex", alignItems: "center", gap: 4,
                        fontSize: 11, fontWeight: 600, padding: "5px 12px", borderRadius: 6,
                        border: "1px solid", cursor: "pointer", fontFamily: "inherit",
                        borderColor: expandedRuntime.enabled ? "var(--green)" : "var(--border)",
                        background: expandedRuntime.enabled ? "var(--green-bg, rgba(16,185,129,0.1))" : "var(--bg-tertiary)",
                        color: expandedRuntime.enabled ? "var(--green)" : "var(--text-muted)",
                        opacity: busy[expandedAgent] === "toggle" ? 0.5 : 1,
                      }}
                    >
                      <Power size={11} />
                      {expandedRuntime.enabled ? "On" : "Off"}
                    </button>
                    <button
                      onClick={() => { doRemove(expandedAgent); closeSettings(); }}
                      disabled={busy[expandedAgent] === "remove"}
                      title="Remove agent"
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 30, height: 30, borderRadius: 6, padding: 0,
                        border: "1px solid var(--border)", cursor: "pointer",
                        background: "transparent", color: "var(--text-muted)",
                        opacity: busy[expandedAgent] === "remove" ? 0.5 : 1,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "var(--red)";
                        e.currentTarget.style.color = "var(--red)";
                        e.currentTarget.style.background = "var(--red-bg, rgba(239,68,68,0.1))";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--border)";
                        e.currentTarget.style.color = "var(--text-muted)";
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}

                {/* Task badges in header */}
                {expandedTasks.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {eInProg > 0 && (
                      <span style={{
                        fontSize: 11, fontWeight: 500, color: "var(--blue)",
                        background: "var(--blue-bg)", padding: "3px 10px", borderRadius: 5,
                      }}>
                        {eInProg} active
                      </span>
                    )}
                    {eTodo > 0 && (
                      <span style={{
                        fontSize: 11, fontWeight: 500, color: "var(--text-muted)",
                        background: "var(--bg-tertiary)", padding: "3px 10px", borderRadius: 5,
                      }}>
                        {eTodo} pending
                      </span>
                    )}
                    {eDone > 0 && (
                      <span style={{
                        fontSize: 11, fontWeight: 500, color: "var(--green)",
                        background: "var(--green-bg)", padding: "3px 10px", borderRadius: 5,
                      }}>
                        {eDone} done
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* ── Panel body (scrollable) ── */}
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 28px" }}>

                {/* Model selector */}
                <AgentModelSelector agentId={expandedAgent} />

                {/* Tools grid */}
                {expandedProfile && (
                  <ExpandedToolsGrid key={expandedAgent} profile={expandedProfile} />
                )}

              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Hire Agent Modal ── */}
      {hireOpen && (
        <HireModal
          templates={roleTemplates}
          onHire={doHire}
          onClose={() => setHireOpen(false)}
        />
      )}
    </div>
  );
}
