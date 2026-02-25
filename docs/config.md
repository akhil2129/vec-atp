# Configuration

All configuration lives in `src/config.ts`, loaded from environment variables via `dotenv`.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values.

### LLM Provider

| Variable | Default | Description |
|---|---|---|
| `VEC_MODEL_PROVIDER` | `groq` | LLM provider: `groq` or `openai` |
| `VEC_MODEL` | _(required)_ | Model name (e.g. `moonshotai/kimi-k2-instruct-0905`) |
| `GROQ_API_KEY` | _(required if groq)_ | Your Groq API key |
| `OPENAI_API_KEY` | _(required if openai)_ | Your OpenAI API key |
| `GROQ_TEMPERATURE` | `0.7` | LLM creativity (0.0–1.0) |
| `GROQ_MAX_TOKENS` | `16384` | Max response tokens |
| `VEC_THINKING_LEVEL` | `off` | Extended thinking: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |

### Debug

| Variable | Default | Description |
|---|---|---|
| `VEC_DEBUG_LLM` | `0` | Enable LLM stall detection (`1` = on) |
| `VEC_DEBUG_LLM_STALL_SECS` | `20` | Seconds of silence before stall warning |

### Company

| Variable | Default | Description |
|---|---|---|
| `COMPANY_NAME` | `VEC` | Organization name shown in agent prompts |
| `VEC_WORKSPACE` | `<project>/workspace` | Root path for all agent file work |

### System Behavior

| Variable | Default | Description |
|---|---|---|
| `VEC_PM_PROACTIVE_ENABLED` | `0` | Enable PM's proactive event loop (`1` = on) |
| `VEC_PM_PROACTIVE_INTERVAL_SECS` | `60` | How often PM checks events (min: 10s) |
| `VEC_DASHBOARD_PORT` | `3000` | HTTP dashboard port |
| `VEC_CLI_ENABLED` | `1` | Enable CLI readline loop (`0` = headless mode) |
| `VEC_DEBOUNCE_MS` | `1500` | Inbound message debounce window in ms. Rapid messages within this window are batched into one agent turn. Set to `0` to disable. |
| `VEC_CONTEXT_WINDOW` | `128000` | Model context window in tokens. Used by AutoCompactor to calculate the threshold. Override if using a model with a different limit. |
| `VEC_COMPACT_THRESHOLD` | `0.75` | Compact when estimated token usage exceeds this fraction of the usable window (contextWindow − 8000 reserve). |
| `VEC_COMPACT_KEEP_RECENT` | `20` | Number of recent messages to always preserve intact during compaction. |

### Telegram (Optional)

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Authorized chat ID (positive = private, negative = group) |

---

## Config Object (`src/config.ts`)

The config is exported as a single object:

```typescript
export const config = {
  groqApiKey: string,
  modelProvider: string,       // "groq" | "openai"
  model: string,
  thinkingLevel: string,       // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  debugLlm: boolean,
  debugLlmStallSecs: number,
  temperature: number,
  maxTokens: number,
  companyName: string,
  workspace: string,           // Full path to VEC_WORKSPACE
  pmProactiveEnabled: boolean,
  pmProactiveIntervalSecs: number,
  dataDir: string,             // <project>/data
  memoryDir: string,           // <project>/memory
  dashboardPort: number,
  cliEnabled: boolean,
  debounceMs: number,
  contextWindow: number,       // VEC_CONTEXT_WINDOW
  compactThreshold: number,    // VEC_COMPACT_THRESHOLD
  compactKeepRecent: number,   // VEC_COMPACT_KEEP_RECENT
  telegramBotToken?: string,
  telegramChatId?: string,
};
```

### Workspace Path Helpers

```typescript
sharedWorkspace(): string
// → <VEC_WORKSPACE>/shared

projectsWorkspace(): string
// → <VEC_WORKSPACE>/projects

agentWorkspace(agentId: string): string
// → <VEC_WORKSPACE>/agents/<agentId>
```

---

## Workspace Layout

All file work by agents happens inside the workspace. The workspace is separate from the project source code.

```
<VEC_WORKSPACE>/           (default: <project>/workspace)
├── shared/                ← deliverables visible to all agents and PM
├── projects/              ← standalone apps built by Dev
└── agents/
    ├── pm/                ← PM private scratch
    ├── dev/               ← Dev private scratch
    ├── ba/                ← BA private scratch
    ├── qa/                ← QA private scratch (when added)
    └── ...
```

**Rule:** Agents should never write deliverables to their private agent folder — shared outputs go to `workspace/shared/`.

---

## Data Directory Layout

Internal system data lives in `<project>/data/`.

```
data/
├── vec_atp.db             ← SQLite: tasks + employees
├── pm_queue.json          ← PM message queue
├── agent_messages.json    ← Agent-to-agent queue
├── events.json            ← Event log (max 200)
├── chat-log.json          ← Chat history (max 200)
└── agent-history/
    ├── pm.json            ← PM conversation history
    ├── dev.json
    └── ba.json
```

---

## Memory Directory Layout

Agent memory files live in `<project>/memory/`.

```
memory/
├── pm/
│   ├── sltm.md
│   ├── stm.md
│   ├── .first_contact_done
│   └── ltm/
│       └── YYYY-MM-DD_memory.md
├── dev/
│   └── ...
└── ba/
    └── ...
```

---

## Founder Identity (`src/identity.ts`)

The system reads founder identity from `ITS_ME.md` in the project root:

```markdown
# ITS_ME.md
Name: Akhil
Role: Founder & CEO
AgentKey: user
```

If the file doesn't exist, defaults are used:
- Name: `Akhil`
- Role: `Founder & CEO`
- AgentKey: `user`

The founder identity is injected into agent system prompts so agents know who they report to.

---

## Recommended Model Configurations

### Fast / Low Cost
```env
VEC_MODEL_PROVIDER=groq
VEC_MODEL=llama-3.3-70b-versatile
GROQ_MAX_TOKENS=8192
```

### High Quality
```env
VEC_MODEL_PROVIDER=groq
VEC_MODEL=moonshotai/kimi-k2-instruct-0905
GROQ_MAX_TOKENS=16384
VEC_THINKING_LEVEL=minimal
```

### OpenAI
```env
VEC_MODEL_PROVIDER=openai
VEC_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
```
