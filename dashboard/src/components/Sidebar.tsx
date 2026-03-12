import { useState } from "react";
import {
  LayoutDashboard,
  Columns3,
  CalendarDays,
  Eye,
  Users,
  MessageSquare,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Monitor,
  Settings,
} from "lucide-react";
import ThemeSwitcher from "./ThemeSwitcher";

export type View =
  | "overview"
  | "kanban"
  | "events"
  | "snoop"
  | "directory"
  | "chat"
  | "live"
  | "settings";

interface NavItem { id: View; label: string; icon: React.ReactNode }

const ICON = 18;
const NAV_ITEMS: NavItem[] = [
  { id: "overview",  label: "Overview",  icon: <LayoutDashboard size={ICON} /> },
  { id: "kanban",    label: "Kanban",    icon: <Columns3 size={ICON} /> },
  { id: "live",      label: "Live",      icon: <Monitor size={ICON} /> },
  { id: "events",    label: "Events",    icon: <CalendarDays size={ICON} /> },
  { id: "snoop",     label: "Snoop",     icon: <Eye size={ICON} /> },
  { id: "directory", label: "Directory", icon: <Users size={ICON} /> },
  { id: "chat",      label: "Chat",      icon: <MessageSquare size={ICON} /> },
  { id: "settings",  label: "Settings",  icon: <Settings size={ICON} /> },
];

// Expanded: 240px. Collapsed: 56px.
// Nav container padding: 10px (expanded) / 8px (collapsed).
// So collapsed inner = 56 - 16 = 40px.  Icon = 18px.  Pad to center = (40-18)/2 = 11px.
const EXP_W = 240;
const COL_W = 56;
const DUR = "0.28s";
const EASE = "cubic-bezier(0.4,0,0.2,1)";
const TR = `${DUR} ${EASE}`;

interface Props {
  activeView: View;
  setActiveView: (v: View) => void;
}

export default function Sidebar({ activeView, setActiveView }: Props) {
  const [showTheme, setShowTheme] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    localStorage.getItem("sidebar-collapsed") === "true"
  );

  function toggle() {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }

  const W = collapsed ? COL_W : EXP_W;

  // When collapsed: center icon by giving 11px left padding ((40-18)/2)
  // When expanded: 12px left padding (normal nav look)
  const itemPadLeft = collapsed ? 11 : 12;

  return (
    <>
      <nav style={{
        width: W, minWidth: W,
        background: "var(--bg-primary)",
        display: "flex", flexDirection: "column",
        flexShrink: 0, userSelect: "none", overflow: "hidden",
        transition: `width ${TR}, min-width ${TR}`,
      }}>
        {/* ── Brand row ── */}
        <div style={{
          height: 52, display: "flex", alignItems: "center",
          padding: "0 10px", flexShrink: 0,
          overflow: "hidden",
        }}>
          {/* P logo */}
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: "var(--accent)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 700, color: "#fff", flexShrink: 0,
            opacity: collapsed ? 0 : 1,
            marginRight: collapsed ? -28 : 10,
            transition: `opacity ${TR}, margin-right ${TR}`,
          }}>
            P
          </div>

          {/* Brand text */}
          <span style={{
            fontSize: 15, fontWeight: 600, color: "var(--text-primary)",
            letterSpacing: "-0.01em", flex: 1, minWidth: 0,
            opacity: collapsed ? 0 : 1,
            overflow: "hidden", whiteSpace: "nowrap",
            transition: `opacity ${TR}`,
          }}>
            Pi-Agent
          </span>

          {/* Toggle — both icons overlaid, crossfade */}
          <button
            onClick={toggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            style={{
              position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 32, height: 32, border: "none", borderRadius: 7,
              background: "transparent", color: "var(--text-muted)",
              cursor: "pointer", flexShrink: 0, padding: 0,
              transition: `background 0.1s, color 0.1s`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <span style={{
              position: "absolute", display: "flex",
              opacity: collapsed ? 0 : 1,
              transition: `opacity ${TR}`,
            }}>
              <PanelLeftClose size={ICON} />
            </span>
            <span style={{
              position: "absolute", display: "flex",
              opacity: collapsed ? 1 : 0,
              transition: `opacity ${TR}`,
            }}>
              <PanelLeftOpen size={ICON} />
            </span>
          </button>
        </div>

        {/* ── Nav items ── */}
        <div style={{
          flex: 1, overflowY: "auto", overflowX: "hidden",
          padding: collapsed ? "4px 8px" : "4px 10px",
          display: "flex", flexDirection: "column", gap: 2,
          transition: `padding ${TR}`,
        }}>
          {NAV_ITEMS.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                title={collapsed ? item.label : undefined}
                onClick={() => setActiveView(item.id)}
                style={{
                  width: "100%", height: 38,
                  display: "flex", alignItems: "center",
                  gap: 10, border: "none", borderRadius: 7,
                  paddingLeft: itemPadLeft, paddingRight: 12,
                  paddingTop: 0, paddingBottom: 0,
                  background: isActive ? "var(--bg-hover)" : "transparent",
                  color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                  cursor: "pointer", fontFamily: "inherit",
                  fontSize: 14, fontWeight: isActive ? 500 : 400,
                  textAlign: "left", whiteSpace: "nowrap", overflow: "hidden",
                  transition: `background 0.08s, color 0.08s, padding-left ${TR}`,
                }}
                onMouseEnter={(e) => { if (!isActive) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-secondary)"; }}}
                onMouseLeave={(e) => { if (!isActive) { e.currentTarget.style.background = isActive ? "var(--bg-hover)" : "transparent"; e.currentTarget.style.color = isActive ? "var(--text-primary)" : "var(--text-muted)"; }}}
              >
                <span style={{ display: "flex", flexShrink: 0 }}>{item.icon}</span>
                <span style={{
                  opacity: collapsed ? 0 : 1,
                  transition: `opacity ${TR}`,
                  overflow: "hidden",
                }}>
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Footer: Theme ── */}
        <div style={{
          padding: collapsed ? "4px 8px 10px" : "4px 10px 10px",
          transition: `padding ${TR}`,
        }}>
          <button
            title={collapsed ? "Theme" : undefined}
            onClick={() => setShowTheme((v) => !v)}
            style={{
              width: "100%", height: 38,
              display: "flex", alignItems: "center",
              gap: 10, border: "none", borderRadius: 7,
              paddingLeft: itemPadLeft, paddingRight: 12,
              paddingTop: 0, paddingBottom: 0,
              background: showTheme ? "var(--bg-hover)" : "transparent",
              color: showTheme ? "var(--text-primary)" : "var(--text-muted)",
              cursor: "pointer", fontFamily: "inherit",
              fontSize: 14, fontWeight: 400,
              textAlign: "left", whiteSpace: "nowrap", overflow: "hidden",
              transition: `background 0.08s, padding-left ${TR}`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { if (!showTheme) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ display: "flex", flexShrink: 0 }}><Palette size={ICON} /></span>
            <span style={{
              opacity: collapsed ? 0 : 1,
              transition: `opacity ${TR}`,
              overflow: "hidden",
            }}>
              Theme
            </span>
          </button>
        </div>
      </nav>

      {showTheme && <ThemeSwitcher onClose={() => setShowTheme(false)} />}
      {showTheme && (
        <div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setShowTheme(false)} />
      )}
    </>
  );
}
