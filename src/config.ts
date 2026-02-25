import "dotenv/config";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..");
const thinkingLevelRaw = (process.env.VEC_THINKING_LEVEL ?? "off").trim().toLowerCase();
const thinkingLevel: ThinkingLevel =
  thinkingLevelRaw === "minimal" ||
  thinkingLevelRaw === "low" ||
  thinkingLevelRaw === "medium" ||
  thinkingLevelRaw === "high" ||
  thinkingLevelRaw === "xhigh"
    ? thinkingLevelRaw
    : "off";
const debugLlm = !["0", "false", "no"].includes(
  (process.env.VEC_DEBUG_LLM ?? "0").trim().toLowerCase()
);
const debugLlmStallSecs = Math.max(
  5,
  parseInt(process.env.VEC_DEBUG_LLM_STALL_SECS ?? "20", 10)
);

export const config = {
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  modelProvider: (process.env.VEC_MODEL_PROVIDER ?? "groq") as string,
  model: (process.env.VEC_MODEL ?? process.env.GROQ_MODEL ?? "moonshotai/kimi-k2-instruct-0905") as string,
  thinkingLevel,
  debugLlm,
  debugLlmStallSecs,
  temperature: parseFloat(process.env.GROQ_TEMPERATURE ?? "0.7"),
  maxTokens: parseInt(process.env.GROQ_MAX_TOKENS ?? "16384", 10),

  companyName: process.env.COMPANY_NAME ?? "VEC",
  workspace: process.env.VEC_WORKSPACE
    ? process.env.VEC_WORKSPACE
    : join(PROJECT_ROOT, "workspace"),
  pmProactiveEnabled:
    !["0", "false", "no"].includes(
      (process.env.VEC_PM_PROACTIVE_ENABLED ?? "0").trim().toLowerCase()
    ),
  /** How often the PM proactive loop runs (seconds). Default 30. Set via VEC_PM_PROACTIVE_INTERVAL_SECS. */
  pmProactiveIntervalSecs: Math.max(
    10,
    parseInt(process.env.VEC_PM_PROACTIVE_INTERVAL_SECS ?? "30", 10)
  ),

  dataDir: join(PROJECT_ROOT, "data"),
  memoryDir: join(PROJECT_ROOT, "memory"),
  dashboardPort: parseInt(process.env.VEC_DASHBOARD_PORT ?? "3000", 10),
  /**
   * Inbound message debounce window (ms). Rapid messages within this window
   * are batched into a single agent turn. Set VEC_DEBOUNCE_MS=0 to disable.
   * Default: 1500ms.
   */
  debounceMs: parseInt(process.env.VEC_DEBOUNCE_MS ?? "1500", 10),

  // ── Auto-compaction ────────────────────────────────────────────────────────
  /**
   * Model context window in tokens. Used to detect threshold. Default: 128 000.
   * Override via VEC_CONTEXT_WINDOW if using a model with a different limit.
   */
  contextWindow: parseInt(process.env.VEC_CONTEXT_WINDOW ?? "128000", 10),
  /**
   * Compact when estimated token usage exceeds this fraction of the usable window.
   * Usable = contextWindow - reserveTokens. Default: 0.75.
   */
  compactThreshold: parseFloat(process.env.VEC_COMPACT_THRESHOLD ?? "0.75"),
  /**
   * Messages to always keep at the tail of history after compaction. Default: 20.
   */
  compactKeepRecent: parseInt(process.env.VEC_COMPACT_KEEP_RECENT ?? "20", 10),
  /** Set VEC_CLI_ENABLED=0 to run headless (dashboard + Telegram only, no readline loop). */
  cliEnabled: !["0", "false", "no"].includes(
    (process.env.VEC_CLI_ENABLED ?? "1").trim().toLowerCase()
  ),
};

/** Shared workspace — all agents can read/write cross-agent deliverables here. */
export const sharedWorkspace = join(config.workspace, "shared");

/** Projects folder — standalone software projects built by agents live here. */
export const projectsWorkspace = join(config.workspace, "projects");

/** Per-agent private workspace — agent's own drafts, scratch files, temp outputs. */
export function agentWorkspace(agentId: string): string {
  return join(config.workspace, "agents", agentId);
}

/** All workspace directories that must exist at startup. */
export const WORKSPACE_DIRS = [
  config.workspace,
  sharedWorkspace,
  projectsWorkspace,
  // specialist agent folders
  ...["ba", "dev", "qa", "security", "devops", "techwriter", "architect", "researcher"].map(agentWorkspace),
];
