/**
 * VEC-ATP Live Dashboard — Express HTTP server.
 * Serves a self-contained browser dashboard that auto-refreshes every 3 s.
 *
 * Endpoints:
 *   GET /                  â†’ inline HTML dashboard
 *   GET /api/tasks         â†’ all ATP tasks (JSON)
 *   GET /api/employees     â†’ all employees (JSON)
 *   GET /api/events        â†’ last 30 events (JSON)
 *   GET /api/queue         â†’ PM message queue (rJSON)
 *   GET /api/agent-messages â†’ inter-agent message queue (JSON)
 *   GET /api/errors        â†’ recent errors with type classification (JSON)
 *   GET /api/chat-log      â†’ userâ†"agent chat history (JSON)
 *   POST /api/send-message â†’ send a message to any agent (JSON: {to, message})
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// React build output — dashboard/dist/ relative to repo root
const REACT_DIST = join(__dirname, "../../dashboard/dist");
import { ATPDatabase } from "../atp/database.js";
import { EventLog } from "../atp/eventLog.js";
import { MessageQueue } from "../atp/messageQueue.js";
import { AgentMessageQueue, AGENT_DISPLAY_NAMES } from "../atp/agentMessageQueue.js";
import { AgentInterrupt } from "../atp/agentInterrupt.js";
import { UserChatLog } from "../atp/chatLog.js";
import { agentStreamBus, getReplayBuffer } from "../atp/agentStreamBus.js";
import type { StreamToken } from "../atp/agentStreamBus.js";
import { AGENT_PROFILES, getEnabledTools, setAgentTools } from "../atp/agentToolConfig.js";
import { getRosterEntry, getRoleTemplates } from "../ar/roster.js";
import { AgentRuntime } from "../atp/agentRuntime.js";
import { getMCPTools } from "../mcp/mcpBridge.js";
import { ActiveChannelState } from "../channels/activeChannel.js";
import type { VECAgent } from "../atp/inboxLoop.js";
import { getAllUsage as getFinanceAllUsage, getTotals as getFinanceTotals, resetUsage as resetFinanceUsage } from "../atp/tokenTracker.js";
import { getProviders, getModelConfig, setModelConfig, setAgentModel, getEffectiveModel } from "../atp/modelConfig.js";
import {
  apiKeyAuth,
  getDashboardApiKey,
  getDashboardHost,
  getCorsOptions,
  getHelmetOptions,
  getMutationRateLimitOptions,
  validateMCPConfig,
} from "./security.js";

// â"€â"€ Error classification (server-side) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

type ErrorKind = "rate_limit" | "timeout" | "network" | "quota" | "crashed" | "generic";

interface ErrorEntry {
  timestamp: string;
  agent_id: string;
  task_id: string;
  message: string;
  kind: ErrorKind;
  label: string;
}

function classifyError(message: string): { kind: ErrorKind; label: string } {
  const m = message.toLowerCase();
  if (m.includes("rate limit") || m.includes("rate_limit") || m.includes("429") || m.includes("cooling down"))
    return { kind: "rate_limit", label: "RATE LIMIT" };
  if (m.includes("quota") || m.includes("insufficient_quota") || m.includes("billing"))
    return { kind: "quota", label: "QUOTA" };
  if (m.includes("timeout") || m.includes("timed out") || m.includes("etimedout") || m.includes("deadline"))
    return { kind: "timeout", label: "TIMEOUT" };
  if (m.includes("econnrefused") || m.includes("enotfound") || m.includes("network") || m.includes("fetch failed") || m.includes("socket"))
    return { kind: "network", label: "NETWORK" };
  if (m.includes("crashed") || m.includes("agent error") || m.includes("fatal"))
    return { kind: "crashed", label: "CRASHED" };
  return { kind: "generic", label: "ERROR" };
}

function getErrors(): ErrorEntry[] {
  const events = EventLog.getEvents(100);
  const errorEvents = events.filter((e) => e.event_type === "task_failed");
  const failedTasks = ATPDatabase.getAllTasks("failed");

  const entries: ErrorEntry[] = [];
  const seenTaskIds = new Set<string>();

  for (const e of errorEvents) {
    const { kind, label } = classifyError(e.message);
    entries.push({ timestamp: e.timestamp, agent_id: e.agent_id, task_id: e.task_id, message: e.message, kind, label });
    if (e.task_id) seenTaskIds.add(e.task_id);
  }

  for (const t of failedTasks) {
    if (!seenTaskIds.has(t.task_id)) {
      const { kind, label } = classifyError(t.result || "Task failed");
      entries.push({ timestamp: t.updated_at, agent_id: t.agent_id, task_id: t.task_id, message: t.result || "Task failed without details.", kind, label });
    }
  }

  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 20);
}

// â"€â"€ Inline HTML â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VEC-ATP</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      background: #0d1117;
      color: #c9d1d9;
      height: 100vh;
      overflow: hidden;
      display: flex;
    }

    /* â"€â"€ Left sidebar nav â"€â"€ */
    .sidebar {
      width: 60px;
      background: #161b22;
      border-right: 1px solid #30363d;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 12px 0;
      gap: 4px;
      flex-shrink: 0;
    }
    .sidebar-brand {
      width: 36px;
      height: 36px;
      background: #1158c7;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 1rem;
      color: #fff;
      margin-bottom: 12px;
      letter-spacing: -0.02em;
      flex-shrink: 0;
    }
    .nav-btn {
      width: 44px;
      height: 44px;
      border: none;
      background: none;
      border-radius: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #484f58;
      transition: background 0.15s, color 0.15s;
      position: relative;
    }
    .nav-btn:hover { background: #1c2128; color: #c9d1d9; }
    .nav-btn.active { background: #1c2128; color: #79c0ff; }
    .nav-btn.active::before {
      content: '';
      position: absolute;
      left: 0; top: 8px; bottom: 8px;
      width: 3px;
      background: #1158c7;
      border-radius: 0 3px 3px 0;
    }
    /* Badge on nav icon (unread count) */
    .nav-badge {
      position: absolute;
      top: 5px;
      right: 5px;
      background: #f85149;
      color: #fff;
      border-radius: 8px;
      font-size: 0.56rem;
      font-weight: 700;
      padding: 1px 4px;
      min-width: 14px;
      text-align: center;
      line-height: 1.4;
      pointer-events: none;
      border: 1px solid #161b22;
    }

    /* â"€â"€ Main area â"€â"€ */
    .main {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* â"€â"€ Views â"€â"€ */
    .view { display: none; flex: 1; overflow: hidden; flex-direction: column; }
    .view.active { display: flex; }

    /* â"€â"€ Dashboard view â"€â"€ */
    #view-dashboard { overflow-y: auto; padding: 16px; gap: 16px; position: relative; }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0;
      padding-bottom: 12px;
      border-bottom: 1px solid #30363d;
    }
    header h1 { font-size: 1.1rem; color: #f0f6fc; letter-spacing: 0.04em; }
    #refresh-indicator { font-size: 0.75rem; color: #8b949e; }
    #refresh-indicator span { color: #3fb950; font-weight: 600; }

    /* ── Alerts bell button ── */
    #alerts-btn {
      position: relative;
      background: none;
      border: none;
      color: #484f58;
      cursor: pointer;
      padding: 5px 7px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background 0.15s;
    }
    #alerts-btn:hover { color: #c9d1d9; background: #21262d; }
    #alerts-btn.has-errors { color: #f85149; }
    #alerts-btn.badge-new { animation: badgePulse 1.4s ease infinite; }
    #alerts-btn-count {
      position: absolute;
      top: -3px;
      right: -5px;
      background: #da3633;
      color: #fff;
      border-radius: 999px;
      padding: 0 5px;
      font-size: 0.58rem;
      font-weight: 800;
      min-width: 15px;
      height: 15px;
      line-height: 15px;
      text-align: center;
      display: none;
      border: 2px solid #0d1117;
    }
    #alerts-btn.has-errors #alerts-btn-count { display: block; }
    #alerts-btn.badge-new #alerts-btn-count { background: #ff6b6b; }
    @keyframes badgePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }

    /* ── Alerts dropdown panel ── */
    #alerts-panel {
      position: absolute;
      top: 64px;
      right: 16px;
      width: min(520px, calc(100vw - 32px));
      height: min(560px, calc(100vh - 100px));
      background: linear-gradient(180deg, #0f1013 0%, #0b0c0e 100%);
      border: 1px solid #23252c;
      border-radius: 16px;
      box-shadow: 0 28px 64px rgba(0,0,0,0.62), 0 0 0 1px rgba(255,255,255,0.03) inset;
      z-index: 300;
      display: none;
      flex-direction: column;
      overflow: hidden;
      transform-origin: top right;
      backdrop-filter: blur(10px);
    }
    #alerts-panel.open {
      display: flex;
      animation: alertPanelIn 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes alertPanelIn {
      from { opacity: 0; transform: scale(0.92) translateY(-8px); }
      to   { opacity: 1; transform: scale(1)    translateY(0); }
    }
    .alerts-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 16px 14px;
      border-bottom: 1px solid #1a1c22;
      flex-shrink: 0;
      background: rgba(16, 17, 21, 0.92);
    }
    .alerts-panel-title {
      font-size: 1.9rem;
      font-weight: 650;
      color: #d8dae2;
      letter-spacing: -0.02em;
    }
    .alerts-panel-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .alerts-panel-icon-btn {
      background: none;
      border: 1px solid transparent;
      color: #8c9099;
      cursor: pointer;
      width: 28px;
      height: 28px;
      border-radius: 7px;
      font-size: 0.88rem;
      font-weight: 500;
      transition: color 0.12s, background 0.12s, border-color 0.12s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .alerts-panel-icon-btn:hover { color: #d8dae2; background: #1f2128; border-color: #2f333c; }

    @media (max-width: 700px) {
      #alerts-panel {
        right: 8px;
        width: calc(100vw - 16px);
        height: min(68vh, 560px);
      }
      .alerts-panel-title { font-size: 1.35rem; }
    }
    #alerts-panel-body { overflow-y: auto; flex: 1; padding: 10px; }
    #alerts-panel-body::-webkit-scrollbar { width: 4px; }
    #alerts-panel-body::-webkit-scrollbar-track { background: transparent; }
    #alerts-panel-body::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
    .alerts-empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 16px;
      color: #6f7480;
      font-size: 0.92rem;
      letter-spacing: 0.02em;
    }

    /* ── Individual alert row ── */
    .alert-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 12px;
      transition: background 0.12s;
      cursor: default;
      margin-bottom: 2px;
    }
    .alert-row:last-child { margin-bottom: 0; }
    .alert-row:hover { background: #17191f; }

    /* Colored left accent bar */
    .alert-accent {
      width: 42px;
      height: 42px;
      border-radius: 999px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      color: #f5f7fb;
      font-weight: 700;
      font-size: 0.95rem;
      background: #23252d;
    }
    .alert-accent::after {
      content: "🗓";
      position: absolute;
      right: -2px;
      bottom: -2px;
      font-size: 0.7rem;
      background: #0f1013;
      border-radius: 999px;
      padding: 1px;
    }
    .alert-accent.kind-crashed    { background: #332124; }
    .alert-accent.kind-rate_limit { background: #33261e; }
    .alert-accent.kind-timeout    { background: #2c2535; }
    .alert-accent.kind-network    { background: #1f2b36; }
    .alert-accent.kind-quota      { background: #372826; }
    .alert-accent.kind-generic    { background: #24262e; }

    .alert-row-inner {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .alert-row-content { flex: 1; min-width: 0; }
    .alert-row-title {
      font-size: 1.05rem;
      font-weight: 600;
      color: #d9dce4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.4;
    }
    .alert-row-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
    }
    .alert-kind-pill {
      font-size: 0.72rem;
      font-weight: 500;
      letter-spacing: 0.01em;
      flex-shrink: 0;
      color: #8e929c;
    }
    .alert-kind-pill.kind-crashed,
    .alert-kind-pill.kind-rate_limit,
    .alert-kind-pill.kind-timeout,
    .alert-kind-pill.kind-network,
    .alert-kind-pill.kind-quota,
    .alert-kind-pill.kind-generic { background: transparent; }
    .alert-row-agent {
      font-size: 0.72rem;
      color: #8e929c;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .alert-row-time {
      font-size: 0.86rem;
      color: #989ca6;
      flex-shrink: 0;
      white-space: nowrap;
    }

    /* Grid panels */
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #1c2128; border-bottom: 1px solid #30363d; }
    .panel-header h2 { font-size: 0.85rem; color: #f0f6fc; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    .panel-count { font-size: 0.75rem; color: #8b949e; }
    .panel-body { overflow-x: auto; max-height: 320px; overflow-y: auto; }

    table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    th { text-align: left; padding: 7px 12px; background: #1c2128; color: #8b949e; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; position: sticky; top: 0; z-index: 1; }
    td { padding: 7px 12px; border-bottom: 1px solid #21262d; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #1c2128; }
    tr.error-row td { background: #160b0b; }
    tr.error-row:hover td { background: #1a0d0d; }
    .empty { padding: 20px 14px; color: #484f58; font-size: 0.8rem; font-style: italic; }

    .badge { display: inline-block; padding: 2px 7px; border-radius: 12px; font-size: 0.68rem; font-weight: 600; letter-spacing: 0.02em; }
    .s-pending     { background: #3d2f00; color: #e3b341; border: 1px solid #674b00; }
    .s-in_progress { background: #051d4d; color: #79c0ff; border: 1px solid #1158c7; }
    .s-completed   { background: #0f2d18; color: #3fb950; border: 1px solid #1a4428; }
    .s-failed      { background: #2d0f0f; color: #f85149; border: 1px solid #4f1010; }
    .s-cancelled   { background: #1c2128; color: #6e7681; border: 1px solid #30363d; }
    .p-high   { background: #2d0f0f; color: #f85149; border: 1px solid #4f1010; }
    .p-medium { background: #3d2f00; color: #e3b341; border: 1px solid #674b00; }
    .p-low    { background: #0f2d18; color: #3fb950; border: 1px solid #1a4428; }
    .a-available { background: #0f2d18; color: #3fb950; border: 1px solid #1a4428; }
    .a-busy      { background: #2d1f00; color: #d29922; border: 1px solid #5a3e00; }
    .a-offline   { background: #1c2128; color: #484f58; border: 1px solid #30363d; }
    .m-normal        { background: #051d4d; color: #79c0ff; border: 1px solid #1158c7; }
    .m-priority      { background: #2d0f0f; color: #f85149; border: 1px solid #4f1010; }
    .m-error         { background: #2d0f0f; color: #f85149; border: 1px solid #4f1010; }
    .m-status_update { background: #0f2d18; color: #3fb950; border: 1px solid #1a4428; }
    .desc      { max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .desc-wide { max-width: 400px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ts        { color: #484f58; font-size: 0.68rem; white-space: nowrap; }
    .agent-key { font-family: monospace; font-size: 0.72rem; color: #8b949e; }

    /* â"€â"€ Toast notifications â"€â"€ */
    #toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column-reverse; gap: 8px; max-width: 360px; }
    .toast {
      background: #1a0d0d;
      border: 1px solid #6e1515;
      border-radius: 8px;
      padding: 10px 36px 10px 14px;
      font-size: 0.78rem;
      color: #c9d1d9;
      box-shadow: 0 4px 20px rgba(0,0,0,0.7);
      animation: slideIn 0.22s ease;
      position: relative;
      cursor: default;
    }
    /* Chat toast — blue accent */
    .toast-chat {
      background: #0c1929;
      border-color: #1158c7;
      cursor: pointer;
    }
    .toast-chat:hover { background: #0f1f35; }
    @keyframes slideIn { from { transform: translateX(110%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    .toast-title { font-weight: 700; color: #f85149; margin-bottom: 3px; display: flex; align-items: center; gap: 6px; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .toast-chat .toast-title { color: #79c0ff; text-transform: none; font-size: 0.8rem; letter-spacing: 0; }
    .toast-body { color: #8b949e; font-size: 0.72rem; line-height: 1.45; }
    .toast-chat .toast-body { color: #c9d1d9; }
    .toast-dismiss { position: absolute; top: 8px; right: 10px; background: none; border: none; color: #484f58; cursor: pointer; font-size: 0.82rem; line-height: 1; padding: 0; }
    .toast-dismiss:hover { color: #c9d1d9; }

    /* â"€â"€ Teams view â"€â"€ */
    #view-teams { flex-direction: row; overflow: hidden; }

    .teams-list-panel {
      width: 280px;
      border-right: 1px solid #30363d;
      display: flex;
      flex-direction: column;
      background: #161b22;
      flex-shrink: 0;
    }
    .teams-list-header {
      padding: 16px 16px 12px;
      font-size: 1rem;
      font-weight: 700;
      color: #f0f6fc;
      border-bottom: 1px solid #30363d;
      letter-spacing: 0.01em;
    }
    .teams-agent-list { flex: 1; overflow-y: auto; }
    .agent-list-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      cursor: pointer;
      border-bottom: 1px solid #21262d;
      transition: background 0.1s;
      position: relative;
    }
    .agent-list-item:hover { background: #1c2128; }
    .agent-list-item.active { background: #1c2128; }
    .agent-list-item.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: #1158c7; border-radius: 0 2px 2px 0; }
    .agent-avatar {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.75rem;
      color: #fff;
      flex-shrink: 0;
      letter-spacing: 0.04em;
    }
    .agent-list-info { flex: 1; min-width: 0; }
    .agent-list-name { font-size: 0.82rem; font-weight: 600; color: #f0f6fc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .agent-list-preview { font-size: 0.71rem; color: #8b949e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .agent-list-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex-shrink: 0; }
    .agent-list-time { font-size: 0.62rem; color: #484f58; white-space: nowrap; }
    .unread-badge { background: #1158c7; color: #fff; border-radius: 10px; font-size: 0.62rem; font-weight: 700; padding: 1px 6px; min-width: 18px; text-align: center; }

    /* Teams chat area */
    .teams-chat-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #0d1117;
    }
    .teams-no-selection {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 14px;
      color: #484f58;
    }
    .teams-no-selection p { font-size: 0.85rem; }

    #teams-chat-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

    .teams-chat-header {
      padding: 12px 20px;
      border-bottom: 1px solid #30363d;
      background: #161b22;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .chat-hdr-avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.68rem;
      color: #fff;
      flex-shrink: 0;
    }
    .chat-hdr-name { font-size: 0.9rem; font-weight: 600; color: #f0f6fc; }
    .chat-hdr-role { font-size: 0.72rem; color: #8b949e; margin-top: 1px; }

    .teams-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .chat-empty-state { text-align: center; color: #484f58; font-size: 0.85rem; margin-top: 40px; font-style: italic; }

    .teams-msg { display: flex; gap: 10px; align-items: flex-end; }
    .teams-msg.sent { flex-direction: row-reverse; }
    .teams-msg-avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.6rem;
      color: #fff;
      flex-shrink: 0;
    }
    .teams-msg-content { display: flex; flex-direction: column; gap: 3px; max-width: 62%; }
    .teams-msg.sent .teams-msg-content { align-items: flex-end; }
    .teams-msg.recv .teams-msg-content { align-items: flex-start; }
    .teams-msg-bubble { padding: 10px 14px; border-radius: 16px; font-size: 0.82rem; line-height: 1.5; word-break: break-word; }
    .teams-msg.sent .teams-msg-bubble { background: #1158c7; color: #e6edf3; border-bottom-right-radius: 4px; }
    .teams-msg.recv .teams-msg-bubble { background: #1c2128; color: #c9d1d9; border: 1px solid #30363d; border-bottom-left-radius: 4px; }
    .teams-msg.recv .teams-msg-bubble.markdown p { margin: 0 0 8px; }
    .teams-msg.recv .teams-msg-bubble.markdown p:last-child { margin-bottom: 0; }
    .teams-msg.recv .teams-msg-bubble.markdown ul,
    .teams-msg.recv .teams-msg-bubble.markdown ol { margin: 0 0 8px 18px; padding: 0; }
    .teams-msg.recv .teams-msg-bubble.markdown li { margin: 0 0 3px; }
    .teams-msg.recv .teams-msg-bubble.markdown pre {
      margin: 8px 0;
      padding: 8px 10px;
      border-radius: 8px;
      background: #0d1117;
      border: 1px solid #30363d;
      overflow-x: auto;
    }
    .teams-msg.recv .teams-msg-bubble.markdown code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 0.76rem;
    }
    .teams-msg.recv .teams-msg-bubble.markdown a {
      color: #79c0ff;
      text-decoration: underline;
      text-decoration-thickness: 2px;
      text-underline-offset: 2px;
      font-weight: 600;
      word-break: break-all;
    }
    .teams-msg.recv .teams-msg-bubble.markdown a:hover { color: #a5d6ff; }
    .teams-msg-time { font-size: 0.6rem; color: #484f58; }

    .chat-typing-row { display: none; padding: 0 24px 6px; }
    .chat-typing-row.visible { display: block; }
    .typing-dot {
      display: inline-block;
      width: 7px; height: 7px; border-radius: 50%;
      background: #8b949e;
      animation: typing-bounce 1.4s ease infinite;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }

    .teams-chat-compose {
      padding: 12px 20px;
      border-top: 1px solid #30363d;
      display: flex;
      gap: 10px;
      align-items: flex-end;
      background: #161b22;
      flex-shrink: 0;
    }
    .teams-input {
      flex: 1;
      background: #0d1117;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 0.82rem;
      font-family: inherit;
      resize: none;
      min-height: 42px;
      max-height: 120px;
      overflow-y: auto;
      line-height: 1.4;
    }
    .teams-input:focus { outline: none; border-color: #1158c7; }
    .teams-send-btn {
      width: 40px;
      height: 40px;
      background: #1158c7;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: #fff;
      transition: background 0.15s;
    }
    .teams-send-btn:hover { background: #1a70e8; }
    .teams-send-btn:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0d1117; }
    ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #484f58; }

    /* ── Company view ── */
    /* ── HR Portal layout ── */
    #view-company { flex-direction: row; overflow: hidden; }

    /* Left panel — employee directory */
    .hr-left { width: 272px; border-right: 1px solid #30363d; display: flex; flex-direction: column; background: #161b22; flex-shrink: 0; }
    .hr-left-header { padding: 16px 16px 12px; border-bottom: 1px solid #30363d; }
    .hr-left-title { font-size: 0.95rem; font-weight: 700; color: #f0f6fc; }
    .hr-left-subtitle { font-size: 0.68rem; color: #8b949e; margin-top: 2px; }
    .hr-stats { display: flex; padding: 12px 16px; border-bottom: 1px solid #30363d; gap: 0; }
    .hr-stat { flex: 1; text-align: center; padding: 4px 0; }
    .hr-stat + .hr-stat { border-left: 1px solid #21262d; }
    .hr-stat-num { font-size: 1.05rem; font-weight: 700; color: #f0f6fc; line-height: 1; }
    .hr-stat-label { font-size: 0.58rem; color: #6b7480; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 3px; }
    .hr-emp-list { flex: 1; overflow-y: auto; }
    .hr-dept-label { font-size: 0.58rem; font-weight: 700; color: #484f58; text-transform: uppercase; letter-spacing: 0.1em; padding: 14px 16px 5px; }
    .hr-emp-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px; cursor: pointer; border-bottom: 1px solid #21262d; transition: background 0.1s; position: relative; }
    .hr-emp-item:hover { background: #1c2128; }
    .hr-emp-item.active { background: #1c2128; }
    .hr-emp-item.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: #1158c7; border-radius: 0 2px 2px 0; }
    .hr-emp-avatar { width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.65rem; color: #fff; flex-shrink: 0; letter-spacing: 0.03em; }
    .hr-emp-info { flex: 1; min-width: 0; }
    .hr-emp-name { font-size: 0.78rem; font-weight: 600; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hr-emp-role { font-size: 0.65rem; color: #8b949e; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hr-emp-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .hr-emp-dot.active { background: #3fb950; box-shadow: 0 0 4px rgba(63,185,80,0.5); }
    .hr-emp-dot.inactive { background: #30363d; }
    .hr-refresh-btn { margin: 10px 16px 14px; background: none; border: 1px solid #30363d; border-radius: 6px; color: #6b7480; font-size: 0.7rem; padding: 6px 0; cursor: pointer; width: calc(100% - 32px); transition: background 0.15s, color 0.15s; }
    .hr-refresh-btn:hover { background: #1c2128; color: #c9d1d9; }

    /* Right panel */
    .hr-right { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #0d1117; }
    .hr-no-selection { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 14px; color: #484f58; }
    .hr-no-selection p { font-size: 0.82rem; }
    .hr-profile { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

    /* Profile header */
    .hr-profile-header { padding: 22px 28px; border-bottom: 1px solid #30363d; background: #161b22; display: flex; align-items: flex-start; gap: 20px; flex-shrink: 0; }
    .hr-profile-avatar { width: 62px; height: 62px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1rem; color: #fff; flex-shrink: 0; letter-spacing: 0.04em; border: 2px solid rgba(255,255,255,0.08); }
    .hr-profile-details { flex: 1; min-width: 0; padding-top: 2px; }
    .hr-profile-name { font-size: 1.2rem; font-weight: 700; color: #f0f6fc; line-height: 1.2; }
    .hr-profile-role { font-size: 0.8rem; color: #8b949e; margin-top: 4px; }
    .hr-profile-meta { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .hr-meta-chip { display: flex; align-items: center; gap: 5px; background: #1c2128; border: 1px solid #30363d; border-radius: 5px; padding: 3px 9px; font-size: 0.67rem; color: #8b949e; }
    .hr-profile-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex-shrink: 0; padding-top: 2px; }
    .impl-badge { font-size: 0.6rem; font-weight: 700; padding: 3px 9px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em; }
    .impl-badge.active { background: #0f2d18; color: #3fb950; border: 1px solid #1a4428; }
    .impl-badge.coming-soon { background: #1c2128; color: #484f58; border: 1px solid #30363d; }
    .hr-tool-count-chip { font-size: 0.7rem; color: #6b7480; }

    /* Tools section */
    .hr-tools-section { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .hr-tools-header { padding: 12px 28px; border-bottom: 1px solid #30363d; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    .hr-tools-title { font-size: 0.8rem; font-weight: 600; color: #c9d1d9; }
    .hr-tools-actions { display: flex; gap: 6px; }
    .hr-toggle-all-btn { background: none; border: 1px solid #30363d; border-radius: 5px; color: #8b949e; font-size: 0.67rem; padding: 4px 10px; cursor: pointer; transition: background 0.12s; }
    .hr-toggle-all-btn:hover { background: #1c2128; color: #c9d1d9; }
    .hr-tools-body { flex: 1; overflow-y: auto; padding: 18px 28px; display: flex; flex-direction: column; gap: 18px; }

    /* Tool group + rows */
    .tool-group-section { display: flex; flex-direction: column; }
    .tool-group-label { font-size: 0.62rem; font-weight: 700; color: #484f58; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 6px; padding-bottom: 5px; border-bottom: 1px solid #21262d; }
    .tool-list { display: flex; flex-direction: column; }
    .tool-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 7px; transition: background 0.1s; gap: 14px; }
    .tool-row:hover { background: #161b22; }
    .tool-info { flex: 1; min-width: 0; }
    .tool-name { font-size: 0.8rem; color: #c9d1d9; font-weight: 500; }
    .tool-desc { font-size: 0.67rem; color: #6b7480; margin-top: 1px; }

    /* Toggle switch */
    .tool-toggle { position: relative; display: inline-flex; align-items: center; cursor: pointer; flex-shrink: 0; }
    .tool-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .toggle-track { width: 34px; height: 19px; background: #30363d; border-radius: 10px; transition: background 0.2s; display: block; position: relative; }
    .toggle-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 13px; height: 13px; background: #6e7681; border-radius: 50%; transition: left 0.2s, background 0.2s; }
    .tool-toggle input:checked + .toggle-track { background: #1158c7; }
    .tool-toggle input:checked + .toggle-track::after { left: 18px; background: #fff; }
    /* Locked tool row */
    .tool-row.locked { opacity: 0.55; }
    .tool-lock-icon { display: inline-flex; align-items: center; color: #484f58; margin-left: 2px; }
    .tool-locked-label { font-size: 0.62rem; color: #484f58; margin-left: 5px; letter-spacing: 0.03em; text-transform: uppercase; }

    /* Footer */
    .hr-profile-footer { padding: 13px 28px; border-top: 1px solid #30363d; display: flex; align-items: center; justify-content: space-between; background: #161b22; flex-shrink: 0; }
    .hr-save-notice { font-size: 0.68rem; color: #484f58; font-style: italic; }
    .hr-save-btn { background: #1158c7; border: none; border-radius: 6px; color: #fff; font-size: 0.78rem; font-weight: 600; padding: 8px 20px; cursor: pointer; transition: background 0.15s; }
    .hr-save-btn:hover { background: #1a70e8; }
    .hr-save-btn:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }
    .hr-save-btn.saved { background: #1a4428; color: #3fb950; }

    /* Interrupt / Unblock buttons */
    .interrupt-btn { background: #3d0e0e; border: 1px solid #6e1c1c; border-radius: 5px; color: #f85149; font-size: 0.7rem; font-weight: 600; padding: 3px 10px; cursor: pointer; transition: background 0.15s; white-space: nowrap; }
    .interrupt-btn:hover { background: #5a1a1a; }
    .interrupt-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .interrupt-btn.pending { background: #2a1a00; border-color: #5a4000; color: #e3a000; }
    .unblock-btn { background: #0d2a1a; border: 1px solid #1a4428; border-radius: 5px; color: #3fb950; font-size: 0.7rem; font-weight: 600; padding: 3px 10px; cursor: pointer; transition: background 0.15s; white-space: nowrap; }
    .unblock-btn:hover { background: #1a4428; }
    .stream-interrupt-btn { margin-right: 8px; }
    .hr-interrupt-btn { margin-top: 6px; }

    /* â"€â"€ Network view â"€â"€ */
    #view-network { flex-direction: row; overflow: hidden; background: #0d1117; position: relative; }

    .network-canvas-wrap {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }

    #agent-network {
      width: 100%;
      height: 100%;
      max-width: 820px;
      max-height: 460px;
    }

    /* Node rings and bodies */
    .node-ring {
      fill: none;
      stroke: transparent;
      stroke-width: 3;
      transition: stroke 0.3s;
    }
    .node-body {
      cursor: pointer;
      transition: opacity 0.2s, filter 0.2s;
      filter: brightness(0.85);
    }
    .agent-node:hover .node-body { filter: brightness(1.1); }
    .agent-node.selected .node-body { filter: brightness(1.2) drop-shadow(0 0 8px currentColor); }
    .agent-node.thinking .node-ring {
      stroke: #79c0ff;
      animation: ringPulse 1.4s ease-in-out infinite;
    }
    .agent-node.tool-active .node-ring { stroke: #f0883e; animation: ringPulse 0.6s ease-in-out infinite; }
    @keyframes ringPulse {
      0%, 100% { stroke-width: 3; opacity: 1; }
      50% { stroke-width: 5; opacity: 0.5; }
    }
    .node-initials {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace;
      font-weight: 700;
      font-size: 13px;
      fill: #fff;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      user-select: none;
    }
    .node-name {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace;
      font-size: 11px;
      font-weight: 600;
      fill: #f0f6fc;
      text-anchor: middle;
      pointer-events: none;
      user-select: none;
    }
    .node-role {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace;
      font-size: 9px;
      fill: #8b949e;
      text-anchor: middle;
      pointer-events: none;
      user-select: none;
    }
    .node-status-dot {
      transition: fill 0.3s;
    }
    /* Edges */
    .net-edge {
      stroke: #21262d;
      stroke-width: 1.5;
      fill: none;
    }
    .signal-dot {
      opacity: 0;
      transition: opacity 0.3s;
    }
    .signal-dot.active { opacity: 1; }

    /* â"€â"€ Stream panel (overlay, slides in from right) â"€â"€ */
    .stream-panel {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 0;
      background: rgba(13, 17, 23, 0.96);
      border-left: 1px solid #21262d;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: width 0.25s ease;
      z-index: 10;
      backdrop-filter: blur(4px);
    }
    .stream-panel.open { width: 380px; }

    .stream-header {
      padding: 12px 14px;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .stream-hdr-avatar {
      width: 32px; height: 32px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 0.65rem; color: #fff;
      flex-shrink: 0;
    }
    .stream-hdr-info { flex: 1; min-width: 0; }
    .stream-hdr-name { font-size: 0.85rem; font-weight: 600; color: #f0f6fc; }
    .stream-hdr-status { font-size: 0.7rem; color: #8b949e; margin-top: 1px; display: flex; align-items: center; gap: 5px; }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: #484f58; display: inline-block; }
    .status-dot.thinking { background: #79c0ff; animation: blink 1s ease infinite; }
    .status-dot.tool-active { background: #f0883e; }
    @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    .stream-close-btn {
      background: none; border: none; color: #484f58; cursor: pointer;
      font-size: 1rem; padding: 0; line-height: 1;
    }
    .stream-close-btn:hover { color: #c9d1d9; }

    .stream-body {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      font-family: "Courier New", Courier, monospace;
      font-size: 0.72rem;
      line-height: 1.55;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .stream-empty { color: #484f58; font-style: italic; text-align: center; margin-top: 40px; font-family: inherit; }
    .stream-turn-sep { border-top: 1px solid #21262d; margin: 8px 0 6px; }
    .tok-text { color: #c9d1d9; white-space: pre-wrap; word-break: break-word; }
    .tok-thinking { color: #8b949e; white-space: pre-wrap; word-break: break-word; font-style: italic; }
    .tok-thinking-mark { color: #6e7681; font-size: 0.65rem; margin-top: 4px; }
    .tok-tool-start { color: #f0883e; margin-top: 6px; font-weight: 600; }
    .tok-tool-args { color: #8b949e; font-size: 0.68rem; padding-left: 14px; white-space: pre-wrap; word-break: break-all; line-height: 1.4; }
    .tok-tool-end-ok { color: #3fb950; padding-left: 14px; white-space: pre-wrap; word-break: break-word; }
    .tok-tool-end-err { color: #f85149; padding-left: 14px; white-space: pre-wrap; word-break: break-word; }
    .tok-agent-start { color: #484f58; font-size: 0.65rem; margin-bottom: 4px; }
    .tok-agent-end { color: #484f58; font-size: 0.65rem; margin-top: 4px; }
  </style>
</head>
<body>

<!-- â"€â"€ Left sidebar nav â"€â"€ -->
<nav class="sidebar">
  <div class="sidebar-brand">V</div>
  <button class="nav-btn active" id="nav-dashboard" onclick="showView('dashboard')" title="Dashboard">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/>
    </svg>
  </button>
  <button class="nav-btn" id="nav-teams" onclick="showView('teams')" title="Teams">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
    </svg>
  </button>
  <button class="nav-btn" id="nav-network" onclick="showView('network')" title="Agent Network">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/>
      <line x1="12" y1="7.5" x2="6.5" y2="17" stroke="currentColor" stroke-width="1.5"/>
      <line x1="12" y1="7.5" x2="17.5" y2="17" stroke="currentColor" stroke-width="1.5"/>
      <line x1="7.5" y1="19" x2="16.5" y2="19" stroke="currentColor" stroke-width="1.5"/>
    </svg>
  </button>
  <button class="nav-btn" id="nav-company" onclick="showView('company')" title="Company">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3L2 9v2h20V9L12 3zm0 2.3L18.6 9H5.4L12 5.3zM4 13h2v5H4zm4 0h2v5H8zm4 0h2v5h-2zm4 0h2v5h-2zM2 20h20v2H2z"/>
    </svg>
  </button>
</nav>

<!-- â"€â"€ Main content â"€â"€ -->
<div class="main">

  <!-- Dashboard view -->
  <div id="view-dashboard" class="view active">
    <header>
      <h1>VEC-ATP &nbsp;|&nbsp; Live Dashboard</h1>
      <div style="display:flex;align-items:center;gap:10px">
        <!-- Bell / Alerts button -->
        <button id="alerts-btn" onclick="toggleAlertsPanel()" title="Alerts">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5S10.5 3.17 10.5 4v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
          </svg>
          <span id="alerts-btn-count">0</span>
        </button>
        <div id="refresh-indicator">Refreshing every <span>3 s</span> &nbsp;&middot;&nbsp; <span id="last-refresh">—</span></div>
      </div>
    </header>

    <!-- Alerts dropdown panel -->
    <div id="alerts-panel">
      <div class="alerts-panel-header">
        <span class="alerts-panel-title">Notifications</span>
        <div class="alerts-panel-actions">
          <button class="alerts-panel-icon-btn" title="Calendar">&#128197;</button>
          <button class="alerts-panel-icon-btn" title="Insights">&#8599;</button>
          <button class="alerts-panel-icon-btn" onclick="clearAllAlerts()" title="Clear all">&bull;&bull;&bull;</button>
        </div>
      </div>
      <div id="alerts-panel-body"></div>
    </div>

    <!-- 2Ã—2 grid -->
    <div class="grid">
      <div class="panel">
        <div class="panel-header"><h2>Tasks</h2><span class="panel-count" id="tasks-count"></span></div>
        <div class="panel-body">
          <table>
            <thead><tr><th>ID</th><th>Agent</th><th>Priority</th><th>Status</th><th>Description</th></tr></thead>
            <tbody id="tasks-body"><tr><td colspan="5" class="empty">Loading&hellip;</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>Agents</h2><span class="panel-count" id="agents-count"></span></div>
        <div class="panel-body">
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Dept</th><th>Status</th><th></th></tr></thead>
            <tbody id="agents-body"><tr><td colspan="5" class="empty">Loading&hellip;</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>PM Queue</h2><span class="panel-count" id="queue-count"></span></div>
        <div class="panel-body">
          <table>
            <thead><tr><th>From</th><th>Task</th><th>Type</th><th>Message</th></tr></thead>
            <tbody id="queue-body"><tr><td colspan="4" class="empty">Loading&hellip;</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>Events</h2><span class="panel-count" id="events-count"></span></div>
        <div class="panel-body">
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>Task</th><th>Message</th></tr></thead>
            <tbody id="events-body"><tr><td colspan="5" class="empty">Loading&hellip;</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- Teams view -->
  <div id="view-teams" class="view">

    <!-- Left: agent list -->
    <div class="teams-list-panel">
      <div class="teams-list-header">Chat</div>
      <div class="teams-agent-list" id="agent-list">
        <!-- rendered by JS -->
      </div>
    </div>

    <!-- Right: chat -->
    <div class="teams-chat-panel">
      <!-- No selection state -->
      <div class="teams-no-selection" id="teams-no-selection">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="#484f58">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
        </svg>
        <p>Select a conversation to start chatting</p>
      </div>
      <!-- Active chat area -->
      <div id="teams-chat-area" style="display:none;flex:1;overflow:hidden;flex-direction:column;">
        <div class="teams-chat-header">
          <div class="chat-hdr-avatar" id="chat-hdr-avatar"></div>
          <div>
            <div class="chat-hdr-name" id="chat-hdr-name"></div>
            <div class="chat-hdr-role" id="chat-hdr-role"></div>
          </div>
        </div>
        <div class="teams-chat-messages" id="teams-chat-messages"></div>
        <div id="chat-typing-row" class="chat-typing-row">
          <div class="teams-msg recv">
            <div class="teams-msg-avatar" id="typing-row-avatar" style="background:#8b949e"></div>
            <div class="teams-msg-content">
              <div class="teams-msg-bubble" style="background:#1c2128;border:1px solid #30363d;border-bottom-left-radius:4px;display:flex;gap:5px;align-items:center;">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="teams-chat-compose">
          <textarea class="teams-input" id="teams-input"
            placeholder="Type a message&hellip; (Enter to send, Shift+Enter for new line)"
            rows="1"></textarea>
          <button class="teams-send-btn" id="teams-send-btn" onclick="sendTeamsMsg()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

  </div>
</div>

  <!-- â"€â"€ Network view â"€â"€ -->
  <!-- Company / HR Portal view -->
  <div id="view-company" class="view">

    <!-- Left: employee directory -->
    <div class="hr-left">
      <div class="hr-left-header">
        <div class="hr-left-title">VEC Company</div>
        <div class="hr-left-subtitle">Agent Directory</div>
      </div>
      <div class="hr-stats">
        <div class="hr-stat"><div class="hr-stat-num" id="hr-stat-total">&#8212;</div><div class="hr-stat-label">Employees</div></div>
        <div class="hr-stat"><div class="hr-stat-num" id="hr-stat-active">&#8212;</div><div class="hr-stat-label">Active</div></div>
        <div class="hr-stat"><div class="hr-stat-num" id="hr-stat-depts">&#8212;</div><div class="hr-stat-label">Depts</div></div>
      </div>
      <div class="hr-emp-list" id="hr-emp-list">
        <div style="padding:20px 16px;color:#484f58;font-size:0.78rem">Loading&hellip;</div>
      </div>
      <button class="hr-refresh-btn" onclick="loadCompany()">&#8635;&nbsp; Refresh</button>
    </div>

    <!-- Right: profile + tool settings -->
    <div class="hr-right">

      <!-- No-selection state -->
      <div id="hr-no-selection" class="hr-no-selection">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="#21262d">
          <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
        </svg>
        <p>Select an employee to view their profile &amp; tool access</p>
      </div>

      <!-- Profile area (hidden until selection) -->
      <div id="hr-profile-area" class="hr-profile" style="display:none">

        <!-- Profile header -->
        <div class="hr-profile-header">
          <div class="hr-profile-avatar" id="hr-avatar"></div>
          <div class="hr-profile-details">
            <div class="hr-profile-name" id="hr-name"></div>
            <div class="hr-profile-role" id="hr-role"></div>
            <div class="hr-profile-meta" id="hr-meta"></div>
          </div>
          <div class="hr-profile-right">
            <span class="impl-badge" id="hr-impl-badge"></span>
            <span class="hr-tool-count-chip" id="hr-tool-count"></span>
            <button class="interrupt-btn hr-interrupt-btn" id="hr-interrupt-btn" onclick="hrInterruptClick()" style="display:none">Interrupt</button>
          </div>
        </div>

        <!-- Tool access -->
        <div class="hr-tools-section">
          <div class="hr-tools-header">
            <span class="hr-tools-title">Tool Access</span>
            <div class="hr-tools-actions">
              <button class="hr-toggle-all-btn" onclick="hrToggleAll(true)">All On</button>
              <button class="hr-toggle-all-btn" onclick="hrToggleAll(false)">All Off</button>
            </div>
          </div>
          <div class="hr-tools-body" id="hr-tools-body"></div>
        </div>

        <!-- Footer -->
        <div class="hr-profile-footer">
          <span class="hr-save-notice">Changes apply on next task execution</span>
          <button class="hr-save-btn" id="hr-save-btn" onclick="hrSave()">Save Changes</button>
        </div>

      </div>
    </div>
  </div>

  <div id="view-network" class="view">

    <!-- SVG canvas -->
    <div class="network-canvas-wrap">
      <svg id="agent-network" viewBox="0 0 820 440" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <!-- Gradient fills per agent -->
          <radialGradient id="grad-user" cx="50%" cy="30%" r="70%">
            <stop offset="0%" stop-color="#3a4a6e"/><stop offset="100%" stop-color="#1c2540"/>
          </radialGradient>
          <radialGradient id="grad-pm" cx="50%" cy="30%" r="70%">
            <stop offset="0%" stop-color="#1a5fc7"/><stop offset="100%" stop-color="#0d3a8a"/>
          </radialGradient>
          <radialGradient id="grad-ba" cx="50%" cy="30%" r="70%">
            <stop offset="0%" stop-color="#6e28c7"/><stop offset="100%" stop-color="#3d1580"/>
          </radialGradient>
          <radialGradient id="grad-dev" cx="50%" cy="30%" r="70%">
            <stop offset="0%" stop-color="#1a7a36"/><stop offset="100%" stop-color="#0d4520"/>
          </radialGradient>
          <!-- Glow filter -->
          <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
            <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        <!-- â"€â"€ Edges â"€â"€ -->
        <!-- user â†" pm -->
        <path id="edge-user-pm" class="net-edge" d="M 410,87 C 410,120 410,138 410,158"/>
        <!-- pm â†" ba -->
        <path id="edge-pm-ba" class="net-edge" d="M 382,224 C 360,280 295,318 258,338"/>
        <!-- pm â†" dev -->
        <path id="edge-pm-dev" class="net-edge" d="M 438,224 C 460,280 525,318 562,338"/>
        <!-- ba â†" dev -->
        <path id="edge-ba-dev" class="net-edge" d="M 278,376 C 340,392 480,392 542,376"/>
        <!-- user â†" ba -->
        <path id="edge-user-ba" class="net-edge" d="M 390,90 C 280,150 240,280 238,324"/>
        <!-- user â†" dev -->
        <path id="edge-user-dev" class="net-edge" d="M 430,90 C 540,150 580,280 582,324"/>

        <!-- â"€â"€ Signal dots (one per directional edge) â"€â"€ -->
        <circle id="sig-user-pm" class="signal-dot" r="5" fill="#79c0ff" filter="url(#glow)">
          <animateMotion dur="1.1s" repeatCount="indefinite" rotate="auto"><mpath href="#edge-user-pm"/></animateMotion>
        </circle>
        <circle id="sig-pm-user" class="signal-dot" r="5" fill="#79c0ff" filter="url(#glow)">
          <animateMotion dur="1.1s" repeatCount="indefinite" rotate="auto" keyPoints="1;0" keyTimes="0;1" calcMode="linear"><mpath href="#edge-user-pm"/></animateMotion>
        </circle>
        <circle id="sig-pm-ba" class="signal-dot" r="5" fill="#a855f7" filter="url(#glow)">
          <animateMotion dur="1.3s" repeatCount="indefinite" rotate="auto"><mpath href="#edge-pm-ba"/></animateMotion>
        </circle>
        <circle id="sig-ba-pm" class="signal-dot" r="5" fill="#a855f7" filter="url(#glow)">
          <animateMotion dur="1.3s" repeatCount="indefinite" rotate="auto" keyPoints="1;0" keyTimes="0;1" calcMode="linear"><mpath href="#edge-pm-ba"/></animateMotion>
        </circle>
        <circle id="sig-pm-dev" class="signal-dot" r="5" fill="#3fb950" filter="url(#glow)">
          <animateMotion dur="1.3s" repeatCount="indefinite" rotate="auto"><mpath href="#edge-pm-dev"/></animateMotion>
        </circle>
        <circle id="sig-dev-pm" class="signal-dot" r="5" fill="#3fb950" filter="url(#glow)">
          <animateMotion dur="1.3s" repeatCount="indefinite" rotate="auto" keyPoints="1;0" keyTimes="0;1" calcMode="linear"><mpath href="#edge-pm-dev"/></animateMotion>
        </circle>
        <!-- user â†" ba -->
        <circle id="sig-user-ba" class="signal-dot" r="5" fill="#a855f7" filter="url(#glow)">
          <animateMotion dur="1.5s" repeatCount="indefinite" rotate="auto"><mpath href="#edge-user-ba"/></animateMotion>
        </circle>
        <circle id="sig-ba-user" class="signal-dot" r="5" fill="#a855f7" filter="url(#glow)">
          <animateMotion dur="1.5s" repeatCount="indefinite" rotate="auto" keyPoints="1;0" keyTimes="0;1" calcMode="linear"><mpath href="#edge-user-ba"/></animateMotion>
        </circle>
        <!-- user â†" dev -->
        <circle id="sig-user-dev" class="signal-dot" r="5" fill="#3fb950" filter="url(#glow)">
          <animateMotion dur="1.5s" repeatCount="indefinite" rotate="auto"><mpath href="#edge-user-dev"/></animateMotion>
        </circle>
        <circle id="sig-dev-user" class="signal-dot" r="5" fill="#3fb950" filter="url(#glow)">
          <animateMotion dur="1.5s" repeatCount="indefinite" rotate="auto" keyPoints="1;0" keyTimes="0;1" calcMode="linear"><mpath href="#edge-user-dev"/></animateMotion>
        </circle>
        <!-- ba â†" dev -->
        <circle id="sig-ba-dev" class="signal-dot" r="5" fill="#f0883e" filter="url(#glow)">
          <animateMotion dur="1.4s" repeatCount="indefinite" rotate="auto"><mpath href="#edge-ba-dev"/></animateMotion>
        </circle>
        <circle id="sig-dev-ba" class="signal-dot" r="5" fill="#f0883e" filter="url(#glow)">
          <animateMotion dur="1.4s" repeatCount="indefinite" rotate="auto" keyPoints="1;0" keyTimes="0;1" calcMode="linear"><mpath href="#edge-ba-dev"/></animateMotion>
        </circle>

        <!-- â"€â"€ Agent nodes â"€â"€ -->

        <!-- Akhil / user — top center -->
        <g id="node-user" class="agent-node" onclick="selectStreamAgent('user')">
          <circle class="node-ring" cx="410" cy="60" r="44"/>
          <circle class="node-body" cx="410" cy="60" r="36" fill="url(#grad-user)" stroke="#30363d" stroke-width="1.5"/>
          <text class="node-initials" x="410" y="60">AK</text>
          <text class="node-name" x="410" y="106">Akhil</text>
          <text class="node-role" x="410" y="119">Founder</text>
        </g>

        <!-- Arjun / pm — center -->
        <g id="node-pm" class="agent-node" onclick="selectStreamAgent('pm')">
          <circle class="node-ring" cx="410" cy="192" r="50"/>
          <circle class="node-body" cx="410" cy="192" r="40" fill="url(#grad-pm)" stroke="#1158c7" stroke-width="1.5"/>
          <text class="node-initials" x="410" y="192">AS</text>
          <text class="node-name" x="410" y="244">Arjun Sharma</text>
          <text class="node-role" x="410" y="257">Project Manager</text>
        </g>

        <!-- Kavya / ba — bottom left -->
        <g id="node-ba" class="agent-node" onclick="selectStreamAgent('ba')">
          <circle class="node-ring" cx="238" cy="360" r="46"/>
          <circle class="node-body" cx="238" cy="360" r="36" fill="url(#grad-ba)" stroke="#7928ca" stroke-width="1.5"/>
          <text class="node-initials" x="238" y="360">KN</text>
          <text class="node-name" x="238" y="408">Kavya Nair</text>
          <text class="node-role" x="238" y="421">Business Analyst</text>
        </g>

        <!-- Rohan / dev — bottom right -->
        <g id="node-dev" class="agent-node" onclick="selectStreamAgent('dev')">
          <circle class="node-ring" cx="582" cy="360" r="46"/>
          <circle class="node-body" cx="582" cy="360" r="36" fill="url(#grad-dev)" stroke="#3fb950" stroke-width="1.5"/>
          <text class="node-initials" x="582" y="360">RM</text>
          <text class="node-name" x="582" y="408">Rohan Mehta</text>
          <text class="node-role" x="582" y="421">Senior Developer</text>
        </g>

        <!-- Network label -->
        <text x="410" y="440" text-anchor="middle" font-family="monospace" font-size="9" fill="#30363d">Click any node to open live stream</text>
      </svg>
    </div>

    <!-- Stream panel -->
    <div class="stream-panel" id="stream-panel">
      <div class="stream-header">
        <div class="stream-hdr-avatar" id="stream-hdr-avatar"></div>
        <div class="stream-hdr-info">
          <div class="stream-hdr-name" id="stream-hdr-name"></div>
          <div class="stream-hdr-status">
            <span class="status-dot" id="stream-status-dot"></span>
            <span id="stream-status-text">idle</span>
          </div>
        </div>
        <button class="interrupt-btn stream-interrupt-btn" id="stream-interrupt-btn" onclick="streamInterruptClick()" style="display:none">Interrupt</button>
        <button class="stream-close-btn" onclick="closeStreamPanel()">&#x2715;</button>
      </div>
      <div class="stream-body" id="stream-body">
        <div class="stream-empty" id="stream-empty">Waiting for activity&hellip;</div>
      </div>
    </div>

  </div>

</div>

<!-- Toast container -->
<div id="toast-container"></div>

<script>
  // â"€â"€ Utilities â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function isSafeHref(url) {
    return /^(https?:\/\/|mailto:)/i.test(url || '');
  }
  function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
  }
  function renderMarkdown(input) {
    const raw = String(input ?? '').replace(/\r\n/g, '\n');
    const placeholders = [];
    const hold = (html) => {
      const key = '__MDHOLD_' + placeholders.length + '__';
      placeholders.push(html);
      return key;
    };
    const unhold = (s) => s.replace(/__MDHOLD_(\d+)__/g, (_, i) => placeholders[Number(i)] || '');

    let text = esc(raw);

    text = text.replace(/\`\`\`([\s\S]*?)\`\`\`/g, (_, code) => {
      return hold('<pre><code>' + code + '</code></pre>');
    });
    text = text.replace(/\`([^\`\n]+)\`/g, (_, code) => hold('<code>' + code + '</code>'));
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, url) => {
      if (!isSafeHref(url)) return label;
      return hold('<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
    });
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)(?=$|[\s),.!?])/g, (_, lead, url) => {
      if (!isSafeHref(url)) return lead + url;
      return lead + hold('<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
    });
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

    const lines = text.split('\n');
    const out = [];
    let inUl = false;
    let inOl = false;
    const closeLists = () => {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
    };

    for (const line of lines) {
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (bullet) {
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (!inUl) { out.push('<ul>'); inUl = true; }
        out.push('<li>' + bullet[1] + '</li>');
        continue;
      }
      if (numbered) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (!inOl) { out.push('<ol>'); inOl = true; }
        out.push('<li>' + numbered[1] + '</li>');
        continue;
      }
      closeLists();
      if (!line.trim()) {
        out.push('');
      } else {
        out.push('<p>' + line + '</p>');
      }
    }
    closeLists();

    return unhold(out.join(''));
  }
  function renderChatMessage(entry) {
    const isUser = entry.from === 'user';
    if (isUser) return esc(entry.message).replace(/\n/g, '<br/>');
    return renderMarkdown(entry.message);
  }
  function badge(cls, text) {
    return '<span class="badge ' + cls + '">' + esc(text) + '</span>';
  }
  function fmt(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
    catch { return ts; }
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return ts; }
  }

  // â"€â"€ View switching â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  function showView(view) {
    document.getElementById('view-dashboard').classList.toggle('active', view === 'dashboard');
    document.getElementById('view-teams').classList.toggle('active', view === 'teams');
    document.getElementById('view-network').classList.toggle('active', view === 'network');
    document.getElementById('view-company').classList.toggle('active', view === 'company');
    document.getElementById('nav-dashboard').classList.toggle('active', view === 'dashboard');
    document.getElementById('nav-teams').classList.toggle('active', view === 'teams');
    document.getElementById('nav-network').classList.toggle('active', view === 'network');
    document.getElementById('nav-company').classList.toggle('active', view === 'company');
    // Company + Network live outside .main in the body flex row.
    // Hide .main when either is active so they can fill the full remaining width.
    const fullScreen = view === 'network' || view === 'company';
    document.querySelector('.main').style.display = fullScreen ? 'none' : 'flex';
    if (view === 'teams' && selectedAgent) markAsRead(selectedAgent);
    if (view === 'company') loadCompany();
  }

  // Network stream view
  const NETWORK_AGENTS = {
    user: { name: 'Akhil', role: 'Founder', initials: 'AK', color: '#3a4a6e' },
    pm: { name: 'Arjun Sharma', role: 'Project Manager', initials: 'AS', color: '#1158c7' },
    ba: { name: 'Kavya Nair', role: 'Business Analyst', initials: 'KN', color: '#7928ca' },
    dev: { name: 'Rohan Mehta', role: 'Senior Developer', initials: 'RM', color: '#3fb950' },
  };
  const NETWORK_SIGNAL_MAP = {
    'user-pm': 'sig-user-pm',
    'pm-user': 'sig-pm-user',
    'pm-ba': 'sig-pm-ba',
    'ba-pm': 'sig-ba-pm',
    'pm-dev': 'sig-pm-dev',
    'dev-pm': 'sig-dev-pm',
    'user-ba': 'sig-user-ba',
    'ba-user': 'sig-ba-user',
    'user-dev': 'sig-user-dev',
    'dev-user': 'sig-dev-user',
    'ba-dev': 'sig-ba-dev',
    'dev-ba': 'sig-dev-ba',
  };
  const STREAM_LOG_LIMIT = 400;
  const streamLogs = { user: [], pm: [], ba: [], dev: [] };
  const streamState = {
    user: { thinking: false, toolActive: false, toolName: '' },
    pm: { thinking: false, toolActive: false, toolName: '' },
    ba: { thinking: false, toolActive: false, toolName: '' },
    dev: { thinking: false, toolActive: false, toolName: '' },
  };
  const streamSignalTimers = {};
  let selectedStreamAgent = null;

  function pulseSignal(fromAgent, toAgent, durationMs) {
    const id = NETWORK_SIGNAL_MAP[fromAgent + '-' + toAgent];
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('active');
    if (streamSignalTimers[id]) clearTimeout(streamSignalTimers[id]);
    streamSignalTimers[id] = setTimeout(() => {
      el.classList.remove('active');
      delete streamSignalTimers[id];
    }, durationMs || 1200);
  }

  function updateNetworkNode(agentId) {
    const node = document.getElementById('node-' + agentId);
    if (!node) return;
    const st = streamState[agentId];
    node.classList.toggle('thinking', !!st.thinking);
    node.classList.toggle('tool-active', !!st.toolActive);
  }

  function statusTextFor(agentId) {
    const st = streamState[agentId];
    if (st.toolActive) return 'running tool: ' + (st.toolName || 'tool');
    if (st.thinking) return 'thinking';
    return 'idle';
  }

  function renderSelectedStream() {
    const body = document.getElementById('stream-body');
    if (!selectedStreamAgent) {
      body.innerHTML = '<div class="stream-empty">Select a node to view live stream.</div>';
      return;
    }
    const logs = streamLogs[selectedStreamAgent] || [];
    if (!logs.length) {
      body.innerHTML = '<div class="stream-empty">Waiting for activity...</div>';
      return;
    }
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    body.innerHTML = '';
    for (const entry of logs) {
      const row = document.createElement('div');
      row.className = entry.cls;
      if (entry.text) row.textContent = entry.text;
      body.appendChild(row);
    }
    if (nearBottom) body.scrollTop = body.scrollHeight;
  }

  function renderStreamHeader() {
    if (!selectedStreamAgent) return;
    const info = NETWORK_AGENTS[selectedStreamAgent];
    const avatar = document.getElementById('stream-hdr-avatar');
    avatar.style.background = info.color;
    avatar.textContent = info.initials;
    document.getElementById('stream-hdr-name').textContent = info.name + ' (' + selectedStreamAgent + ')';
    document.getElementById('stream-status-text').textContent = statusTextFor(selectedStreamAgent);
    const dot = document.getElementById('stream-status-dot');
    dot.classList.remove('thinking', 'tool-active');
    if (streamState[selectedStreamAgent].toolActive) dot.classList.add('tool-active');
    else if (streamState[selectedStreamAgent].thinking) dot.classList.add('thinking');
    // Interrupt button in stream header
    const ibtn = document.getElementById('stream-interrupt-btn');
    if (ibtn && selectedStreamAgent !== 'user') {
      ibtn.style.display = '';
      if (latestInterrupts[selectedStreamAgent]) {
        ibtn.textContent = 'Clear Interrupt';
        ibtn.className = 'unblock-btn stream-interrupt-btn';
      } else {
        ibtn.textContent = 'Interrupt';
        ibtn.className = 'interrupt-btn stream-interrupt-btn';
      }
    }
  }

  function pushStreamLog(agentId, kind, cls, text) {
    const bucket = streamLogs[agentId];
    if (!bucket) return;

    if (kind === 'text' || kind === 'thinking') {
      const last = bucket[bucket.length - 1];
      if (last && last.kind === kind) {
        last.text += text || '';
      } else {
        bucket.push({ kind: kind, cls: cls, text: text || '' });
      }
    } else {
      bucket.push({ kind: kind, cls: cls, text: text || '' });
    }

    if (bucket.length > STREAM_LOG_LIMIT) {
      bucket.splice(0, bucket.length - STREAM_LOG_LIMIT);
    }

    if (selectedStreamAgent === agentId) {
      renderSelectedStream();
      renderStreamHeader();
    }
  }

  function tryGetToolTarget(token) {
    const args = token && token.toolArgs && typeof token.toolArgs === 'object' ? token.toolArgs : null;
    if (!args) return '';
    const candidate = args.to_agent || args.toAgent || args.agent_id || args.agentId || '';
    return typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
  }

  function onStreamToken(token) {
    if (!token || !token.agentId || !streamState[token.agentId]) return;
    const agentId = token.agentId;

    switch (token.type) {
      case 'agent_start':
        streamState[agentId].thinking = true;
        streamState[agentId].toolActive = false;
        streamState[agentId].toolName = '';
        pushStreamLog(agentId, 'sep', 'stream-turn-sep', '');
        pushStreamLog(agentId, 'agent_start', 'tok-agent-start', '[' + fmt(new Date().toISOString()) + '] turn started');
        if (agentId === selectedAgent) showChatTyping(agentId);
        break;

      case 'text':
        if (token.content) pushStreamLog(agentId, 'text', 'tok-text', token.content);
        break;

      case 'thinking_start':
        pushStreamLog(agentId, 'thinking_start', 'tok-thinking-mark', '[thinking]');
        break;

      case 'thinking':
        if (token.content) pushStreamLog(agentId, 'thinking', 'tok-thinking', token.content);
        break;

      case 'thinking_end':
        pushStreamLog(agentId, 'thinking_end', 'tok-thinking-mark', '[/thinking]');
        break;

      case 'tool_start': {
        streamState[agentId].toolActive = true;
        const tName = token.toolName || token.content || 'tool';
        streamState[agentId].toolName = tName;
        pushStreamLog(agentId, 'tool_start', 'tok-tool-start', '\u25B8 ' + tName);
        // Show args compactly (up to 4 key=value pairs)
        const tArgs = token.toolArgs && typeof token.toolArgs === 'object' ? token.toolArgs : null;
        if (tArgs) {
          const argLines = Object.entries(tArgs).slice(0, 4).map(([k, v]) => {
            const raw = typeof v === 'string' ? v : JSON.stringify(v);
            const s = raw.length > 80 ? raw.substring(0, 80) + '\u2026' : raw;
            return '  ' + k + ': ' + s;
          }).join('\n');
          if (argLines) pushStreamLog(agentId, 'tool_args', 'tok-tool-args', argLines);
        }
        if (tName.toLowerCase() === 'message_agent') {
          const toAgent = tryGetToolTarget(token);
          if (toAgent) pulseSignal(agentId, toAgent, 1400);
        }
        break;
      }

      case 'tool_end': {
        streamState[agentId].toolActive = false;
        const result = typeof token.toolResult === 'string' ? token.toolResult.trim() : '';
        if (token.isError) {
          pushStreamLog(agentId, 'tool_end', 'tok-tool-end-err', '  \u21B3 \u2717 ' + (result || 'error'));
        } else {
          pushStreamLog(agentId, 'tool_end', 'tok-tool-end-ok', '  \u21B3 ' + (result || 'done'));
        }
        break;
      }

      case 'agent_end':
        streamState[agentId].thinking = false;
        streamState[agentId].toolActive = false;
        streamState[agentId].toolName = '';
        pushStreamLog(agentId, 'agent_end', 'tok-agent-end', '[' + fmt(new Date().toISOString()) + '] turn finished');
        if (agentId === 'ba' || agentId === 'dev') pulseSignal(agentId, 'pm', 900);
        if (agentId === selectedAgent) hideChatTyping();
        break;

      default:
        break;
    }

    updateNetworkNode(agentId);
    if (selectedStreamAgent === agentId) renderStreamHeader();
  }

  function selectStreamAgent(agentId) {
    if (!NETWORK_AGENTS[agentId]) return;
    selectedStreamAgent = agentId;
    document.querySelectorAll('.agent-node').forEach((el) => {
      el.classList.toggle('selected', el.id === ('node-' + agentId));
    });
    document.getElementById('stream-panel').classList.add('open');
    renderStreamHeader();
    renderSelectedStream();
  }

  function closeStreamPanel() {
    selectedStreamAgent = null;
    document.getElementById('stream-panel').classList.remove('open');
    document.querySelectorAll('.agent-node').forEach((el) => el.classList.remove('selected'));
  }

  // Expose for inline onclick handlers inside SVG/HTML.
  window.selectStreamAgent = selectStreamAgent;
  window.closeStreamPanel = closeStreamPanel;

  const streamSource = new EventSource('/api/stream');
  streamSource.onmessage = (ev) => {
    try {
      onStreamToken(JSON.parse(ev.data));
    } catch (err) {
      console.error('stream parse error:', err);
    }
  };
  streamSource.onerror = () => {
    // EventSource auto-reconnects.
  };

  // â"€â"€ Alerts panel â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  let errorsInitialized = false;
  let errorsUnreadCount = 0;
  let latestErrorsData = [];
  const dismissedKeys = new Set();  // keys cleared by user — survive refresh cycles

  function alertKey(e) {
    return e.timestamp + '|' + e.agent_id + '|' + e.task_id + '|' + e.kind;
  }

  function toggleAlertsPanel() {
    const panel = document.getElementById('alerts-panel');
    if (panel.classList.contains('open')) {
      panel.classList.remove('open');
    } else {
      panel.classList.add('open');
      errorsUnreadCount = 0;
      syncErrorsBadge(latestErrorsData.filter(e => !dismissedKeys.has(alertKey(e))).length);
    }
  }
  function closeAlertsPanel() {
    document.getElementById('alerts-panel').classList.remove('open');
  }
  function clearAllAlerts() {
    // Mark every current alert as dismissed so refresh() won't re-show them
    for (const e of latestErrorsData) dismissedKeys.add(alertKey(e));
    errorsUnreadCount = 0;
    document.getElementById('alerts-panel-body').innerHTML =
      '<div class="alerts-empty-state">All clear.</div>';
    syncErrorsBadge(0);
    closeAlertsPanel();
  }
  // Close panel when clicking outside
  document.addEventListener('click', e => {
    const panel = document.getElementById('alerts-panel');
    const btn = document.getElementById('alerts-btn');
    if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target)) {
      closeAlertsPanel();
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAlertsPanel(); });

  function syncErrorsBadge(total) {
    const btn = document.getElementById('alerts-btn');
    const cnt = document.getElementById('alerts-btn-count');
    if (!total) {
      btn.classList.remove('has-errors', 'badge-new');
      cnt.textContent = '';
      return;
    }
    btn.classList.add('has-errors');
    cnt.textContent = errorsUnreadCount > 0 ? String(errorsUnreadCount) : String(total);
    if (errorsUnreadCount > 0) btn.classList.add('badge-new');
    else btn.classList.remove('badge-new');
  }

  // â"€â"€ Error toasts â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  const seenErrorTs = new Set();

  function errorKindGlyph(kind) {
    switch (String(kind || 'generic')) {
      case 'rate_limit': return '↻';
      case 'timeout': return '⌛';
      case 'network': return '⇄';
      case 'quota': return '$';
      case 'crashed': return '🔧';
      default: return '⌕';
    }
  }

  function showErrorToast(error) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = \`
      <div class="toast-title">\${esc(error.label)}</div>
      <div class="toast-body">
        <strong style="color:#c9d1d9">\${esc(error.agent_id || '?')}</strong>
        \${error.task_id ? '<span style="color:#484f58"> &middot; ' + esc(error.task_id) + '</span>' : ''}
        <br/>\${esc((error.message || '').substring(0, 120))}
      </div>
      <button class="toast-dismiss" onclick="this.parentElement.remove()">&#x2715;</button>
    \`;
    container.appendChild(toast);
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 8000);
  }

  // â"€â"€ Render: Errors â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  function renderErrors(data) {
    const body = document.getElementById('alerts-panel-body');
    const isPanelOpen = document.getElementById('alerts-panel').classList.contains('open');
    // Track new arrivals for toast + unread count
    for (const e of data) {
      const key = alertKey(e);
      if (!seenErrorTs.has(key)) {
        seenErrorTs.add(key);
        if (errorsInitialized && !dismissedKeys.has(key)) {
          showErrorToast(e);
          if (!isPanelOpen) errorsUnreadCount++;
        }
      }
    }
    latestErrorsData = data;
    // Filter out dismissed items
    const visible = data.filter(e => !dismissedKeys.has(alertKey(e)));
    syncErrorsBadge(visible.length);
    if (!visible.length) {
      body.innerHTML = '<div class="alerts-empty-state">All clear.</div>';
      return;
    }
    body.innerHTML = visible.map(e => {
      const kind = String(e.kind || 'generic').toLowerCase();
      const kindLabel = { rate_limit: 'Rate limit', timeout: 'Timeout', network: 'Network', quota: 'Quota', crashed: 'Issue', generic: 'Search' }[kind] || 'Search';
      const taskPart = e.task_id ? ' · ' + esc(e.task_id) : '';
      return \`
        <div class="alert-row">
          <div class="alert-accent kind-\${kind}">\${errorKindGlyph(kind)}</div>
          <div class="alert-row-inner">
            <div class="alert-row-content">
              <div class="alert-row-title" title="\${esc(e.message)}">\${esc(e.message)}</div>
              <div class="alert-row-meta">
                <span class="alert-kind-pill kind-\${kind}">\${kindLabel}</span>
                <span class="alert-row-agent">&middot; Task ran\${taskPart}</span>
              </div>
            </div>
            <div class="alert-row-time">\${fmt(e.timestamp)}</div>
          </div>
        </div>
      \`;
    }).join('');
  }
  function renderTasks(data) {
    const tbody = document.getElementById('tasks-body');
    document.getElementById('tasks-count').textContent = data.length + ' task(s)';
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No tasks yet.</td></tr>'; return; }
    tbody.innerHTML = data.map(t => \`
      <tr>
        <td style="white-space:nowrap;font-family:monospace">\${esc(t.task_id)}</td>
        <td class="agent-key">\${esc(t.agent_id)}</td>
        <td>\${badge('p-' + t.priority, t.priority)}</td>
        <td>\${badge('s-' + t.status, t.status.replace('_',' '))}</td>
        <td class="desc" title="\${esc(t.description)}">\${esc(t.description)}</td>
      </tr>
    \`).join('');
  }

  // â"€â"€ Render: Agents â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  function renderAgents(data) {
    const tbody = document.getElementById('agents-body');
    document.getElementById('agents-count').textContent = data.length + ' agent(s)';
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No agents registered.</td></tr>'; return; }
    tbody.innerHTML = data.map(e => {
      const key = (e.agent_id || '').toLowerCase();
      const isImplemented = ['pm', 'ba', 'dev'].includes(key);
      let actionHtml = '';
      if (isImplemented) {
        if (latestInterrupts[key]) {
          actionHtml = \`<button class="unblock-btn" onclick="doUnblock('\${esc(key)}')">Clear</button>\`;
        } else {
          actionHtml = \`<button class="interrupt-btn" onclick="doInterrupt('\${esc(key)}')">Interrupt</button>\`;
        }
      }
      return \`
      <tr>
        <td style="white-space:nowrap">\${esc(e.name)}</td>
        <td class="desc" title="\${esc(e.designation)}">\${esc(e.designation)}</td>
        <td>\${esc(e.department)}</td>
        <td>\${badge('a-' + e.status, e.status)}</td>
        <td style="white-space:nowrap">\${actionHtml}</td>
      </tr>
    \`;
    }).join('');
  }

  // â"€â"€ Render: PM Queue â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  function renderQueue(data) {
    const tbody = document.getElementById('queue-body');
    document.getElementById('queue-count').textContent = data.length + ' msg(s)';
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">PM inbox empty.</td></tr>'; return; }
    tbody.innerHTML = data.map(m => \`
      <tr>
        <td class="agent-key">\${esc(m.from_agent)}</td>
        <td style="white-space:nowrap;font-family:monospace">\${esc(m.task_id || '—')}</td>
        <td>\${badge('m-' + (m.type||'normal'), m.type||'msg')}</td>
        <td class="desc" title="\${esc(m.message)}">\${esc(m.message)}</td>
      </tr>
    \`).join('');
  }

  // â"€â"€ Render: Events â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  function renderEvents(data) {
    const tbody = document.getElementById('events-body');
    document.getElementById('events-count').textContent = data.length + ' event(s)';
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No events yet.</td></tr>'; return; }
    const rows = [...data].reverse();
    tbody.innerHTML = rows.map(e => {
      const isFail = e.event_type === 'task_failed';
      return \`
        <tr\${isFail ? ' class="error-row"' : ''}>
          <td class="ts">\${fmt(e.timestamp)}</td>
          <td style="white-space:nowrap;font-size:0.7rem;color:\${isFail ? '#f85149' : '#8b949e'}">\${esc(e.event_type)}</td>
          <td class="agent-key">\${esc(e.agent_id||'—')}</td>
          <td style="white-space:nowrap;font-family:monospace;font-size:0.7rem">\${esc(e.task_id||'—')}</td>
          <td class="desc" title="\${esc(e.message)}">\${esc(e.message)}</td>
        </tr>
      \`;
    }).join('');
  }

  // â"€â"€ Teams â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  const AGENTS = [
    { key: 'pm',  name: 'Arjun Sharma', role: 'Project Manager',  initials: 'AS', color: '#1158c7' },
    { key: 'ba',  name: 'Kavya Nair',   role: 'Business Analyst', initials: 'KN', color: '#7928ca' },
    { key: 'dev', name: 'Rohan Mehta',  role: 'Senior Developer', initials: 'RM', color: '#3fb950' },
  ];

  let selectedAgent = null;
  let latestChatLog = [];
  let latestInterrupts = {};

  // Track last-read timestamp per agent (set on page load to suppress historical unread counts)
  const lastReadTs = {};
  // Track which chat message IDs we've already notified about
  const seenChatIds = new Set();
  let chatInitialized = false;

  function getConversation(agentKey, log) {
    return log.filter(e =>
      (e.from === agentKey && e.to === 'user') ||
      (e.from === 'user' && e.to === agentKey)
    );
  }

  // Count messages from agent that arrived after lastReadTs
  function getUnreadCount(agentKey, log) {
    const lastTs = lastReadTs[agentKey] || '';
    return log.filter(e => e.from === agentKey && e.to === 'user' && e.timestamp > lastTs).length;
  }

  function markAsRead(agentKey) {
    lastReadTs[agentKey] = new Date().toISOString();
    renderAgentList(latestChatLog);
    updateTeamsBadge();
  }

  // Update the red badge on the Teams nav icon
  function updateTeamsBadge() {
    const total = AGENTS.reduce((sum, a) => sum + getUnreadCount(a.key, latestChatLog), 0);
    const btn = document.getElementById('nav-teams');
    let navBadge = btn.querySelector('.nav-badge');
    if (total > 0) {
      if (!navBadge) {
        navBadge = document.createElement('div');
        navBadge.className = 'nav-badge';
        btn.appendChild(navBadge);
      }
      navBadge.textContent = total > 99 ? '99+' : String(total);
    } else if (navBadge) {
      navBadge.remove();
    }
  }

  // Show a Teams-style in-app notification for a new agent message
  function showChatToast(entry) {
    const agent = AGENTS.find(a => a.key === entry.from);
    if (!agent) return;
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-chat';
    toast.innerHTML = \`
      <div class="toast-title">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:\${agent.color};flex-shrink:0"></span>
        \${esc(agent.name)}
      </div>
      <div class="toast-body">\${esc((entry.message || '').substring(0, 110))}</div>
      <button class="toast-dismiss" onclick="event.stopPropagation();this.parentElement.remove()">&#x2715;</button>
    \`;
    toast.addEventListener('click', () => {
      showView('teams');
      selectAgent(entry.from);
      toast.remove();
    });
    container.appendChild(toast);
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 7000);
  }

  // Check for new agentâ†’user messages and fire notifications
  function checkNewChatMessages(log) {
    if (!chatInitialized) return;
    let hasNew = false;
    for (const entry of log) {
      if (!entry.id || entry.from === 'user') continue;
      if (seenChatIds.has(entry.id)) continue;
      seenChatIds.add(entry.id);
      hasNew = true;
      showChatToast(entry);
    }
    if (hasNew) updateTeamsBadge();
  }

  function renderAgentList(log) {
    const container = document.getElementById('agent-list');
    container.innerHTML = AGENTS.map(agent => {
      const msgs = getConversation(agent.key, log);
      const last = msgs[msgs.length - 1];
      const preview = last
        ? (last.from === 'user' ? 'You: ' + last.message : last.message)
        : 'No messages yet';
      const time = last ? fmt(last.timestamp) : '';
      const unread = getUnreadCount(agent.key, log);
      return \`
        <div class="agent-list-item \${selectedAgent === agent.key ? 'active' : ''}"
             data-key="\${agent.key}" onclick="selectAgent('\${agent.key}')">
          <div class="agent-avatar" style="background:\${agent.color}">\${agent.initials}</div>
          <div class="agent-list-info">
            <div class="agent-list-name">\${esc(agent.name)}</div>
            <div class="agent-list-preview">\${esc(preview.substring(0, 46))}</div>
          </div>
          <div class="agent-list-meta">
            <div class="agent-list-time">\${time}</div>
            \${unread > 0 ? \`<div class="unread-badge">\${unread}</div>\` : ''}
          </div>
        </div>
      \`;
    }).join('');
  }

  function selectAgent(key) {
    selectedAgent = key;
    const agent = AGENTS.find(a => a.key === key);
    document.querySelectorAll('.agent-list-item').forEach(el => {
      el.classList.toggle('active', el.dataset.key === key);
    });
    document.getElementById('teams-no-selection').style.display = 'none';
    const area = document.getElementById('teams-chat-area');
    area.style.display = 'flex';
    const av = document.getElementById('chat-hdr-avatar');
    av.style.background = agent.color;
    av.textContent = agent.initials;
    document.getElementById('chat-hdr-name').textContent = agent.name;
    document.getElementById('chat-hdr-role').textContent = agent.role;
    renderConversation(latestChatLog);
    document.getElementById('teams-input').focus();
    // Mark this conversation as read
    markAsRead(key);
    // Sync typing indicator with the newly selected agent
    if (streamState[key]?.thinking) showChatTyping(key);
    else hideChatTyping();
  }

  function showChatTyping(agentId) {
    const agent = AGENTS.find(a => a.key === agentId);
    if (!agent) return;
    const row = document.getElementById('chat-typing-row');
    const avatar = document.getElementById('typing-row-avatar');
    if (!row || !avatar) return;
    avatar.textContent = agent.initials;
    avatar.style.background = agent.color;
    row.classList.add('visible');
    const container = document.getElementById('teams-chat-messages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  function hideChatTyping() {
    const row = document.getElementById('chat-typing-row');
    if (row) row.classList.remove('visible');
  }

  function renderConversation(log) {
    if (!selectedAgent) return;
    const agent = AGENTS.find(a => a.key === selectedAgent);
    const msgs = getConversation(selectedAgent, log);
    const container = document.getElementById('teams-chat-messages');
    if (!msgs.length) {
      container.innerHTML = '<div class="chat-empty-state">No messages yet — say hello!</div>';
      return;
    }
    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    container.innerHTML = msgs.map(entry => {
      const isUser = entry.from === 'user';
      return \`
        <div class="teams-msg \${isUser ? 'sent' : 'recv'}">
          \${!isUser ? \`<div class="teams-msg-avatar" style="background:\${agent.color}">\${agent.initials}</div>\` : ''}
          <div class="teams-msg-content">
            <div class="teams-msg-bubble \${!isUser ? 'markdown' : ''}">\${renderChatMessage(entry)}</div>
            <div class="teams-msg-time">\${fmt(entry.timestamp)}</div>
          </div>
        </div>
      \`;
    }).join('');
    if (wasAtBottom) container.scrollTop = container.scrollHeight;
  }

  async function sendTeamsMsg() {
    if (!selectedAgent) return;
    const input = document.getElementById('teams-input');
    const message = input.value.trim();
    if (!message) return;
    const btn = document.getElementById('teams-send-btn');
    btn.disabled = true;
    try {
      await fetch('/api/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: selectedAgent, message }),
      });
      input.value = '';
      input.style.height = 'auto';
      await refresh();
    } catch (err) {
      console.error('Send error:', err);
    } finally {
      btn.disabled = false;
    }
  }

  // Enter to send, Shift+Enter for newline
  document.getElementById('teams-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTeamsMsg(); }
  });
  // Auto-grow textarea
  document.getElementById('teams-input').addEventListener('input', e => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });

  // â"€â"€ Refresh loop â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  async function refresh() {
    try {
      const [tasks, employees, events, queue, errors, chatLog, interrupts] = await Promise.all([
        fetch('/api/tasks').then(r => r.json()),
        fetch('/api/employees').then(r => r.json()),
        fetch('/api/events').then(r => r.json()),
        fetch('/api/queue').then(r => r.json()),
        fetch('/api/errors').then(r => r.json()),
        fetch('/api/chat-log').then(r => r.json()),
        fetch('/api/interrupts').then(r => r.json()),
      ]);
      latestInterrupts = interrupts || {};
      renderErrors(errors);
      renderTasks(tasks);
      renderAgents(employees);
      renderQueue(queue);
      renderEvents(events);
      latestChatLog = chatLog;
      checkNewChatMessages(chatLog);
      renderAgentList(chatLog);
      renderConversation(chatLog);
      updateTeamsBadge();
      updateHrInterruptBtn();
      renderStreamHeader();
      document.getElementById('last-refresh').textContent = fmt(new Date().toISOString());
    } catch (err) {
      console.error('Refresh error:', err);
    }
  }

  // â"€â"€ Initialise: seed seen sets so first load never spams notifications â"€â"€â"€â"€â"€â"€
  Promise.all([
    fetch('/api/errors').then(r => r.json()).catch(() => []),
    fetch('/api/chat-log').then(r => r.json()).catch(() => []),
  ]).then(([errors, chatLog]) => {
    // Seed error keys — existing errors are already "seen"
    for (const e of errors) {
      seenErrorTs.add(e.timestamp + '|' + e.agent_id + '|' + e.task_id + '|' + e.kind);
    }
    errorsInitialized = true;

    // Seed chat IDs — existing messages are already "read"
    for (const entry of chatLog) {
      if (entry.id) seenChatIds.add(entry.id);
    }
    // Initialize lastReadTs: messages already in log are considered read
    for (const agent of AGENTS) {
      const agentMsgs = chatLog.filter(e => e.from === agent.key && e.to === 'user');
      const last = agentMsgs[agentMsgs.length - 1];
      lastReadTs[agent.key] = last ? last.timestamp : new Date().toISOString();
    }
    chatInitialized = true;

    refresh();
    setInterval(refresh, 3000);
  });

  // ── Company / HR Portal view ────────────────────────────────────────────────
  let companyData = [];
  let selectedHrAgent = null;
  const HR_DEPT_ORDER = ['Management', 'Engineering', 'Product'];

  async function loadCompany() {
    try {
      const data = await fetch('/api/company').then(r => r.json());
      companyData = data;
      renderHrLeft(data);
      if (selectedHrAgent) {
        const profile = data.find(a => a.agent_id === selectedHrAgent);
        if (profile) renderHrProfile(profile);
      }
    } catch (err) {
      document.getElementById('hr-emp-list').innerHTML =
        '<div style="padding:16px;color:#484f58;font-size:0.78rem">Failed to load</div>';
    }
  }

  function renderHrLeft(agents) {
    const depts = new Set(agents.map(a => a.department));
    document.getElementById('hr-stat-total').textContent = agents.length;
    document.getElementById('hr-stat-active').textContent = agents.filter(a => a.implemented).length;
    document.getElementById('hr-stat-depts').textContent = depts.size;

    const byDept = {};
    for (const a of agents) {
      if (!byDept[a.department]) byDept[a.department] = [];
      byDept[a.department].push(a);
    }
    const deptKeys = HR_DEPT_ORDER.filter(d => byDept[d])
      .concat(Object.keys(byDept).filter(d => !HR_DEPT_ORDER.includes(d)));

    document.getElementById('hr-emp-list').innerHTML = deptKeys.map(dept => \`
      <div class="hr-dept-label">\${esc(dept)}</div>
      \${byDept[dept].map(a => \`
        <div class="hr-emp-item \${selectedHrAgent === a.agent_id ? 'active' : ''}"
             data-id="\${esc(a.agent_id)}" onclick="selectHrAgent('\${esc(a.agent_id)}')">
          <div class="hr-emp-avatar" style="background:\${esc(a.color)}">\${esc(a.initials)}</div>
          <div class="hr-emp-info">
            <div class="hr-emp-name">\${esc(a.name)}</div>
            <div class="hr-emp-role">\${esc(a.role)}</div>
          </div>
          <div class="hr-emp-dot \${a.implemented ? 'active' : 'inactive'}"
               title="\${a.implemented ? 'Active' : 'Coming soon'}"></div>
        </div>
      \`).join('')}
    \`).join('');
  }

  function selectHrAgent(agentId) {
    selectedHrAgent = agentId;
    document.querySelectorAll('.hr-emp-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === agentId);
    });
    const profile = companyData.find(a => a.agent_id === agentId);
    if (profile) renderHrProfile(profile);
  }

  function groupToolsByGroup(tools) {
    const groups = {};
    for (const t of tools) {
      if (!groups[t.group]) groups[t.group] = [];
      groups[t.group].push(t);
    }
    return groups;
  }

  function renderHrProfile(a) {
    const enabled = new Set(a.enabledTools || a.tools.map(t => t.id));
    const enabledCount = a.tools.filter(t => enabled.has(t.id)).length;

    document.getElementById('hr-no-selection').style.display = 'none';
    document.getElementById('hr-profile-area').style.display = 'flex';

    // Header
    const av = document.getElementById('hr-avatar');
    av.style.background = a.color;
    av.textContent = a.initials;
    document.getElementById('hr-name').textContent = a.name;
    document.getElementById('hr-role').textContent = a.role;
    document.getElementById('hr-meta').innerHTML = \`
      <div class="hr-meta-chip">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 7V3H2v18h20V7H12zm-2 12H4v-2h6v2zm0-4H4v-2h6v2zm0-4H4V9h6v2zm0-4H4V5h6v2zm10 12h-8V9h8v10zm-2-8h-4v2h4v-2zm0 4h-4v2h4v-2z"/>
        </svg>
        \${esc(a.department)}
      </div>
      <div class="hr-meta-chip">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
        </svg>
        \${esc(a.agent_id.toUpperCase())}
      </div>
    \`;

    const badge = document.getElementById('hr-impl-badge');
    badge.textContent = a.implemented ? 'Active' : 'Coming Soon';
    badge.className = 'impl-badge ' + (a.implemented ? 'active' : 'coming-soon');
    document.getElementById('hr-tool-count').textContent = enabledCount + '/' + a.tools.length + ' tools enabled';

    // Tool groups
    const groups = groupToolsByGroup(a.tools);
    document.getElementById('hr-tools-body').innerHTML = Object.entries(groups).map(([group, tools]) => \`
      <div class="tool-group-section">
        <div class="tool-group-label">\${esc(group)}</div>
        <div class="tool-list">
          \${tools.map(t => t.locked ? \`
            <div class="tool-row locked">
              <div class="tool-info">
                <div class="tool-name">\${esc(t.name)}</div>
                <div class="tool-desc">\${esc(t.description)}</div>
              </div>
              <div style="display:inline-flex;align-items:center;flex-shrink:0;">
                <span class="tool-lock-icon">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                  </svg>
                </span>
                <span class="tool-locked-label">Always on</span>
              </div>
            </div>
          \` : \`
            <div class="tool-row">
              <div class="tool-info">
                <div class="tool-name">\${esc(t.name)}</div>
                <div class="tool-desc">\${esc(t.description)}</div>
              </div>
              <label class="tool-toggle">
                <input type="checkbox" data-tool="\${esc(t.id)}"
                       \${enabled.has(t.id) ? 'checked' : ''} onchange="hrOnToggle()">
                <span class="toggle-track"></span>
              </label>
            </div>
          \`).join('')}
        </div>
      </div>
    \`).join('');

    const btn = document.getElementById('hr-save-btn');
    btn.textContent = 'Save Changes';
    btn.classList.remove('saved');
    btn.disabled = false;
    updateHrInterruptBtn();
  }

  function hrOnToggle() {
    const checkboxes = document.querySelectorAll('#hr-tools-body input[type="checkbox"]');
    const checked = [...checkboxes].filter(cb => cb.checked).length;
    const profile = companyData.find(a => a.agent_id === selectedHrAgent);
    const lockedCount = profile ? profile.tools.filter(t => t.locked).length : 0;
    const total = profile ? profile.tools.length : checkboxes.length;
    document.getElementById('hr-tool-count').textContent = (checked + lockedCount) + '/' + total + ' tools enabled';
    const btn = document.getElementById('hr-save-btn');
    btn.textContent = 'Save Changes';
    btn.classList.remove('saved');
    btn.disabled = false;
  }

  function hrToggleAll(state) {
    // Skip locked tools — they have no checkbox to toggle
    document.querySelectorAll('#hr-tools-body input[type="checkbox"]').forEach(cb => { cb.checked = state; });
    hrOnToggle();
  }

  async function hrSave() {
    if (!selectedHrAgent) return;
    const btn = document.getElementById('hr-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving\u2026';
    const tools = [...document.querySelectorAll('#hr-tools-body input[type="checkbox"]:checked')]
      .map(cb => cb.dataset.tool);
    try {
      const r = await fetch('/api/agent-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: selectedHrAgent, tools }),
      });
      if (r.ok) {
        btn.textContent = 'Saved \u2713';
        btn.classList.add('saved');
        const profile = companyData.find(a => a.agent_id === selectedHrAgent);
        if (profile) profile.enabledTools = tools;
        setTimeout(() => { btn.textContent = 'Save Changes'; btn.classList.remove('saved'); btn.disabled = false; }, 2200);
      } else {
        btn.textContent = 'Error'; btn.disabled = false;
      }
    } catch {
      btn.textContent = 'Error'; btn.disabled = false;
    }
  }

  // ── Interrupt helpers ─────────────────────────────────────────────────────
  async function doInterrupt(agentId) {
    try {
      await fetch('/api/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, reason: 'Interrupted via dashboard' }),
      });
      await refresh();
    } catch (err) {
      console.error('Interrupt error:', err);
    }
  }

  async function doUnblock(agentId) {
    try {
      await fetch('/api/interrupt/' + agentId, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      console.error('Unblock error:', err);
    }
  }

  function streamInterruptClick() {
    if (!selectedStreamAgent || selectedStreamAgent === 'user') return;
    if (latestInterrupts[selectedStreamAgent]) {
      doUnblock(selectedStreamAgent);
    } else {
      doInterrupt(selectedStreamAgent);
    }
  }

  function hrInterruptClick() {
    if (!selectedHrAgent) return;
    if (latestInterrupts[selectedHrAgent]) {
      doUnblock(selectedHrAgent);
    } else {
      doInterrupt(selectedHrAgent);
    }
  }

  function updateHrInterruptBtn() {
    const ibtn = document.getElementById('hr-interrupt-btn');
    if (!ibtn || !selectedHrAgent) return;
    const ACTIVE = ['pm', 'ba', 'dev'];
    if (!ACTIVE.includes(selectedHrAgent)) { ibtn.style.display = 'none'; return; }
    ibtn.style.display = '';
    if (latestInterrupts[selectedHrAgent]) {
      ibtn.textContent = 'Clear Interrupt';
      ibtn.className = 'unblock-btn hr-interrupt-btn';
    } else {
      ibtn.textContent = 'Interrupt';
      ibtn.className = 'interrupt-btn hr-interrupt-btn';
    }
  }

  window.toggleAlertsPanel = toggleAlertsPanel;
  window.clearAllAlerts = clearAllAlerts;
  window.loadCompany = loadCompany;
  window.selectHrAgent = selectHrAgent;
  window.hrToggleAll = hrToggleAll;
  window.hrSave = hrSave;
  window.hrOnToggle = hrOnToggle;
  window.doInterrupt = doInterrupt;
  window.doUnblock = doUnblock;
  window.streamInterruptClick = streamInterruptClick;
  window.hrInterruptClick = hrInterruptClick;
</script>
</body>
</html>`;
}

// â"€â"€ Server â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

export function startDashboardServer(runtime: AgentRuntime, port = config.dashboardPort): void {
  const agents = runtime.allAgents; // backward compat — same Map reference
  const app = express();

  // ── Security middleware ──────────────────────────────────────────────────
  app.use(helmet(getHelmetOptions()));
  app.use(cors(getCorsOptions()));
  app.use(apiKeyAuth);
  // Rate-limit mutation endpoints (POST/DELETE) — 60 req/min
  app.use("/api/", rateLimit(getMutationRateLimitOptions()));
  app.use(express.json());

  app.get("/api/tasks", (_req, res) => {
    // Map "pending" → "todo" so React status types align
    const tasks = ATPDatabase.getAllTasks().map((t) => ({
      ...t,
      status: t.status === "pending" ? "todo" : t.status,
    }));
    res.json(tasks);
  });

  app.get("/api/employees", (_req, res) => {
    // Map DB field names → React-friendly names (agent_id→agent_key, designation→role)
    const employees = ATPDatabase.listEmployees().map((e) => {
      const rEntry = getRosterEntry(e.agent_id);
      return {
        employee_id: e.employee_id,
        name: e.name,
        role: e.designation,
        agent_key: e.agent_id,
        status: e.status,
        department: e.department,
        color: rEntry?.color ?? "",
        initials: rEntry?.initials ?? "",
      };
    });
    res.json(employees);
  });

  app.get("/api/events", (_req, res) => {
    res.json(EventLog.getEvents(30));
  });

  app.get("/api/queue", (_req, res) => {
    res.json(MessageQueue.peek());
  });

  app.get("/api/agent-messages", (_req, res) => {
    res.json(AgentMessageQueue.peekAll());
  });

  /** Snoop: peek a specific agent's inbox (PM inbox for "pm", agent queue for others). */
  app.get("/api/inbox/:agentId", (req, res) => {
    const id = req.params.agentId.toLowerCase();
    if (id === "pm") {
      res.json(MessageQueue.peek());
    } else {
      res.json(AgentMessageQueue.peekForAgent(id));
    }
  });

  app.get("/api/message-flow", (_req, res) => {
    try {
      const flowPath = join(config.dataDir, "message_flow.json");
      if (!existsSync(flowPath)) { res.json([]); return; }
      const raw = readFileSync(flowPath, "utf-8").trim();
      const data = raw ? JSON.parse(raw) : [];
      res.json(data.slice(-200));
    } catch {
      res.json([]);
    }
  });

  app.get("/api/errors", (_req, res) => {
    res.json(getErrors());
  });

  app.get("/api/interrupts", (_req, res) => {
    res.json(AgentInterrupt.getAll());
  });

  app.get("/api/chat-log", (_req, res) => {
    res.json(UserChatLog.getRecent(100));
  });

  app.post("/api/send-message", (req, res) => {
    const { to, message } = req.body ?? {};
    if (!to || typeof to !== "string" || !message || typeof message !== "string") {
      res.status(400).json({ error: "to and message are required strings" });
      return;
    }
    const agentKey = to.trim().toLowerCase();
    if (!AGENT_DISPLAY_NAMES[agentKey] || agentKey === "user") {
      res.status(400).json({ error: `Unknown agent: ${agentKey}` });
      return;
    }
    // Mark as dashboard-originated so all agent replies route to Dashboard (not Telegram)
    ActiveChannelState.set("dashboard");
    AgentMessageQueue.push("user", agentKey, "", message.trim(), "normal");
    UserChatLog.log({ from: "user", to: agentKey, message: message.trim(), channel: "dashboard" });
    res.json({ ok: true, to: agentKey });
  });

  app.post("/api/interrupt", (req, res) => {
    const { agent_id, reason } = req.body ?? {};
    if (!agent_id || typeof agent_id !== "string") {
      res.status(400).json({ error: "agent_id is required" });
      return;
    }
    const id = agent_id.trim().toLowerCase();
    const r = (reason as string | undefined) ?? "Interrupted via dashboard";
    // Native abort — stops LLM generation mid-stream
    agents.get(id)?.abort();
    // Flag fallback — caught at next tool boundary
    AgentInterrupt.request(id, r);
    res.json({ ok: true, agent_id: id, reason: r });
  });

  app.post("/api/steer", (req, res) => {
    const { agent_id, message } = req.body ?? {};
    if (!agent_id || typeof agent_id !== "string" || !message || typeof message !== "string") {
      res.status(400).json({ error: "agent_id and message are required strings" });
      return;
    }
    const id = agent_id.trim().toLowerCase();
    const agent = agents.get(id);
    if (!agent) {
      res.status(404).json({ error: `Unknown agent: ${id}` });
      return;
    }
    if (agent.steer) {
      // Inject message at next tool boundary (non-destructive)
      agent.steer(message.trim());
    } else {
      // Fallback: push to inbox so it's processed in the next poll
      AgentMessageQueue.push("user", id, "", message.trim(), "priority");
    }
    res.json({ ok: true, agent_id: id });
  });

  app.delete("/api/interrupt/:agentId", (req, res) => {
    AgentInterrupt.clear(req.params.agentId);
    res.json({ ok: true });
  });

  // ── Company: agent profiles + tool config ────────────────────────────────
  app.get("/api/company", (_req, res) => {
    const data = AGENT_PROFILES.map((profile) => ({
      agent_id: profile.agent_id,
      name: profile.name,
      role: profile.role,
      all_tools: profile.tools.map((t) => t.id),
      enabled_tools: getEnabledTools(profile.agent_id),
    }));
    res.json({ agents: data });
  });

  app.post("/api/agent-config", (req, res) => {
    const { agent_id, tools } = req.body ?? {};
    if (!agent_id || typeof agent_id !== "string" || !Array.isArray(tools)) {
      res.status(400).json({ error: "agent_id (string) and tools (string[]) are required" });
      return;
    }
    const id = agent_id.trim().toLowerCase();
    // Always re-add locked tools regardless of what the client sends
    const profile = AGENT_PROFILES.find((a) => a.agent_id === id);
    const lockedIds = profile?.tools.filter((t) => t.locked).map((t) => t.id) ?? [];
    const safeTools = [...new Set([...(tools as string[]), ...lockedIds])];
    setAgentTools(id, safeTools);
    res.json({ ok: true, agent_id: id, tools: safeTools });
  });

  // -- MCP config -----------------------------------------------------------------
  const mcpCfgPath = join(config.dataDir, "mcp-servers.json");

  app.get("/api/mcp-config", (_req, res) => {
    try {
      if (!existsSync(mcpCfgPath)) { res.json({ mcpServers: {} }); return; }
      res.json(JSON.parse(readFileSync(mcpCfgPath, "utf-8")));
    } catch { res.json({ mcpServers: {} }); }
  });

  app.post("/api/mcp-config", (req, res) => {
    try {
      const body = req.body;
      // Validate MCP config — prevent RCE via arbitrary command spawning
      const validation = validateMCPConfig(body);
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }
      writeFileSync(mcpCfgPath, JSON.stringify(body, null, 2), "utf-8");
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to save MCP config" });
    }
  });

  app.get("/api/mcp-status", (_req, res) => {
    try {
      const tools = getMCPTools();
      const sMap = new Map<string, string[]>();
      for (const t of tools) {
        const p = t.name.split("_");
        if (p.length >= 3 && p[0] === "mcp") {
          const s = p[1];
          if (!sMap.has(s)) sMap.set(s, []);
          sMap.get(s)!.push(p.slice(2).join("_"));
        }
      }
      const servers = Array.from(sMap.entries()).map(([name, tls]) => ({
        name, tools: tls, connected: true,
      }));
      res.json({ servers });
    } catch { res.json({ servers: [] }); }
  });

  // ── Agent Runtime: dynamic agent lifecycle management ─────────────────────
  app.get("/api/role-templates", (_req, res) => {
    const templates = getRoleTemplates();
    const result = Object.entries(templates).map(([id, t]) => ({
      id,
      role: t.role,
      department: t.department,
      category: t.category,
      mandatory: t.mandatory ?? false,
      default_skills: t.default_skills,
    }));
    res.json({ templates: result });
  });

  app.get("/api/agents/runtime", (_req, res) => {
    res.json({ agents: runtime.getStatus() });
  });

  app.post("/api/agents", (req, res) => {
    const { template, name, skills, color, initials, agent_id } = req.body ?? {};
    if (!template || typeof template !== "string") {
      res.status(400).json({ error: "template (string) is required" });
      return;
    }
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name (string) is required" });
      return;
    }
    try {
      const overrides: any = {};
      if (skills && Array.isArray(skills)) overrides.skills = skills;
      if (color && typeof color === "string") overrides.color = color;
      if (initials && typeof initials === "string") overrides.initials = initials;
      if (agent_id && typeof agent_id === "string") overrides.agent_id = agent_id;
      const entry = runtime.addAgent(template, name.trim(), Object.keys(overrides).length ? overrides : undefined);
      res.json({ ok: true, agent: entry });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  app.delete("/api/agents/:agentId", async (req, res) => {
    const id = req.params.agentId.trim().toLowerCase();
    try {
      await runtime.removeAgent(id);
      res.json({ ok: true, agent_id: id });
    } catch (err: any) {
      const status = err.message?.includes("mandatory") ? 403 : 400;
      res.status(status).json({ error: err.message ?? String(err) });
    }
  });

  app.post("/api/agents/:agentId/toggle", (req, res) => {
    const id = req.params.agentId.trim().toLowerCase();
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled (boolean) is required" });
      return;
    }
    try {
      const entry = runtime.toggleAgent(id, enabled);
      res.json({ ok: true, agent: entry });
    } catch (err: any) {
      const status = err.message?.includes("mandatory") ? 403 : 400;
      res.status(status).json({ error: err.message ?? String(err) });
    }
  });

  app.post("/api/agents/:agentId/pause", (req, res) => {
    const id = req.params.agentId.trim().toLowerCase();
    try {
      runtime.pauseAgent(id);
      res.json({ ok: true, agent_id: id, status: "paused" });
    } catch (err: any) {
      const status = err.message?.includes("mandatory") ? 403 : 400;
      res.status(status).json({ error: err.message ?? String(err) });
    }
  });

  app.post("/api/agents/:agentId/resume", (req, res) => {
    const id = req.params.agentId.trim().toLowerCase();
    try {
      runtime.resumeAgent(id);
      res.json({ ok: true, agent_id: id, status: "running" });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  // ── Settings: system config & integration status ─────────────────────────
  app.get("/api/settings", (_req, res) => {
    const tgToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const tgChatId = process.env.TELEGRAM_CHAT_ID ?? "";
    res.json({
      system: {
        companyName: config.companyName,
        workspace: config.workspace,
        dashboardPort: config.dashboardPort,
        cliEnabled: config.cliEnabled,
        debounceMs: config.debounceMs,
        contextWindow: config.contextWindow,
        compactThreshold: config.compactThreshold,
      },
      llm: {
        provider: config.modelProvider,
        model: config.model,
        thinkingLevel: config.thinkingLevel,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      },
      proactive: {
        enabled: config.pmProactiveEnabled,
        intervalSecs: config.pmProactiveIntervalSecs,
      },
      integrations: {
        telegram: {
          configured: !!(tgToken && tgChatId),
          chatId: tgChatId ? `${tgChatId.slice(0, 4)}...` : "",
        },
        searxng: {
          configured: !!config.searxngUrl,
          url: config.searxngUrl,
        },
        sonarqube: {
          configured: !!config.sonarToken,
          hostUrl: config.sonarHostUrl,
          projectKey: config.sonarProjectBaseKey,
        },
        gitleaks: { configured: true },
        semgrep: { configured: true },
        trivy: { configured: true },
      },
    });
  });

  // ── Model Config: per-agent model overrides + provider priority ────────
  app.get("/api/model-config", (_req, res) => {
    res.json({
      providers: getProviders(),
      config: getModelConfig(),
    });
  });

  app.post("/api/model-config", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    try {
      setModelConfig(body);
      res.json({ ok: true, config: getModelConfig() });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Failed to save model config" });
    }
  });

  app.post("/api/agent-model", (req, res) => {
    const { agent_id, provider, model } = req.body ?? {};
    if (!agent_id || typeof agent_id !== "string") {
      res.status(400).json({ error: "agent_id is required" });
      return;
    }
    if (provider && model) {
      setAgentModel(agent_id, { provider, model });
    } else {
      setAgentModel(agent_id, null); // clear override
    }
    res.json({ ok: true, effective: getEffectiveModel(agent_id) });
  });

  // ── Finance: token usage & cost tracking ────────────────────────────────
  app.get("/api/finance", (_req, res) => {
    res.json({ totals: getFinanceTotals(), agents: getFinanceAllUsage() });
  });
  app.post("/api/finance/reset", (_req, res) => {
    resetFinanceUsage();
    res.json({ ok: true });
  });

  // â"€â"€ SSE: real-time agent streaming â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // Prevent Windows TCP stack from resetting idle SSE connections
    const socket = (req.socket as any);
    if (socket?.setKeepAlive) socket.setKeepAlive(true, 10_000);
    if (socket?.setNoDelay) socket.setNoDelay(true);
    res.flushHeaders();

    // Heartbeat every 10 s — keeps connection alive through proxies and Windows TCP
    const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore write-after-close */ } }, 10_000);

    // Replay recent events so reconnecting clients catch up on what they missed.
    // Use setImmediate so headers are flushed before we start writing data.
    setImmediate(() => {
      try {
        for (const tok of getReplayBuffer()) {
          res.write(`data: ${JSON.stringify(tok)}\n\n`);
        }
      } catch { /* client disconnected before replay finished */ }
    });

    const onToken = (tok: StreamToken) => {
      try { res.write(`data: ${JSON.stringify(tok)}\n\n`); } catch { /* ignore write-after-close */ }
    };

    agentStreamBus.on("token", onToken);
    req.on("close", () => {
      agentStreamBus.off("token", onToken);
      clearInterval(heartbeat);
    });
  });

  // Serve React build if available, otherwise fall back to inline HTML
  if (existsSync(REACT_DIST)) {
    app.use(express.static(REACT_DIST));
    // SPA fallback — all non-API routes serve index.html
    app.get(/^(?!\/api).*$/, (_req, res) => {
      res.sendFile(join(REACT_DIST, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(getDashboardHtml());
    });
  }

  // ── Bind to localhost only (secure default) ───────────────────────────
  const host = getDashboardHost();
  const server = app.listen(port, host, () => {
    const apiKey = getDashboardApiKey();
    console.log(`  Dashboard: http://${host}:${port}?key=${apiKey}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[Dashboard] Port ${port} already in use — dashboard unavailable. Kill the other process or set VEC_DASHBOARD_PORT.`);
    } else {
      console.error("[Dashboard] Server error:", err.message);
    }
  });
}



