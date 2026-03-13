import { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, RefreshCw, Server, ChevronDown, ChevronRight,
  Shield, Search, MessageSquare, Cpu, Box,
  Zap, Settings2, Database, Eye, Star, Check,
} from "lucide-react";
import { postApi, apiUrl } from "../hooks/useApi";
import { usePolling } from "../hooks/useApi";

// ── Types ────────────────────────────────────────────────────────────────────

interface MCPServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface MCPConfig {
  mcpServers: Record<string, MCPServer>;
}

interface MCPStatus {
  servers: { name: string; tools: string[]; connected: boolean }[];
}

interface ModelSlot {
  provider: string;
  model: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  envKey: string;
  models: string[];
}

interface ModelConfigData {
  providers: ProviderInfo[];
  config: {
    primary: ModelSlot;
    secondary: ModelSlot | null;
    fallback: ModelSlot | null;
    agentModels: Record<string, ModelSlot>;
  };
}

interface SystemSettings {
  system: {
    companyName: string;
    workspace: string;
    dashboardPort: number;
    cliEnabled: boolean;
    debounceMs: number;
    contextWindow: number;
    compactThreshold: number;
  };
  llm: {
    provider: string;
    model: string;
    thinkingLevel: string;
    temperature: number;
    maxTokens: number;
  };
  proactive: {
    enabled: boolean;
    intervalSecs: number;
  };
  integrations: {
    telegram: { configured: boolean; chatId: string };
    searxng: { configured: boolean; url: string };
    sonarqube: { configured: boolean; hostUrl: string; projectKey: string };
    gitleaks: { configured: boolean };
    semgrep: { configured: boolean };
    trivy: { configured: boolean };
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const empty: MCPServer = { command: "", args: [], env: {} };
function deepClone<T>(obj: T): T { return JSON.parse(JSON.stringify(obj)); }

// ── Section wrapper ─────────────────────────────────────────────────────────

function Section({ title, icon, children, defaultOpen = true }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 20 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "10px 0", border: "none", background: "transparent",
          cursor: "pointer", fontFamily: "inherit",
        }}
      >
        {icon}
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", flex: 1, textAlign: "left" }}>
          {title}
        </span>
        {open ? <ChevronDown size={14} style={{ color: "var(--text-muted)" }} />
          : <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />}
      </button>
      {open && (
        <div style={{ paddingTop: 4 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Integration card ────────────────────────────────────────────────────────

function IntegrationCard({ name, icon, configured, detail, color }: {
  name: string;
  icon: React.ReactNode;
  configured: boolean;
  detail?: string;
  color: string;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "12px 14px", borderRadius: 10,
      background: "var(--bg-card)", border: "1px solid var(--border)",
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 9,
        background: configured ? `color-mix(in srgb, ${color} 15%, transparent)` : "var(--bg-tertiary)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: configured ? color : "var(--text-muted)",
        flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
          {name}
        </div>
        {detail && (
          <div style={{
            fontSize: 11, color: "var(--text-muted)", marginTop: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {detail}
          </div>
        )}
      </div>
      <span style={{
        fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 5,
        background: configured
          ? "color-mix(in srgb, var(--green) 12%, transparent)"
          : "var(--bg-tertiary)",
        color: configured ? "var(--green)" : "var(--text-muted)",
        border: `1px solid ${configured ? "color-mix(in srgb, var(--green) 20%, transparent)" : "var(--border)"}`,
        flexShrink: 0,
      }}>
        {configured ? "ACTIVE" : "NOT SET"}
      </span>
    </div>
  );
}

// ── Config row (read-only) ──────────────────────────────────────────────────

function ConfigRow({ label, value }: { label: string; value: string | number | boolean }) {
  const display = typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : String(value);
  const isBool = typeof value === "boolean";
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "8px 0",
      borderBottom: "1px solid var(--border)",
    }}>
      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{label}</span>
      {isBool ? (
        <span style={{
          fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
          background: value ? "color-mix(in srgb, var(--green) 12%, transparent)" : "var(--bg-tertiary)",
          color: value ? "var(--green)" : "var(--text-muted)",
        }}>
          {display}
        </span>
      ) : (
        <span style={{
          fontSize: 12, color: "var(--text-primary)", fontFamily: "monospace",
          background: "var(--bg-tertiary)", padding: "2px 8px", borderRadius: 4,
        }}>
          {display}
        </span>
      )}
    </div>
  );
}

// ── Model tier row (editable provider+model selector) ───────────────────────

function ModelTierRow({ tier, slot, color, icon, providers, onSave, saving }: {
  tier: string;
  slot: ModelSlot | null;
  color: string;
  icon: React.ReactNode;
  providers: ProviderInfo[];
  onSave: (slot: ModelSlot | null) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [selProvider, setSelProvider] = useState(slot?.provider ?? providers[0]?.id ?? "");
  const [selModel, setSelModel] = useState(slot?.model ?? "");

  const currentProvider = providers.find((p) => p.id === selProvider);
  const models = currentProvider?.models ?? [];

  function handleSave() {
    if (selProvider && selModel) {
      onSave({ provider: selProvider, model: selModel });
    } else {
      onSave(null);
    }
    setEditing(false);
  }

  function handleClear() {
    onSave(null);
    setSelProvider(providers[0]?.id ?? "");
    setSelModel("");
    setEditing(false);
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px", borderRadius: 10,
      background: "var(--bg-card)", border: "1px solid var(--border)",
    }}>
      <div style={{
        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
        background: slot ? `color-mix(in srgb, ${color} 15%, transparent)` : "var(--bg-tertiary)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: slot ? color : "var(--text-muted)",
      }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: "var(--text-primary)",
          textTransform: "capitalize",
        }}>
          {tier}
        </div>
        {!editing && (
          <div style={{
            fontSize: 11, color: slot ? "var(--text-secondary)" : "var(--text-muted)",
            fontFamily: "monospace", marginTop: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {slot ? `${slot.provider} / ${slot.model}` : "Not configured"}
          </div>
        )}
      </div>

      {editing ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <select
            value={selProvider}
            onChange={(e) => { setSelProvider(e.target.value); setSelModel(""); }}
            style={{
              fontSize: 11, padding: "5px 8px", borderRadius: 6,
              border: "1px solid var(--border)", background: "var(--bg-tertiary)",
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
              fontSize: 11, padding: "5px 8px", borderRadius: 6,
              border: "1px solid var(--border)", background: "var(--bg-tertiary)",
              color: "var(--text-primary)", fontFamily: "monospace", outline: "none",
              maxWidth: 220,
            }}
          >
            <option value="">Select model...</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button onClick={handleSave} disabled={saving || !selModel} style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 26, height: 26, borderRadius: 6, border: "none",
            background: selModel ? "var(--accent)" : "var(--bg-tertiary)",
            color: selModel ? "#fff" : "var(--text-muted)",
            cursor: selModel ? "pointer" : "default", padding: 0,
          }}>
            <Check size={12} />
          </button>
          {slot && (
            <button onClick={handleClear} title="Clear" style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, borderRadius: 6, border: "1px solid var(--border)",
              background: "transparent", color: "var(--text-muted)",
              cursor: "pointer", padding: 0,
            }}>
              <Trash2 size={11} />
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={() => {
            setSelProvider(slot?.provider ?? providers[0]?.id ?? "");
            setSelModel(slot?.model ?? "");
            setEditing(true);
          }}
          style={{
            fontSize: 11, fontWeight: 500, padding: "4px 12px", borderRadius: 6,
            border: "1px solid var(--border)", background: "var(--bg-tertiary)",
            color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit",
            flexShrink: 0,
          }}
        >
          {slot ? "Change" : "Set"}
        </button>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function SettingsView() {
  // System settings (read-only)
  const { data: settings } = usePolling<SystemSettings>("/api/settings", 10000);

  // Model config
  const { data: modelData, refresh: refreshModels } = usePolling<ModelConfigData>("/api/model-config", 10000);
  const [modelSaving, setModelSaving] = useState(false);

  // MCP config (editable)
  const [mcpConfig, setMcpConfig] = useState<MCPConfig>({ mcpServers: {} });
  const [mcpStatus, setMcpStatus] = useState<MCPStatus>({ servers: [] });
  const [mcpLoading, setMcpLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [newName, setNewName] = useState("");

  const fetchMCP = useCallback(async () => {
    try {
      const [cfgRes, statusRes] = await Promise.all([
        fetch(apiUrl("/api/mcp-config")).then(r => r.json()),
        fetch(apiUrl("/api/mcp-status")).then(r => r.json()),
      ]);
      setMcpConfig(cfgRes);
      setMcpStatus(statusRes);
      const exp: Record<string, boolean> = {};
      for (const k of Object.keys(cfgRes.mcpServers ?? {})) exp[k] = true;
      setExpanded(exp);
    } catch {
      showToast("Failed to load MCP config");
    } finally {
      setMcpLoading(false);
    }
  }, []);

  useEffect(() => { fetchMCP(); }, [fetchMCP]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  // Model tier save
  async function saveModelTier(tier: "primary" | "secondary" | "fallback", slot: ModelSlot | null) {
    setModelSaving(true);
    try {
      await postApi("/api/model-config", { [tier]: slot });
      refreshModels();
      showToast(`${tier.charAt(0).toUpperCase() + tier.slice(1)} model updated`);
    } catch { showToast("Failed to save model config"); }
    finally { setModelSaving(false); }
  }

  // MCP mutations
  function updateServer(name: string, patch: Partial<MCPServer>) {
    setMcpConfig(prev => {
      const next = deepClone(prev);
      next.mcpServers[name] = { ...next.mcpServers[name], ...patch };
      return next;
    });
    setDirty(true);
  }

  function removeServer(name: string) {
    setMcpConfig(prev => {
      const next = deepClone(prev);
      delete next.mcpServers[name];
      return next;
    });
    setDirty(true);
  }

  function addServer() {
    const name = newName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name || mcpConfig.mcpServers[name]) {
      showToast(name ? `"${name}" already exists` : "Enter a server name");
      return;
    }
    setMcpConfig(prev => {
      const next = deepClone(prev);
      next.mcpServers[name] = { ...empty };
      return next;
    });
    setExpanded(prev => ({ ...prev, [name]: true }));
    setNewName("");
    setDirty(true);
  }

  function addEnvVar(name: string) {
    const key = prompt("Environment variable name:");
    if (!key?.trim()) return;
    updateServer(name, {
      env: { ...mcpConfig.mcpServers[name].env, [key.trim()]: "" },
    });
  }

  function removeEnvVar(serverName: string, key: string) {
    const next = { ...mcpConfig.mcpServers[serverName].env };
    delete next[key];
    updateServer(serverName, { env: next });
  }

  async function saveConfig() {
    setSaving(true);
    try {
      const res = await postApi("/api/mcp-config", mcpConfig);
      if (res?.ok) {
        setDirty(false);
        showToast("Saved! Restart server to apply changes.");
        fetchMCP();
      } else {
        showToast("Save failed");
      }
    } catch {
      showToast("Save failed");
    } finally {
      setSaving(false);
    }
  }

  const serverNames = Object.keys(mcpConfig.mcpServers);
  const s = settings;
  const integ = s?.integrations;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div className="page-header" style={{ padding: "24px 28px 16px" }}>
        <h1 className="page-title">Settings</h1>
        <div className="page-subtitle">
          System configuration, integrations &amp; MCP servers
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "0 28px 28px" }}>

        {/* ═══ Integrations ═══ */}
        <Section title="Integrations" icon={<Zap size={15} style={{ color: "var(--accent)" }} />}>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 8,
          }}>
            <IntegrationCard
              name="Telegram"
              icon={<MessageSquare size={16} />}
              configured={integ?.telegram.configured ?? false}
              detail={integ?.telegram.configured ? `Chat: ${integ.telegram.chatId}` : "Set TELEGRAM_BOT_TOKEN + CHAT_ID"}
              color="var(--blue)"
            />
            <IntegrationCard
              name="Web Search (SearXNG)"
              icon={<Search size={16} />}
              configured={integ?.searxng.configured ?? false}
              detail={integ?.searxng.url ?? "Set SEARXNG_URL"}
              color="var(--green)"
            />
            <IntegrationCard
              name="SonarQube"
              icon={<Eye size={16} />}
              configured={integ?.sonarqube.configured ?? false}
              detail={integ?.sonarqube.configured
                ? `${integ.sonarqube.hostUrl} (${integ.sonarqube.projectKey})`
                : "Set SONAR_TOKEN to enable"}
              color="var(--blue)"
            />
            <IntegrationCard
              name="Gitleaks"
              icon={<Shield size={16} />}
              configured={integ?.gitleaks.configured ?? false}
              detail="Secret scanning via Docker"
              color="var(--red)"
            />
            <IntegrationCard
              name="Semgrep"
              icon={<Shield size={16} />}
              configured={integ?.semgrep.configured ?? false}
              detail="SAST — OWASP Top 10 scanning"
              color="var(--orange)"
            />
            <IntegrationCard
              name="Trivy"
              icon={<Database size={16} />}
              configured={integ?.trivy.configured ?? false}
              detail="SCA — dependency vulnerability scanning"
              color="var(--purple)"
            />
          </div>
        </Section>

        {/* ═══ Models ═══ */}
        <Section title="Models" icon={<Box size={15} style={{ color: "var(--purple)" }} />}>
          {modelData ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Provider list */}
              <div>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: "var(--text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
                }}>
                  Providers
                </div>
                <div style={{
                  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: 8,
                }}>
                  {modelData.providers.map((p) => (
                    <div key={p.id} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 12px", borderRadius: 8,
                      background: "var(--bg-card)", border: "1px solid var(--border)",
                    }}>
                      <div style={{
                        width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                        background: p.configured ? "var(--green)" : "var(--text-muted)",
                        opacity: p.configured ? 1 : 0.4,
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                          {p.name}
                        </div>
                        <div style={{
                          fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace",
                        }}>
                          {p.models.length} models · {p.envKey}
                        </div>
                      </div>
                      <span style={{
                        fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
                        background: p.configured
                          ? "color-mix(in srgb, var(--green) 12%, transparent)"
                          : "var(--bg-tertiary)",
                        color: p.configured ? "var(--green)" : "var(--text-muted)",
                      }}>
                        {p.configured ? "READY" : "NO KEY"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Priority tiers */}
              <div>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: "var(--text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
                }}>
                  Model Priority
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {(["primary", "secondary", "fallback"] as const).map((tier) => {
                    const slot = modelData.config[tier];
                    const tierColors = {
                      primary: "var(--accent)",
                      secondary: "var(--yellow)",
                      fallback: "var(--text-muted)",
                    };
                    const tierIcons = {
                      primary: <Star size={12} />,
                      secondary: <Cpu size={12} />,
                      fallback: <Shield size={12} />,
                    };
                    const configuredProviders = modelData.providers.filter((p) => p.configured);

                    return (
                      <ModelTierRow
                        key={tier}
                        tier={tier}
                        slot={slot}
                        color={tierColors[tier]}
                        icon={tierIcons[tier]}
                        providers={configuredProviders}
                        onSave={(s) => saveModelTier(tier, s)}
                        saving={modelSaving}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Per-agent overrides summary */}
              {Object.keys(modelData.config.agentModels).length > 0 && (
                <div>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: "var(--text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
                  }}>
                    Agent Overrides
                  </div>
                  <div style={{
                    display: "flex", flexWrap: "wrap", gap: 6,
                  }}>
                    {Object.entries(modelData.config.agentModels).map(([agentId, s]) => (
                      <span key={agentId} style={{
                        fontSize: 11, padding: "4px 10px", borderRadius: 6,
                        background: "var(--bg-card)", border: "1px solid var(--border)",
                        color: "var(--text-secondary)", fontFamily: "monospace",
                      }}>
                        @{agentId} → {s.provider}/{s.model.split("/").pop()}
                      </span>
                    ))}
                  </div>
                  <div style={{
                    fontSize: 11, color: "var(--text-muted)", marginTop: 6, paddingLeft: 2,
                  }}>
                    Per-agent models can be configured from the Directory view.
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>Loading...</div>
          )}
        </Section>

        {/* ═══ LLM Configuration ═══ */}
        <Section title="LLM Defaults" icon={<Cpu size={15} style={{ color: "var(--purple)" }} />}>
          <div style={{
            background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: 10, padding: "4px 14px",
          }}>
            {s ? (
              <>
                <ConfigRow label="Provider (env)" value={s.llm.provider} />
                <ConfigRow label="Model (env)" value={s.llm.model} />
                <ConfigRow label="Thinking Level" value={s.llm.thinkingLevel} />
                <ConfigRow label="Temperature" value={s.llm.temperature} />
                <ConfigRow label="Max Tokens" value={s.llm.maxTokens.toLocaleString()} />
              </>
            ) : (
              <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>Loading...</div>
            )}
          </div>
          <div style={{
            fontSize: 11, color: "var(--text-muted)", marginTop: 8, paddingLeft: 2,
          }}>
            Environment defaults — overridden by Models priority above when set.
          </div>
        </Section>

        {/* ═══ System ═══ */}
        <Section title="System" icon={<Settings2 size={15} style={{ color: "var(--green)" }} />}>
          <div style={{
            background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: 10, padding: "4px 14px",
          }}>
            {s ? (
              <>
                <ConfigRow label="Company Name" value={s.system.companyName} />
                <ConfigRow label="CLI" value={s.system.cliEnabled} />
                <ConfigRow label="PM Proactive Loop" value={s.proactive.enabled} />
                {s.proactive.enabled && (
                  <ConfigRow label="Proactive Interval" value={`${s.proactive.intervalSecs}s`} />
                )}
                <ConfigRow label="Dashboard Port" value={s.system.dashboardPort} />
                <ConfigRow label="Debounce Window" value={`${s.system.debounceMs}ms`} />
                <ConfigRow label="Context Window" value={`${(s.system.contextWindow / 1000).toFixed(0)}K tokens`} />
                <ConfigRow label="Compact Threshold" value={`${(s.system.compactThreshold * 100).toFixed(0)}%`} />
              </>
            ) : (
              <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>Loading...</div>
            )}
          </div>
        </Section>

        {/* ═══ MCP Servers ═══ */}
        <Section
          title={`MCP Servers (${serverNames.length})`}
          icon={<Server size={15} style={{ color: "var(--orange)" }} />}
          defaultOpen={false}
        >
          <div style={{
            background: "var(--bg-tertiary)", borderRadius: 8,
            padding: "8px 12px", marginBottom: 14,
            fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6,
          }}>
            Model Context Protocol servers provide additional tools to agents.
            Config saved to <code style={{
              background: "var(--bg-primary)", padding: "1px 5px", borderRadius: 3, fontSize: 11,
            }}>data/mcp-servers.json</code>. Restart after changes.
            {mcpStatus.servers.filter(s => s.connected).length > 0 && (
              <span style={{ color: "var(--green)", marginLeft: 8 }}>
                &bull; {mcpStatus.servers.filter(s => s.connected).length} connected
              </span>
            )}
          </div>

          {/* Action bar */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
          }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addServer()}
              placeholder="New server name..."
              style={{ ...inputStyle, flex: 1, maxWidth: 240 }}
            />
            <button onClick={addServer} style={btnSecondary}>
              <Plus size={13} /> Add
            </button>
            <button onClick={fetchMCP} style={btnSecondary} title="Refresh">
              <RefreshCw size={13} />
            </button>
            {dirty && (
              <button onClick={saveConfig} disabled={saving} style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 14px", borderRadius: 7, border: "none",
                background: "var(--accent)", color: "#fff",
                cursor: saving ? "wait" : "pointer", fontSize: 12,
                fontWeight: 500, fontFamily: "inherit",
                opacity: saving ? 0.7 : 1,
              }}>
                <Save size={13} /> {saving ? "Saving..." : "Save"}
              </button>
            )}
          </div>

          {/* Server list */}
          {mcpLoading ? (
            <div style={{ textAlign: "center", padding: 32, color: "var(--text-muted)", fontSize: 12 }}>
              Loading...
            </div>
          ) : serverNames.length === 0 ? (
            <div style={{
              textAlign: "center", padding: "32px 0",
              color: "var(--text-muted)", fontSize: 12,
            }}>
              No MCP servers configured.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {serverNames.map(name => {
                const srv = mcpConfig.mcpServers[name];
                const live = mcpStatus.servers.find(s => s.name === name);
                const isOpen = expanded[name] ?? false;

                return (
                  <div key={name} style={{
                    background: "var(--bg-card)", border: "1px solid var(--border)",
                    borderRadius: 8, overflow: "hidden",
                  }}>
                    {/* Server header */}
                    <div
                      onClick={() => setExpanded(p => ({ ...p, [name]: !p[name] }))}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "10px 14px", cursor: "pointer",
                        borderBottom: isOpen ? "1px solid var(--border)" : "none",
                      }}
                    >
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <span style={{
                        fontSize: 13, fontWeight: 600, color: "var(--text-primary)", flex: 1,
                      }}>
                        {name}
                      </span>
                      <span style={{
                        width: 8, height: 8, borderRadius: "50%",
                        background: live?.connected ? "var(--green)" : "var(--text-muted)",
                        flexShrink: 0,
                      }} title={live?.connected ? "Connected" : "Disconnected"} />
                      {live?.connected && (
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {live.tools.length} tool{live.tools.length !== 1 ? "s" : ""}
                        </span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); removeServer(name); }}
                        title="Remove server"
                        style={{
                          display: "flex", padding: 4, border: "none", borderRadius: 4,
                          background: "transparent", color: "var(--text-muted)", cursor: "pointer",
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = "var(--red)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={e => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {/* Server body */}
                    {isOpen && (
                      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                        <Field label="Command" hint="e.g. npx, node, python">
                          <input
                            value={srv.command}
                            onChange={e => updateServer(name, { command: e.target.value })}
                            placeholder="npx"
                            style={inputStyle}
                          />
                        </Field>

                        <Field label="Arguments" hint="One per line">
                          <textarea
                            value={(srv.args ?? []).join("\n")}
                            onChange={e => updateServer(name, { args: e.target.value.split("\n") })}
                            placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"}
                            rows={3}
                            style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}
                          />
                        </Field>

                        <div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                            <label style={labelStyle}>Environment Variables</label>
                            <button onClick={() => addEnvVar(name)} style={btnSecondary}>
                              <Plus size={12} /> Add
                            </button>
                          </div>
                          {Object.keys(srv.env ?? {}).length === 0 ? (
                            <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                              No environment variables
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {Object.entries(srv.env ?? {}).map(([k, v]) => (
                                <div key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                  <span style={{
                                    fontSize: 12, fontFamily: "monospace", color: "var(--text-secondary)",
                                    minWidth: 100, flexShrink: 0,
                                  }}>
                                    {k}
                                  </span>
                                  <input
                                    value={v}
                                    onChange={e => {
                                      const env = { ...srv.env, [k]: e.target.value };
                                      updateServer(name, { env });
                                    }}
                                    placeholder="value"
                                    style={{ ...inputStyle, flex: 1 }}
                                  />
                                  <button
                                    onClick={() => removeEnvVar(name, k)}
                                    style={{
                                      display: "flex", padding: 4, border: "none",
                                      background: "transparent", color: "var(--text-muted)",
                                      cursor: "pointer", borderRadius: 4,
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.color = "var(--red)"; }}
                                    onMouseLeave={e => { e.currentTarget.style.color = "var(--text-muted)"; }}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {live?.connected && live.tools.length > 0 && (
                          <div>
                            <label style={labelStyle}>Discovered Tools</label>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                              {live.tools.map(t => (
                                <span key={t} style={{
                                  fontSize: 11, padding: "2px 8px", borderRadius: 4,
                                  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
                                  fontFamily: "monospace",
                                }}>
                                  {t}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24,
          background: "var(--bg-card)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "10px 18px",
          fontSize: 13, color: "var(--text-primary)",
          boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
          zIndex: 9999,
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Shared styles ────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-tertiary)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: "var(--text-muted)",
  marginBottom: 4,
  display: "block",
};

const btnSecondary: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5,
  padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  cursor: "pointer", fontSize: 11, fontFamily: "inherit",
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={labelStyle}>
        {label}
        {hint && <span style={{ fontWeight: 400, marginLeft: 6, opacity: 0.7 }}>{hint}</span>}
      </label>
      {children}
    </div>
  );
}
