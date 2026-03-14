import { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, RefreshCw, Server, ChevronDown, ChevronRight,
  Shield, Search, MessageSquare, Cpu, Box, ExternalLink,
  Zap, Settings2, Database, Eye, Star, Check, X, Package,
  Hash, Globe, Radio,
} from "lucide-react";
import { postApi, apiUrl } from "../hooks/useApi";
import { usePolling } from "../hooks/useApi";
import Dropdown, { type DropdownOption } from "../components/Dropdown";
import MCP_DIRECTORY, { CATEGORY_META, type MCPDirectoryEntry, type MCPCategory } from "../data/mcpDirectory";

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
  iconUrl: string;
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
    slack?: { configured: boolean; channelId: string };
    searxng: { configured: boolean; url: string };
    sonarqube: { configured: boolean; hostUrl: string; projectKey: string };
    gitleaks: { configured: boolean };
    semgrep: { configured: boolean };
    trivy: { configured: boolean };
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function deepClone<T>(obj: T): T { return JSON.parse(JSON.stringify(obj)); }

// ── Settings section type ────────────────────────────────────────────────────

type SettingsSection = "general" | "models" | "channels" | "integrations" | "mcp";

const SECTION_NAV: { key: SettingsSection; label: string; icon: React.ReactNode; color: string }[] = [
  { key: "general", label: "General", icon: <Settings2 size={15} />, color: "var(--text-secondary)" },
  { key: "models", label: "Models", icon: <Box size={15} />, color: "var(--purple)" },
  { key: "channels", label: "Channels", icon: <Radio size={15} />, color: "var(--blue)" },
  { key: "integrations", label: "Integrations", icon: <Zap size={15} />, color: "var(--orange)" },
  { key: "mcp", label: "MCP Servers", icon: <Server size={15} />, color: "var(--green)" },
];

// ── Logo icon helper ─────────────────────────────────────────────────────────

function LogoIcon({ src, fallback, size = 20 }: { src: string; fallback: React.ReactNode; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt=""
      style={{ width: size, height: size, borderRadius: 3, filter: "var(--icon-filter, none)" }}
      onError={() => setFailed(true)}
    />
  );
}

// ── Channel card ─────────────────────────────────────────────────────────────

function ChannelCard({ name, logoUrl, fallbackIcon, configured, detail, color, envHint }: {
  name: string;
  logoUrl: string;
  fallbackIcon: React.ReactNode;
  configured: boolean;
  detail?: string;
  color: string;
  envHint: string;
}) {
  return (
    <div style={{
      padding: "16px 18px", borderRadius: 10,
      background: "var(--bg-card)", border: "1px solid var(--border)",
      transition: "border-color 0.12s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
        <div style={{
          width: 42, height: 42, borderRadius: 10,
          background: configured ? `color-mix(in srgb, ${color} 10%, transparent)` : "var(--bg-tertiary)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: configured ? color : "var(--text-muted)",
          flexShrink: 0,
        }}>
          <LogoIcon src={logoUrl} fallback={fallbackIcon} size={22} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {name}
          </div>
          <div style={{
            fontSize: 10, color: "var(--text-muted)", marginTop: 2,
            fontFamily: "monospace", letterSpacing: "0.02em",
          }}>
            {envHint}
          </div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 6,
          background: configured
            ? "color-mix(in srgb, var(--green) 10%, transparent)"
            : "var(--bg-tertiary)",
          color: configured ? "var(--green)" : "var(--text-muted)",
          border: `1px solid ${configured ? "color-mix(in srgb, var(--green) 18%, transparent)" : "var(--border)"}`,
          flexShrink: 0, letterSpacing: "0.04em",
        }}>
          {configured ? "CONNECTED" : "NOT SET"}
        </span>
      </div>
      {detail && (
        <div style={{
          fontSize: 12, color: "var(--text-secondary)",
          padding: "8px 12px", borderRadius: 7,
          background: "var(--bg-tertiary)",
          fontFamily: "monospace",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {detail}
        </div>
      )}
    </div>
  );
}

// ── Integration card ────────────────────────────────────────────────────────

function IntegrationCard({ name, logoUrl, fallbackIcon, configured, detail, color, subtitle }: {
  name: string;
  logoUrl: string;
  fallbackIcon: React.ReactNode;
  configured: boolean;
  detail?: string;
  color: string;
  subtitle?: string;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "14px 16px", borderRadius: 10,
      background: "var(--bg-card)", border: "1px solid var(--border)",
      transition: "border-color 0.12s",
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 9,
        background: configured ? `color-mix(in srgb, ${color} 10%, transparent)` : "var(--bg-tertiary)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: configured ? color : "var(--text-muted)",
        flexShrink: 0,
      }}>
        <LogoIcon src={logoUrl} fallback={fallbackIcon} size={20} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            {name}
          </span>
          {subtitle && (
            <span style={{
              fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
              background: `color-mix(in srgb, ${color} 10%, transparent)`,
              color, letterSpacing: "0.04em",
            }}>
              {subtitle}
            </span>
          )}
        </div>
        {detail && (
          <div style={{
            fontSize: 11, color: "var(--text-muted)", marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {detail}
          </div>
        )}
      </div>
      <div style={{
        width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
        background: configured ? "var(--green)" : "var(--text-muted)",
        opacity: configured ? 1 : 0.4,
      }} />
    </div>
  );
}

// ── Config row (read-only) ──────────────────────────────────────────────────

function ConfigRow({ label, value, icon }: { label: string; value: string | number | boolean; icon?: React.ReactNode }) {
  const display = typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : String(value);
  const isBool = typeof value === "boolean";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 0",
      borderBottom: "1px solid var(--border)",
    }}>
      {icon && (
        <span style={{ color: "var(--text-muted)", flexShrink: 0, display: "flex" }}>
          {icon}
        </span>
      )}
      <span style={{ fontSize: 13, color: "var(--text-secondary)", flex: 1 }}>{label}</span>
      {isBool ? (
        <span style={{
          fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 5,
          background: value ? "var(--green-bg)" : "var(--bg-tertiary)",
          color: value ? "var(--green)" : "var(--text-muted)",
        }}>
          {display}
        </span>
      ) : (
        <span style={{
          fontSize: 12, color: "var(--text-primary)", fontFamily: "monospace",
          background: "var(--bg-tertiary)", padding: "3px 10px", borderRadius: 5,
        }}>
          {display}
        </span>
      )}
    </div>
  );
}

