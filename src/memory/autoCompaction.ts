/**
 * Auto-compaction — keeps agent conversation history under the model's context window.
 *
 * Strategy:
 *  - Overflow recovery:  if a prompt throws a context-length error, compact then retry.
 *  - Threshold maintenance: after each successful turn, if estimated token usage
 *    exceeds `thresholdRatio * (contextWindow - reserveTokens)`, compact proactively.
 *  - Pre-compaction flush: before threshold compaction, send the agent a flush prompt
 *    so it can persist important context to LTM/SLTM before old messages vanish.
 *    (Skipped for overflow compaction — context is already too full for another turn.)
 *  - Compaction: LLM-summarise older messages into a [COMPACTION SUMMARY] block;
 *    keep the most recent `keepRecentCount` messages intact.
 *  - Fallback: if LLM summarisation fails, use a plain-text excerpt.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { EventLog } from "../atp/eventLog.js";
import { EventType } from "../atp/models.js";

// ── defaults ──────────────────────────────────────────────────────────────────
// These are fallback values used when CompactorOptions fields are not set.
// The actual defaults are driven by config (VEC_CONTEXT_WINDOW, VEC_COMPACT_THRESHOLD, etc.).
const DEFAULT_RESERVE = 8_000; // tokens reserved for system prompt + response headroom

/** Rough token estimate: 1 token ≈ 4 characters. */
function estimateTokens(messages: any[]): number {
  return JSON.stringify(messages).length / 4;
}

function isContextOverflow(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context length") ||
    msg.includes("too many tokens") ||
    msg.includes("context window") ||
    msg.includes("tokens exceed") ||
    msg.includes("reduce your prompt") ||
    msg.includes("prompt is too long") ||
    msg.includes("input is too long")
  );
}

// ── options ───────────────────────────────────────────────────────────────────
export interface CompactorOptions {
  agentId: string;
  /** Messages to always preserve at the tail (default: 20). */
  keepRecentCount?: number;
  /** Compact when token usage exceeds this fraction of the usable window (default: 0.75). */
  thresholdRatio?: number;
  /** Total context window size in tokens (default: 128 000). */
  contextWindow?: number;
  /** Tokens reserved for system prompt + response headroom (default: 8 000). */
  reserveTokens?: number;
  /**
   * If true, before a threshold-triggered compaction the agent is prompted to flush
   * important context into LTM/SLTM. Skipped on overflow (context too full).
   * Default: true.
   */
  enablePreFlush?: boolean;
}

// ── AutoCompactor ─────────────────────────────────────────────────────────────
export class AutoCompactor {
  compactionCount = 0;

  constructor(private agent: Agent, private opts: CompactorOptions) {}

  /**
   * Run `promptFn` with overflow recovery + threshold compaction.
   * Pass any callable that advances the agent (prompt / continue / followUp+continue).
   */
  async run(promptFn: () => Promise<void>): Promise<void> {
    try {
      await promptFn();
      await this._thresholdCheck();
    } catch (err) {
      if (isContextOverflow(err)) {
        const label = `🧹 [${this.opts.agentId}] Context overflow — emergency compaction`;
        console.warn(`[VEC] ${label}`);
        EventLog.log(EventType.AGENT_THINKING, this.opts.agentId, "", label);
        await this._compact("overflow", /* preFlush = */ false);
        await promptFn(); // retry once after compaction
        await this._thresholdCheck();
      } else {
        throw err;
      }
    }
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private async _thresholdCheck(): Promise<void> {
    const messages = this.agent.state.messages as any[];
    const tokens = estimateTokens(messages);
    const windowSize = this.opts.contextWindow ?? config.contextWindow;
    const reserve = this.opts.reserveTokens ?? DEFAULT_RESERVE;
    const usable = windowSize - reserve;
    const threshold = usable * (this.opts.thresholdRatio ?? config.compactThreshold);

    if (tokens > threshold) {
      const pct = Math.round((tokens / usable) * 100);
      const label = `🧹 [${this.opts.agentId}] Context at ~${pct}% of usable window — threshold compaction`;
      console.log(`[VEC] ${label}`);
      EventLog.log(EventType.AGENT_THINKING, this.opts.agentId, "", label);
      await this._compact("threshold", this.opts.enablePreFlush ?? true);
    }
  }

  private async _compact(reason: string, preFlush: boolean): Promise<void> {
    // Pre-flush: let the agent save durable notes to LTM/SLTM before old messages vanish.
    // Only on threshold (not overflow — context is already full, no room for another turn).
    if (preFlush) {
      try {
        await this.agent.prompt(
          "CONTEXT MANAGEMENT — PRE-COMPACTION FLUSH\n\n" +
          "Your conversation history is approaching the context window limit and will be " +
          "compacted shortly. Older messages will be summarised and replaced.\n\n" +
          "Use your memory tools NOW (write_ltm, append_ltm, write_stm, write_sltm) to save " +
          "anything important before the old messages are removed:\n" +
          "  - Current task status and any task IDs in progress\n" +
          "  - Key decisions or instructions from Sir\n" +
          "  - File locations or content produced so far\n" +
          "  - Any pending follow-ups\n\n" +
          "Call your memory tools. When done, respond with exactly: FLUSH_COMPLETE"
        );
      } catch (e) {
        console.warn(
          `[VEC] 🧹 [${this.opts.agentId}] Pre-flush prompt failed (${e}) — proceeding with compaction.`
        );
      }
    }

    // After pre-flush (if any), read the updated full message list.
    const messages = this.agent.state.messages as any[];
    const keepCount = this.opts.keepRecentCount ?? config.compactKeepRecent;

    if (messages.length <= keepCount) return; // nothing to compact

    const toSummarize = messages.slice(0, messages.length - keepCount);
    const recent = messages.slice(messages.length - keepCount);

    // LLM summarisation (with plain-text fallback).
    const summary = await summarizeMessages(toSummarize);

    const summaryMsg: any = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `[COMPACTION SUMMARY #${this.compactionCount + 1}` +
            ` — ${new Date().toISOString().slice(0, 10)}` +
            ` — reason: ${reason}]\n\n` +
            `${summary}\n\n` +
            `[End of compacted history. ${toSummarize.length} older messages replaced by this summary.]`,
        },
      ],
      timestamp: Date.now(),
    };

    this.agent.replaceMessages([summaryMsg, ...recent]);
    this.compactionCount++;

    const done =
      `🧹 [${this.opts.agentId}] Compaction #${this.compactionCount} complete` +
      ` (${reason}): ${toSummarize.length} msgs → 1 summary`;
    console.log(`[VEC] ${done}`);
    EventLog.log(EventType.AGENT_THINKING, this.opts.agentId, "", done);
  }
}

