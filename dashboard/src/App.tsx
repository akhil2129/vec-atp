import { useState } from "react";
import { ThemeProvider } from "./context/ThemeContext";
import { EmployeesProvider } from "./context/EmployeesContext";
import Sidebar, { type View } from "./components/Sidebar";
import KanbanView from "./views/KanbanView";
import OverviewView from "./views/OverviewView";
import EventsView from "./views/EventsView";
import SnoopView from "./views/QueueView";
import DirectoryView from "./views/DirectoryView";
import ChatView from "./views/ChatView";

import LiveView from "./views/LiveView";
import SettingsView from "./views/SettingsView";

export default function App() {
  const [activeView, setActiveViewRaw] = useState<View>(() => {
    const saved = localStorage.getItem("active-view");
    return saved && ["overview","kanban","events","snoop","directory","chat","live","settings"].includes(saved)
      ? (saved as View)
      : "kanban";
  });

  function setActiveView(v: View) {
    localStorage.setItem("active-view", v);
    setActiveViewRaw(v);
  }

  return (
    <ThemeProvider>
    <EmployeesProvider>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--bg-primary)" }}>
        <Sidebar activeView={activeView} setActiveView={setActiveView} />
        <main style={{
          flex: 1, overflow: "hidden", display: "flex", flexDirection: "column",
          background: "var(--bg-card)",
          borderRadius: 14,
          margin: 8,
          boxShadow: "var(--shadow-lg)",
          border: "1px solid var(--border)",
        }}>
          {activeView === "overview" && <OverviewView />}
          {activeView === "kanban" && <KanbanView />}
          {activeView === "events" && <EventsView />}
          {activeView === "snoop" && <SnoopView />}
          {activeView === "directory" && <DirectoryView />}
          {activeView === "chat" && <ChatView />}
          {activeView === "live" && <LiveView />}
          {activeView === "settings" && <SettingsView />}
        </main>
      </div>
    </EmployeesProvider>
    </ThemeProvider>
  );
}