// ── Model tier row ──────────────────────────────────────────────────────────

function ModelTierRow({ tier, slot, color, icon, providers, onSave, saving }: {
  tier: string;
  slot: ModelSlot | null;
  color: string;
  icon: React.ReactNode;
  providers: ProviderInfo[];
  onSave: (slot: ModelSlot | null) => void;
  saving: boolean;
}) {
  const [selProvider, setSelProvider] = useState(slot?.provider ?? "");
  const [selModel, setSelModel] = useState(slot?.model ?? "");
  const [dirty, setDirty] = useState(false);

  const currentProvider = providers.find((p) => p.id === selProvider);
  const models = currentProvider?.models ?? [];

  const providerOpts: DropdownOption[] = providers.map((p) => ({
    value: p.id,
    label: `${p.name} (${p.models.length})`,
    iconUrl: p.iconUrl,
  }));

  const modelOpts: DropdownOption[] = models.map((m) => ({
    value: m,
    label: m,
  }));

  function handleProviderChange(pid: string) {
    setSelProvider(pid);
    setSelModel("");
    setDirty(true);
  }

  function handleModelChange(mid: string) {
    setSelModel(mid);
    setDirty(true);
  }

  function handleApply() {
    if (selProvider && selModel) {
      onSave({ provider: selProvider, model: selModel });
    }
    setDirty(false);
  }

  function handleClear() {
    onSave(null);
    setSelProvider("");
    setSelModel("");
    setDirty(false);
  }

  return (
    <div style={{
      padding: "14px 16px", borderRadius: 10,
      background: "var(--bg-card)", border: "1px solid var(--border)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8, flexShrink: 0,
          background: slot ? `color-mix(in srgb, ${color} 12%, transparent)` : "var(--bg-tertiary)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: slot ? color : "var(--text-muted)",
        }}>
          {icon}
        </div>
        <span style={{
          fontSize: 14, fontWeight: 600, color: "var(--text-primary)",
          textTransform: "capitalize", flex: 1,
        }}>
          {tier}
        </span>
        {slot && (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 5,
            background: `color-mix(in srgb, ${color} 10%, transparent)`,
            color, letterSpacing: "0.04em",
          }}>
            SET
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Dropdown
          value={selProvider}
          onChange={handleProviderChange}
          options={providerOpts}
          placeholder="Select provider..."
          alignRight={false}
        />
        {selProvider && (
          <Dropdown
            value={selModel}
            onChange={handleModelChange}
            options={modelOpts}
            placeholder={`Select model (${models.length})...`}
            alignRight={false}
          />
        )}
        {dirty && selModel && (
          <button onClick={handleApply} disabled={saving} style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            height: 32, padding: "0 14px", borderRadius: 7, border: "none",
            background: "var(--accent)", color: "#fff", fontSize: 11, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
            opacity: saving ? 0.5 : 1, transition: "opacity 0.12s",
          }}>
            <Check size={12} style={{ marginRight: 4 }} /> Apply
          </button>
        )}
        {slot && !dirty && (
          <button onClick={handleClear} disabled={saving} title="Clear this tier" style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 32, height: 32, borderRadius: 7, flexShrink: 0,
            border: "1px solid var(--border)", background: "transparent",
            color: "var(--text-muted)", cursor: "pointer", padding: 0,
            transition: "color 0.12s, border-color 0.12s",
          }}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Section label (uppercase) ───────────────────────────────────────────────