// ── LLM summarisation ─────────────────────────────────────────────────────────

async function summarizeMessages(messages: any[]): Promise<string> {
  try {
    // Build a readable transcript, truncating large tool results to keep the
    // summarisation prompt itself from overflowing.
    const lines: string[] = [];
    for (const m of messages) {
      if (!m?.content) continue;
      const role = m.role === "assistant" ? "Assistant" : "User";
      const parts: any[] = Array.isArray(m.content)
        ? m.content
        : [{ type: "text", text: String(m.content) }];

      for (const part of parts) {
        if (part.type === "text" && part.text) {
          lines.push(`${role}: ${part.text.slice(0, 600)}`);
        } else if (part.type === "tool_use") {
          const input = JSON.stringify(part.input ?? {}).slice(0, 300);
          lines.push(`[Tool call: ${part.name}(${input})]`);
        } else if (part.type === "tool_result") {
          const resultText = Array.isArray(part.content)
            ? part.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join(" ")
            : String(part.content ?? "");
          lines.push(`[Tool result: ${resultText.slice(0, 400)}]`);
        }
      }
    }

    const transcript = lines.join("\n\n");

    // Throwaway agent — single summarisation turn, no tools, no persistent state.
    const summarizer = new Agent({
      initialState: {
        systemPrompt: "You are a precise conversation summariser for AI agent context management.",
        model: getModel(config.modelProvider as any, config.model as any),
        thinkingLevel: "off" as any,
        tools: [],
        messages: [],
      },
    });

    await summarizer.prompt(
      "Summarise the following AI agent conversation history for context window compaction.\n" +
      "Preserve: task IDs and statuses, key decisions, file paths and content produced, " +
      "agent assignments, code snippets or specs, important blockers or follow-ups.\n" +
      "Be dense but complete — this summary replaces the full history in the agent's context.\n\n" +
      "CONVERSATION:\n" +
      transcript
    );

    const last = [...summarizer.state.messages]
      .reverse()
      .find((m: any) => m.role === "assistant") as any;

    if (last?.content) {
      const text = Array.isArray(last.content)
        ? last.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("")
        : String(last.content);
      if (text.trim()) return text.trim();
    }
  } catch (e) {
    console.warn(`[VEC] 🧹 Summarisation LLM call failed (${e}) — using plain excerpt.`);
  }

  // Fallback: plain-text excerpt (no LLM required).
  return messages
    .map((m: any, i) => {
      const role = m?.role === "assistant" ? "A" : "U";
      const parts: any[] = Array.isArray(m?.content)
        ? m.content
        : [{ type: "text", text: String(m?.content ?? "") }];
      const text = parts
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join(" ")
        .slice(0, 250);
      return `[${i}:${role}] ${text}`;
    })
    .join("\n");
}