function SectionLabel({ title, count }: { title: string; count?: number }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      fontSize: 11, fontWeight: 600, color: "var(--text-muted)",
      textTransform: "uppercase", letterSpacing: "0.04em",
      marginBottom: 10,
    }}>
      {title}
      {count !== undefined && (
        <span style={{
          fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4,
          background: "var(--bg-tertiary)", color: "var(--text-muted)",
          fontVariantNumeric: "tabular-nums",
        }}>
          {count}
        </span>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function SettingsView() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");

  // System settings (read-only)
  const { data: settings } = usePolling<SystemSettings>("/api/settings", 10000);

  // Model config
  const { data: modelData, refresh: refreshModels } = usePolling<ModelConfigData>("/api/model-config", 10000);
  const [modelSaving, setModelSaving] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keySaving, setKeySaving] = useState(false);

  // MCP config (editable)
  const [mcpConfig, setMcpConfig] = useState<MCPConfig>({ mcpServers: {} });
  const [mcpStatus, setMcpStatus] = useState<MCPStatus>({ servers: [] });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
    }
  }, []);

  useEffect(() => { fetchMCP(); }, [fetchMCP]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function saveModelTier(tier: "primary" | "secondary" | "fallback", slot: ModelSlot | null) {
    setModelSaving(true);
    try {
      await postApi("/api/model-config", { [tier]: slot });
      refreshModels();
      showToast(`${tier.charAt(0).toUpperCase() + tier.slice(1)} model updated`);
    } catch { showToast("Failed to save model config"); }
    finally { setModelSaving(false); }
  }

  async function saveProviderKey(providerId: string) {
    setKeySaving(true);
    try {
      await postApi("/api/provider-key", { provider: providerId, key: keyInput });
      refreshModels();
      showToast("API key saved");
      setEditingProvider(null);
      setKeyInput("");
    } catch { showToast("Failed to save API key"); }
    finally { setKeySaving(false); }
  }

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

  // ── Count stats for sidebar badges ────────────────────────────────────────

  const configuredProviders = modelData?.providers.filter(p => p.configured).length ?? 0;
  const channelCount = [integ?.telegram.configured, integ?.slack?.configured].filter(Boolean).length;
  const integCount = [integ?.searxng.configured, integ?.sonarqube.configured, integ?.gitleaks.configured, integ?.semgrep.configured, integ?.trivy.configured].filter(Boolean).length;
  const connectedServers = mcpStatus.servers.filter(s => s.connected).length;

  // ── Section renderers ────────────────────────────────────────────────────

  function renderGeneral() {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Quick stats */}
        {s && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { label: "Company", value: s.system.companyName, color: "var(--accent)" },
              { label: "Provider", value: s.llm.provider, color: "var(--purple)" },
              { label: "Model", value: s.llm.model.split("/").pop() ?? s.llm.model, color: "var(--blue)" },
              { label: "Dashboard", value: `:${s.system.dashboardPort}`, color: "var(--green)" },
            ].map((stat) => (
              <div key={stat.label} style={{
                flex: "1 1 120px", padding: "14px 16px",
                background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: stat.color, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" }}>
                  {stat.value}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{stat.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* System config */}
        <div>
          <SectionLabel title="System" />
          <div className="vec-card" style={{ padding: "4px 16px" }}>
            {s ? (
              <>
                <ConfigRow label="Company Name" value={s.system.companyName} icon={<Globe size={13} />} />
                <ConfigRow label="CLI Enabled" value={s.system.cliEnabled} />
                <ConfigRow label="PM Proactive Loop" value={s.proactive.enabled} />
                {s.proactive.enabled && (
                  <ConfigRow label="Proactive Interval" value={`${s.proactive.intervalSecs}s`} />
                )}
                <ConfigRow label="Dashboard Port" value={s.system.dashboardPort} icon={<Hash size={13} />} />
                <ConfigRow label="Debounce Window" value={`${s.system.debounceMs}ms`} />
                <ConfigRow label="Context Window" value={`${(s.system.contextWindow / 1000).toFixed(0)}K tokens`} />
                <ConfigRow label="Compact Threshold" value={`${(s.system.compactThreshold * 100).toFixed(0)}%`} />
              </>
            ) : (
              <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>Loading...</div>
            )}
          </div>
        </div>

        {/* LLM Defaults */}
        <div>
          <SectionLabel title="LLM Defaults" />
          <div className="vec-card" style={{ padding: "4px 16px" }}>
            {s ? (
              <>
                <ConfigRow label="Provider" value={s.llm.provider} icon={<Cpu size={13} />} />
                <ConfigRow label="Model" value={s.llm.model} icon={<Box size={13} />} />
                <ConfigRow label="Thinking Level" value={s.llm.thinkingLevel} />
                <ConfigRow label="Temperature" value={s.llm.temperature} />
                <ConfigRow label="Max Tokens" value={s.llm.maxTokens.toLocaleString()} />
              </>
            ) : (
              <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>Loading...</div>
            )}
          </div>
          <div style={{
            fontSize: 11, color: "var(--text-muted)", marginTop: 8, paddingLeft: 2,
          }}>
            Environment defaults — overridden by model priority tiers when set.
          </div>
        </div>
      </div>
    );
  }

  function renderModels() {
    if (!modelData) {
      return <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>Loading...</div>;
    }

    const configured = modelData.providers.filter(p => p.configured);
    const unconfigured = modelData.providers.filter(p => !p.configured);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Provider stats */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[
            { label: "Providers Ready", value: String(configured.length), color: "var(--green)" },
            { label: "Total Models", value: String(modelData.providers.reduce((a, p) => a + p.models.length, 0)), color: "var(--blue)" },
            { label: "Priority Tiers Set", value: String([modelData.config.primary, modelData.config.secondary, modelData.config.fallback].filter(Boolean).length) + "/3", color: "var(--purple)" },
            { label: "Agent Overrides", value: String(Object.keys(modelData.config.agentModels).length), color: "var(--orange)" },
          ].map((stat) => (
            <div key={stat.label} style={{
              flex: "1 1 120px", padding: "14px 16px",
              background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
            }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: stat.color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                {stat.value}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Configured providers */}
        <div>
          <SectionLabel title="Configured Providers" count={configured.length} />
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 8,
          }}>
            {configured.map((p) => (
              <ProviderCard key={p.id} provider={p} isEditing={editingProvider === p.id}
                keyInput={keyInput} keySaving={keySaving}
                onToggleEdit={() => {
                  if (editingProvider === p.id) { setEditingProvider(null); setKeyInput(""); }
                  else { setEditingProvider(p.id); setKeyInput(""); }
                }}
                onKeyChange={setKeyInput}
                onSave={() => saveProviderKey(p.id)}
              />
            ))}
          </div>
        </div>

        {/* Unconfigured providers */}
        {unconfigured.length > 0 && (
          <div>
            <SectionLabel title="Available Providers" count={unconfigured.length} />
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 8,
            }}>
              {unconfigured.map((p) => (
                <ProviderCard key={p.id} provider={p} isEditing={editingProvider === p.id}
                  keyInput={keyInput} keySaving={keySaving}
                  onToggleEdit={() => {
                    if (editingProvider === p.id) { setEditingProvider(null); setKeyInput(""); }
                    else { setEditingProvider(p.id); setKeyInput(""); }
                  }}
                  onKeyChange={setKeyInput}
                  onSave={() => saveProviderKey(p.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Priority tiers */}
        <div>
          <SectionLabel title="Model Priority" />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(["primary", "secondary", "fallback"] as const).map((tier) => {
              const slot = modelData.config[tier];
              const tierColors = {
                primary: "var(--accent)",
                secondary: "var(--yellow)",
                fallback: "var(--text-muted)",
              };
              const tierIcons = {
                primary: <Star size={14} />,
                secondary: <Cpu size={14} />,
                fallback: <Shield size={14} />,
              };
              const provs = modelData.providers.filter((p) => p.configured);
              return (
                <ModelTierRow
                  key={tier}
                  tier={tier}
                  slot={slot}
                  color={tierColors[tier]}
                  icon={tierIcons[tier]}
                  providers={provs}
                  onSave={(s) => saveModelTier(tier, s)}
                  saving={modelSaving}
                />
              );
            })}
          </div>
        </div>

        {/* Per-agent overrides */}
        {Object.keys(modelData.config.agentModels).length > 0 && (
          <div>
            <SectionLabel title="Agent Overrides" count={Object.keys(modelData.config.agentModels).length} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Object.entries(modelData.config.agentModels).map(([agentId, s]) => (
                <span key={agentId} style={{
                  fontSize: 12, padding: "6px 12px", borderRadius: 7,
                  background: "var(--bg-card)", border: "1px solid var(--border)",
                  color: "var(--text-secondary)", fontFamily: "monospace",
                }}>
                  @{agentId} &rarr; {s.provider}/{s.model.split("/").pop()}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, paddingLeft: 2 }}>
              Per-agent models can be configured from the Directory view.
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderChannels() {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Stats */}
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{
            flex: "1 1 140px", padding: "14px 16px",
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--blue)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              {channelCount}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Active Channels</div>
          </div>
          <div style={{
            flex: "1 1 140px", padding: "14px 16px",
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-muted)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              {2 - channelCount}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Not Configured</div>
          </div>
        </div>

        {/* Channel cards */}
        <div>
          <SectionLabel title="Communication Channels" />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <ChannelCard
              name="Telegram"
              logoUrl="/icons/integrations/telegram.svg"
              fallbackIcon={<MessageSquare size={18} />}
              configured={integ?.telegram.configured ?? false}
              detail={integ?.telegram.configured ? `Chat ID: ${integ.telegram.chatId}` : undefined}
              color="var(--blue)"
              envHint="TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID"
            />
            <ChannelCard
              name="Slack"
              logoUrl="/icons/integrations/slack.svg"
              fallbackIcon={<Hash size={18} />}
              configured={integ?.slack?.configured ?? false}
              detail={integ?.slack?.configured ? `Channel: ${integ.slack.channelId}` : undefined}
              color="var(--purple)"
              envHint="SLACK_BOT_TOKEN + SLACK_APP_TOKEN + SLACK_CHANNEL_ID"
            />
          </div>
        </div>

        <div style={{
          padding: "14px 16px", borderRadius: 8,
          background: "var(--bg-tertiary)", border: "1px solid var(--border)",
          fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6,
        }}>
          Channels are configured via environment variables in your <code style={{
            fontFamily: "monospace", fontSize: 11, background: "var(--bg-card)",
            padding: "1px 5px", borderRadius: 3,
          }}>.env</code> file. Restart the server after making changes.
        </div>
      </div>
    );
  }

  function renderIntegrations() {
    const ICON_BASE = "/icons/integrations";

    const categories: { title: string; color: string; items: { name: string; logoUrl: string; fallbackIcon: React.ReactNode; configured: boolean; detail: string; color: string; subtitle: string }[] }[] = [
      {
        title: "Search",
        color: "var(--green)",
        items: [
          {
            name: "SearXNG", logoUrl: `${ICON_BASE}/searxng.svg`, fallbackIcon: <Search size={16} />,
            configured: integ?.searxng.configured ?? false,
            detail: integ?.searxng.configured ? integ.searxng.url : "Set SEARXNG_URL to enable",
            color: "var(--green)", subtitle: "WEB SEARCH",
          },
        ],
      },
      {
        title: "Code Quality",
        color: "var(--blue)",
        items: [
          {
            name: "SonarQube", logoUrl: `${ICON_BASE}/sonarqube.svg`, fallbackIcon: <Eye size={16} />,
            configured: integ?.sonarqube.configured ?? false,
            detail: integ?.sonarqube.configured ? `${integ.sonarqube.hostUrl} (${integ.sonarqube.projectKey})` : "Set SONAR_TOKEN to enable",
            color: "var(--blue)", subtitle: "ANALYSIS",
          },
        ],
      },
      {
        title: "Security Scanners",
        color: "var(--red)",
        items: [
          {
            name: "Gitleaks", logoUrl: `${ICON_BASE}/gitleaks.svg`, fallbackIcon: <Shield size={16} />,
            configured: integ?.gitleaks.configured ?? false,
            detail: "Secret scanning — detects hardcoded credentials via Docker",
            color: "var(--red)", subtitle: "SECRETS",
          },
          {
            name: "Semgrep", logoUrl: `${ICON_BASE}/semgrep.svg`, fallbackIcon: <Shield size={16} />,
            configured: integ?.semgrep.configured ?? false,
            detail: "SAST — static analysis for OWASP Top 10 vulnerabilities",
            color: "var(--orange)", subtitle: "SAST",
          },
          {
            name: "Trivy", logoUrl: `${ICON_BASE}/trivy.svg`, fallbackIcon: <Database size={16} />,
            configured: integ?.trivy.configured ?? false,
            detail: "SCA — scans dependencies for known CVEs",
            color: "var(--purple)", subtitle: "SCA",
          },
        ],
      },
    ];

    const allItems = categories.flatMap(c => c.items);
    const activeCount = allItems.filter(i => i.configured).length;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Stats */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[
            { label: "Active", value: String(activeCount), color: "var(--green)" },
            { label: "Total", value: String(allItems.length), color: "var(--orange)" },
            { label: "Categories", value: String(categories.length), color: "var(--blue)" },
          ].map((stat) => (
            <div key={stat.label} style={{
              flex: "1 1 120px", padding: "14px 16px",
              background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
            }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: stat.color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                {stat.value}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Categorized integrations */}
        {categories.map((cat) => (
          <div key={cat.title}>
            <SectionLabel title={cat.title} count={cat.items.length} />
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: 8,
            }}>
              {cat.items.map((item) => (
                <IntegrationCard key={item.name} {...item} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderMCP() {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Stats */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[
            { label: "Configured", value: String(serverNames.length), color: "var(--blue)" },
            { label: "Connected", value: String(connectedServers), color: "var(--green)" },
            { label: "Tools Available", value: String(mcpStatus.servers.reduce((a, s) => a + s.tools.length, 0)), color: "var(--purple)" },
            { label: "Directory", value: String(MCP_DIRECTORY.length), color: "var(--text-muted)" },
          ].map((stat) => (
            <div key={stat.label} style={{
              flex: "1 1 100px", padding: "14px 16px",
              background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
            }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: stat.color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                {stat.value}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Action bar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <div style={{ flex: 1 }} />
          <button onClick={fetchMCP} style={btnSecondary} title="Refresh status">
            <RefreshCw size={12} /> Refresh
          </button>
          {dirty && (
            <button onClick={saveConfig} disabled={saving} style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "6px 14px", borderRadius: 7, border: "none",
              background: "var(--accent)", color: "#fff",
              cursor: saving ? "wait" : "pointer", fontSize: 11,
              fontWeight: 600, fontFamily: "inherit",
              opacity: saving ? 0.7 : 1, transition: "opacity 0.12s",
            }}>
              <Save size={11} /> {saving ? "Saving..." : "Save Changes"}
            </button>
          )}
        </div>

        {/* Server Directory + Custom Servers */}
        <MCPDirectoryPanel
          activeServerNames={serverNames}
          mcpConfig={mcpConfig}
          mcpStatus={mcpStatus}
          onAdd={(entry, envOverrides) => {
            const env: Record<string, string> = {};
            for (const k of Object.keys(entry.envVars)) {
              env[k] = envOverrides?.[k] ?? "";
            }
            setMcpConfig(prev => {
              const next = deepClone(prev);
              next.mcpServers[entry.id] = {
                command: entry.command,
                args: [...entry.args],
                env,
              };
              return next;
            });
            setDirty(true);
            showToast(`Added "${entry.name}" — click Save to apply`);
          }}
          onRemove={(name) => { removeServer(name); }}
          onAddCustom={(name, srv) => {
            setMcpConfig(prev => {
              const next = deepClone(prev);
              next.mcpServers[name] = srv;
              return next;
            });
            setExpanded(prev => ({ ...prev, [name]: true }));
            setDirty(true);
            showToast(`Added "${name}" — click Save to apply`);
          }}
          onUpdateCustom={(name, patch) => { updateServer(name, patch); }}
          onRemoveCustomEnv={(serverName, key) => { removeEnvVar(serverName, key); }}
          onAddCustomEnv={(name) => { addEnvVar(name); }}
          expanded={expanded}
          onToggleExpand={(name) => { setExpanded(p => ({ ...p, [name]: !p[name] })); }}
        />
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const sectionRenderers: Record<SettingsSection, () => React.ReactNode> = {
    general: renderGeneral,
    models: renderModels,
    channels: renderChannels,
    integrations: renderIntegrations,
    mcp: renderMCP,
  };

  const sectionBadges: Record<SettingsSection, string | null> = {
    general: null,
    models: configuredProviders > 0 ? String(configuredProviders) : null,
    channels: channelCount > 0 ? String(channelCount) : null,
    integrations: integCount > 0 ? String(integCount) : null,
    mcp: serverNames.length > 0 ? String(serverNames.length) : null,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div className="page-header" style={{ padding: "24px 28px 16px" }}>
        <h1 className="page-title">Settings</h1>
        <div className="page-subtitle">
          System configuration, integrations &amp; MCP servers
        </div>
      </div>

      {/* Sidebar + Content */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Sidebar */}
        <div style={{
          width: 190, flexShrink: 0, padding: "12px 12px 20px",
          borderRight: "1px solid var(--border)",
          display: "flex", flexDirection: "column", gap: 2,
          overflow: "auto",
        }}>
          {SECTION_NAV.map((item) => {
            const isActive = activeSection === item.key;
            const badge = sectionBadges[item.key];
            return (
              <button
                key={item.key}
                onClick={() => setActiveSection(item.key)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 12px", borderRadius: 7,
                  border: "none",
                  background: isActive ? "var(--bg-hover)" : "transparent",
                  color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                  fontSize: 13, fontWeight: isActive ? 500 : 400,
                  cursor: "pointer", fontFamily: "inherit",
                  textAlign: "left", width: "100%",
                  transition: "background 0.08s, color 0.08s",
                }}
              >
                <span style={{ color: isActive ? item.color : "var(--text-muted)", display: "flex", transition: "color 0.08s" }}>
                  {item.icon}
                </span>
                <span style={{ flex: 1 }}>{item.label}</span>
                {badge && (
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4,
                    background: isActive ? `color-mix(in srgb, ${item.color} 12%, transparent)` : "var(--bg-tertiary)",
                    color: isActive ? item.color : "var(--text-muted)",
                    fontVariantNumeric: "tabular-nums",
                    transition: "background 0.08s, color 0.08s",
                  }}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 28px" }}>
          {sectionRenderers[activeSection]()}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24,
          background: "var(--bg-card)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "10px 18px",
          fontSize: 13, color: "var(--text-primary)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 9999, animation: "fade-in 0.12s ease-out",
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Provider Card ───────────────────────────────────────────────────────────

function ProviderCard({ provider: p, isEditing, keyInput, keySaving, onToggleEdit, onKeyChange, onSave }: {
  provider: ProviderInfo;
  isEditing: boolean;
  keyInput: string;
  keySaving: boolean;
  onToggleEdit: () => void;
  onKeyChange: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8,
      padding: "12px 14px", borderRadius: 10,
      background: "var(--bg-card)",
      border: isEditing ? "1px solid var(--accent)" : "1px solid var(--border)",
      transition: "border-color 0.15s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <img
          src={p.iconUrl}
          alt={p.name}
          style={{
            width: 24, height: 24, flexShrink: 0, borderRadius: 5,
            filter: "var(--icon-filter, none)",
          }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            {p.name}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace" }}>
            {p.models.length} models
          </div>
        </div>
        <div style={{
          width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
          background: p.configured ? "var(--green)" : "var(--text-muted)",
          opacity: p.configured ? 1 : 0.3,
        }} />
      </div>
      <button
        onClick={onToggleEdit}
        style={{
          fontSize: 11, fontWeight: 500, padding: "5px 0", borderRadius: 6, width: "100%",
          border: "1px solid var(--border)", background: "var(--bg-tertiary)",
          color: isEditing ? "var(--accent)" : "var(--text-muted)",
          cursor: "pointer", fontFamily: "inherit",
          transition: "color 0.12s, border-color 0.12s",
        }}
      >
        {isEditing ? "Cancel" : p.configured ? "Edit Key" : "Set Key"}
      </button>
      {isEditing && (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            value={keyInput}
            onChange={(e) => onKeyChange(e.target.value)}
            placeholder={`Paste ${p.envKey || "API key"}...`}
            type="password"
            autoFocus
            style={{ ...inputStyle, flex: 1, fontSize: 12, fontFamily: "monospace" }}
            onKeyDown={(e) => e.key === "Enter" && keyInput.trim() && onSave()}
          />
          <button
            onClick={onSave}
            disabled={!keyInput.trim() || keySaving}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "7px 12px", borderRadius: 7, border: "none",
              background: keyInput.trim() ? "var(--accent)" : "var(--bg-tertiary)",
              color: keyInput.trim() ? "#fff" : "var(--text-muted)",
              fontSize: 11, fontWeight: 600,
              cursor: keyInput.trim() ? "pointer" : "default",
              fontFamily: "inherit", flexShrink: 0,
              opacity: keySaving ? 0.5 : 1, transition: "opacity 0.12s",
            }}
          >
            <Save size={11} /> Save
          </button>
        </div>
      )}
    </div>
  );
}

// ── MCP Directory Panel ─────────────────────────────────────────────────────

const DIRECTORY_IDS = new Set(MCP_DIRECTORY.map(e => e.id));

/** Categories that have at least one entry in the directory */
const USED_CATEGORIES = Array.from(new Set(MCP_DIRECTORY.map(e => e.category)));

function MCPDirectoryPanel({ activeServerNames, mcpConfig, mcpStatus, onAdd, onRemove, onAddCustom, onUpdateCustom, onRemoveCustomEnv, onAddCustomEnv, expanded, onToggleExpand }: {
  activeServerNames: string[];
  mcpConfig: MCPConfig;
  mcpStatus: MCPStatus;
  onAdd: (entry: MCPDirectoryEntry, envOverrides?: Record<string, string>) => void;
  onRemove: (name: string) => void;
  onAddCustom: (name: string, srv: { command: string; args: string[]; env: Record<string, string> }) => void;
  onUpdateCustom: (name: string, patch: Partial<MCPServer>) => void;
  onRemoveCustomEnv: (serverName: string, key: string) => void;
  onAddCustomEnv: (name: string) => void;
  expanded: Record<string, boolean>;
  onToggleExpand: (name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState<MCPCategory | "all">("all");
  const [showDirectory, setShowDirectory] = useState(false);
  const [setupEntry, setSetupEntry] = useState<MCPDirectoryEntry | null>(null);
  const [envInputs, setEnvInputs] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customCmd, setCustomCmd] = useState("npx");
  const [customArgs, setCustomArgs] = useState("");
  const [customEnvKey, setCustomEnvKey] = useState("");
  const [customEnvVal, setCustomEnvVal] = useState("");
  const [customEnv, setCustomEnv] = useState<Record<string, string>>({});

  const customServerNames = activeServerNames.filter(n => !DIRECTORY_IDS.has(n));

  // Active directory servers (ones that are added)
  const activeDirectoryEntries = MCP_DIRECTORY.filter(e => activeServerNames.includes(e.id));

  const q = search.toLowerCase();
  const filtered = MCP_DIRECTORY.filter(e => {
    if (activeServerNames.includes(e.id)) return false; // hide already-added from browse
    if (catFilter !== "all" && e.category !== catFilter) return false;
    if (q && !e.name.toLowerCase().includes(q) && !e.description.toLowerCase().includes(q)
      && !e.tools.some(t => t.toLowerCase().includes(q))) return false;
    return true;
  });

  // Category dropdown options
  const categoryOptions: DropdownOption[] = [
    { value: "all", label: "All Categories" },
    ...USED_CATEGORIES.map(c => ({
      value: c,
      label: CATEGORY_META[c].label,
    })),
  ];

  function handleAddClick(entry: MCPDirectoryEntry) {
    const hasEnv = Object.keys(entry.envVars).length > 0;
    if (hasEnv) {
      setSetupEntry(entry);
      const initial: Record<string, string> = {};
      for (const k of Object.keys(entry.envVars)) initial[k] = "";
      setEnvInputs(initial);
    } else {
      onAdd(entry);
    }
  }

  function confirmSetup() {
    if (!setupEntry) return;
    onAdd(setupEntry, envInputs);
    setSetupEntry(null);
    setEnvInputs({});
  }

  function handleAddCustom() {
    const name = customName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name) return;
    if (activeServerNames.includes(name)) return;
    onAddCustom(name, {
      command: customCmd.trim(),
      args: customArgs.split("\n").map(s => s.trim()).filter(Boolean),
      env: { ...customEnv },
    });
    setShowCustom(false);
    setCustomName("");
    setCustomCmd("npx");
    setCustomArgs("");
    setCustomEnv({});
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Active Servers ── */}
      {(activeDirectoryEntries.length > 0 || customServerNames.length > 0) && (
        <div>
          <SectionLabel title="Active Servers" count={activeServerNames.length} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Directory-based active servers — compact row style */}
            {activeDirectoryEntries.map(entry => {
              const live = mcpStatus.servers.find(s => s.name === entry.id);
              const catMeta = CATEGORY_META[entry.category];
              return (
                <div key={entry.id} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 14px", borderRadius: 8,
                  background: "var(--bg-card)", border: "1px solid var(--border)",
                }}>
                  <div style={{
                    width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                    background: live?.connected ? "var(--green)" : "var(--text-muted)",
                    opacity: live?.connected ? 1 : 0.35,
                  }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", flex: 1 }}>
                    {entry.name}
                  </span>
                  <span style={{
                    fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
                    background: `color-mix(in srgb, ${catMeta.color} 10%, transparent)`,
                    color: catMeta.color,
                  }}>{catMeta.label}</span>
                  {live?.connected && (
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                      {live.tools.length} tool{live.tools.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  <button
                    onClick={() => onRemove(entry.id)}
                    style={{
                      display: "flex", padding: 4, border: "none", borderRadius: 4,
                      background: "transparent", color: "var(--text-muted)", cursor: "pointer",
                      transition: "color 0.08s",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = "var(--red)"; }}
                    onMouseLeave={e => { e.currentTarget.style.color = "var(--text-muted)"; }}
                    title="Remove"
                  ><Trash2 size={12} /></button>
                </div>
              );
            })}

            {/* Custom servers — collapsible */}
            {customServerNames.map(name => {
              const srv = mcpConfig.mcpServers[name];
              if (!srv) return null;
              const live = mcpStatus.servers.find(s => s.name === name);
              const isOpen = expanded[name] ?? false;
              return (
                <div key={name} style={{
                  borderRadius: 8, overflow: "hidden",
                  background: "var(--bg-card)", border: "1px solid var(--border)",
                }}>
                  <div
                    onClick={() => onToggleExpand(name)}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "10px 14px", cursor: "pointer",
                      borderBottom: isOpen ? "1px solid var(--border)" : "none",
                    }}
                  >
                    {isOpen ? <ChevronDown size={12} style={{ color: "var(--text-muted)" }} />
                      : <ChevronRight size={12} style={{ color: "var(--text-muted)" }} />}
                    <div style={{
                      width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                      background: live?.connected ? "var(--green)" : "var(--text-muted)",
                      opacity: live?.connected ? 1 : 0.35,
                    }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", flex: 1 }}>{name}</span>
                    <span style={{
                      fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
                      background: "var(--bg-tertiary)", color: "var(--text-muted)",
                    }}>CUSTOM</span>
                    {live?.connected && (
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {live.tools.length} tool{live.tools.length !== 1 ? "s" : ""}
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); onRemove(name); }}
                      title="Remove"
                      style={{
                        display: "flex", padding: 4, border: "none", borderRadius: 4,
                        background: "transparent", color: "var(--text-muted)", cursor: "pointer",
                        transition: "color 0.08s",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = "var(--red)"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = "var(--text-muted)"; }}
                    ><Trash2 size={12} /></button>
                  </div>
                  {isOpen && (
                    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                      <Field label="Command" hint="e.g. npx, node, python">
                        <input value={srv.command} onChange={e => onUpdateCustom(name, { command: e.target.value })} placeholder="npx" style={inputStyle} />
                      </Field>
                      <Field label="Arguments" hint="One per line">
                        <textarea
                          value={(srv.args ?? []).join("\n")}
                          onChange={e => onUpdateCustom(name, { args: e.target.value.split("\n") })}
                          placeholder={"-y\n@your/mcp-package\n--flag"}
                          rows={3}
                          style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}
                        />
                      </Field>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                          <label style={labelStyle}>Environment Variables</label>
                          <button onClick={() => onAddCustomEnv(name)} style={btnSecondary}><Plus size={12} /> Add</button>
                        </div>
                        {Object.keys(srv.env ?? {}).length === 0 ? (
                          <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>No environment variables</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {Object.entries(srv.env ?? {}).map(([k, v]) => (
                              <div key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-secondary)", minWidth: 100, flexShrink: 0 }}>{k}</span>
                                <input value={v} onChange={e => onUpdateCustom(name, { env: { ...srv.env, [k]: e.target.value } })} placeholder="value" style={{ ...inputStyle, flex: 1 }} />
                                <button onClick={() => onRemoveCustomEnv(name, k)} style={{
                                  display: "flex", padding: 4, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", borderRadius: 4,
                                  transition: "color 0.08s",
                                }} onMouseEnter={e => { e.currentTarget.style.color = "var(--red)"; }} onMouseLeave={e => { e.currentTarget.style.color = "var(--text-muted)"; }}>
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
                              }}>{t}</span>
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
        </div>
      )}

      {/* ── Browse Directory (collapsible) ── */}
      <div>
        <button
          onClick={() => setShowDirectory(d => !d)}
          style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%",
            padding: "10px 14px", borderRadius: 8,
            border: "1px solid var(--border)",
            background: showDirectory ? "var(--bg-card)" : "transparent",
            color: "var(--text-primary)", cursor: "pointer",
            fontSize: 13, fontWeight: 500, fontFamily: "inherit",
            transition: "background 0.1s, border-color 0.1s",
          }}
        >
          {showDirectory ? <ChevronDown size={14} style={{ color: "var(--text-muted)" }} /> : <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />}
          <Package size={14} style={{ color: "var(--green)" }} />
          <span style={{ flex: 1, textAlign: "left" }}>Browse Server Directory</span>
          <span style={{
            fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
            background: "var(--bg-tertiary)", color: "var(--text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}>{MCP_DIRECTORY.length} available</span>
        </button>

        {showDirectory && (
          <div style={{ marginTop: 10, animation: "fade-in 0.12s ease-out" }}>
            {/* Search + Category — single compact row */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
              <div style={{ position: "relative", flex: 1, minWidth: 160 }}>
                <Search size={13} style={{
                  position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
                  color: "var(--text-muted)", pointerEvents: "none",
                }} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search servers..."
                  style={{ ...inputStyle, paddingLeft: 30 }}
                />
              </div>
              <div style={{ width: 160, flexShrink: 0 }}>
                <Dropdown
                  value={catFilter}
                  onChange={v => setCatFilter(v as MCPCategory | "all")}
                  options={categoryOptions}
                  placeholder="Category"
                  alignRight
                />
              </div>
            </div>

            {/* Setup panel (env var input for a server being added) */}
            {setupEntry && (
              <div style={{
                background: "var(--bg-card)", border: "1px solid var(--accent)",
                borderRadius: 8, padding: 14, marginBottom: 12,
                animation: "fade-in 0.12s ease-out",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <Package size={14} style={{ color: "var(--accent)" }} />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                      {setupEntry.name}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>
                      Set environment variables
                    </span>
                  </div>
                  <button onClick={() => { setSetupEntry(null); setEnvInputs({}); }} style={{
                    display: "flex", padding: 4, border: "none", borderRadius: 4,
                    background: "transparent", color: "var(--text-muted)", cursor: "pointer",
                  }}>
                    <X size={14} />
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {Object.entries(setupEntry.envVars).map(([varName, hint]) => (
                    <div key={varName} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{
                        fontSize: 11, fontFamily: "monospace", color: "var(--text-secondary)",
                        minWidth: 130, flexShrink: 0,
                      }}>{varName}</span>
                      <input
                        value={envInputs[varName] ?? ""}
                        onChange={e => setEnvInputs(p => ({ ...p, [varName]: e.target.value }))}
                        placeholder={hint}
                        type="password"
                        style={{ ...inputStyle, flex: 1, fontFamily: "monospace", fontSize: 12 }}
                        onKeyDown={e => e.key === "Enter" && confirmSetup()}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                  <button onClick={() => { setSetupEntry(null); setEnvInputs({}); }} style={btnSecondary}>Cancel</button>
                  <button onClick={confirmSetup} style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "6px 14px", borderRadius: 7, border: "none",
                    background: "var(--accent)", color: "#fff",
                    cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit",
                  }}>
                    <Plus size={12} /> Add
                  </button>
                </div>
              </div>
            )}

            {/* Directory grid */}
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 8,
            }}>
              {filtered.map(entry => {
                const catMeta = CATEGORY_META[entry.category];
                return (
                  <div key={entry.id} style={{
                    display: "flex", flexDirection: "column", gap: 6,
                    padding: "12px 14px", borderRadius: 8,
                    background: "var(--bg-card)", border: "1px solid var(--border)",
                    transition: "border-color 0.12s",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {entry.name}
                      </span>
                      <span style={{
                        fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
                        background: `color-mix(in srgb, ${catMeta.color} 10%, transparent)`,
                        color: catMeta.color, flexShrink: 0,
                      }}>{catMeta.label}</span>
                    </div>

                    <div style={{
                      fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4,
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}>{entry.description}</div>

                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "auto" }}>
                      <span style={{
                        fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace",
                        flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>{entry.tools.slice(0, 3).join(", ")}{entry.tools.length > 3 ? ` +${entry.tools.length - 3}` : ""}</span>
                      {Object.keys(entry.envVars).length > 0 && (
                        <span style={{
                          fontSize: 9, padding: "2px 5px", borderRadius: 3,
                          background: "var(--yellow-bg)", color: "var(--yellow)", flexShrink: 0,
                        }}>KEY</span>
                      )}
                      {entry.docsUrl && (
                        <a href={entry.docsUrl} target="_blank" rel="noopener noreferrer"
                          style={{ display: "flex", padding: 3, borderRadius: 4, color: "var(--text-muted)", flexShrink: 0 }}
                          title="Docs"
                        ><ExternalLink size={11} /></a>
                      )}
                      <button
                        onClick={() => handleAddClick(entry)}
                        style={{
                          display: "flex", alignItems: "center", gap: 4,
                          padding: "4px 10px", borderRadius: 5, border: "none",
                          background: "var(--accent)", color: "#fff",
                          cursor: "pointer", fontSize: 10, fontWeight: 600,
                          fontFamily: "inherit", flexShrink: 0,
                        }}
                      ><Plus size={10} /> Add</button>
                    </div>
                  </div>
                );
              })}
            </div>

            {filtered.length === 0 && (
              <div style={{ textAlign: "center", padding: "20px 0", color: "var(--text-muted)", fontSize: 12 }}>
                No servers match your search.
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Add Custom Server ── */}
      {!showCustom ? (
        <button
          onClick={() => setShowCustom(true)}
          style={{
            display: "flex", alignItems: "center", gap: 6, width: "100%",
            padding: "10px 14px", borderRadius: 8,
            border: "1px dashed var(--border)", background: "transparent",
            color: "var(--text-muted)", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
            transition: "border-color 0.12s, color 0.12s",
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--text-primary)"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-muted)"; }}
        ><Plus size={14} /> Add Custom Server</button>
      ) : (
        <div style={{
          background: "var(--bg-card)", border: "1px solid var(--accent)",
          borderRadius: 8, padding: 14,
          animation: "fade-in 0.12s ease-out",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Server size={14} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", flex: 1 }}>Custom Server</span>
            <button onClick={() => setShowCustom(false)} style={{
              display: "flex", padding: 4, border: "none", borderRadius: 4,
              background: "transparent", color: "var(--text-muted)", cursor: "pointer",
            }}><X size={14} /></button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <Field label="Name" hint="e.g. my-server">
                  <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="my-custom-server" style={inputStyle} />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Command" hint="e.g. npx, node">
                  <input value={customCmd} onChange={e => setCustomCmd(e.target.value)} placeholder="npx" style={inputStyle} />
                </Field>
              </div>
            </div>
            <Field label="Arguments" hint="One per line">
              <textarea value={customArgs} onChange={e => setCustomArgs(e.target.value)} placeholder={"-y\n@your/mcp-package"}
                rows={2} style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }} />
            </Field>
            <div>
              <label style={labelStyle}>Environment Variables</label>
              {Object.keys(customEnv).length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                  {Object.entries(customEnv).map(([k, v]) => (
                    <div key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-secondary)", minWidth: 100, flexShrink: 0 }}>{k}</span>
                      <input value={v} onChange={e => setCustomEnv(p => ({ ...p, [k]: e.target.value }))} placeholder="value" style={{ ...inputStyle, flex: 1 }} />
                      <button onClick={() => setCustomEnv(p => { const n = { ...p }; delete n[k]; return n; })}
                        style={{ display: "flex", padding: 4, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", borderRadius: 4 }}
                      ><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input value={customEnvKey} onChange={e => setCustomEnvKey(e.target.value)} placeholder="VAR_NAME" style={{ ...inputStyle, flex: 1, fontFamily: "monospace", fontSize: 12 }} />
                <input value={customEnvVal} onChange={e => setCustomEnvVal(e.target.value)} placeholder="value" style={{ ...inputStyle, flex: 1, fontSize: 12 }} />
                <button onClick={() => {
                  if (customEnvKey.trim()) { setCustomEnv(p => ({ ...p, [customEnvKey.trim()]: customEnvVal })); setCustomEnvKey(""); setCustomEnvVal(""); }
                }} style={btnSecondary}><Plus size={12} /></button>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
            <button onClick={() => setShowCustom(false)} style={btnSecondary}>Cancel</button>
            <button onClick={handleAddCustom} disabled={!customName.trim() || !customCmd.trim()} style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "6px 14px", borderRadius: 7, border: "none",
              background: customName.trim() && customCmd.trim() ? "var(--accent)" : "var(--bg-tertiary)",
              color: customName.trim() && customCmd.trim() ? "#fff" : "var(--text-muted)",
              cursor: customName.trim() && customCmd.trim() ? "pointer" : "default",
              fontSize: 11, fontWeight: 600, fontFamily: "inherit",
            }}><Plus size={12} /> Add Server</button>
          </div>
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
  transition: "background 0.08s, color 0.08s",
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
