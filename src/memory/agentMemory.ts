/**
 * Persistent memory loader for VEC agents.
 *
 * Auto-loads an agent's persistent memory into prompt context:
 *   - SLTM (sltm.md)              → permanent identity/knowledge, always loaded
 *   - Yesterday's LTM journal      → loaded if it exists
 *   - Today's LTM journal          → loaded if it exists
 *
 * No vector search — plain markdown, grep-searchable, human-readable.
 * Returns a formatted block ready to prepend to any agent prompt.
 */

import fs from "fs";
import path from "path";
import { config } from "../config.js";

function agentDir(agentId: string): string {
  return path.join(config.memoryDir, agentId);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function readIfExists(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    const content = fs.readFileSync(filePath, "utf-8").trim();
    // Skip empty or header-only files
    return content.split("\n").filter((l) => l.trim()).length > 3 ? content : "";
  } catch {
    return "";
  }
}

/**
 * Returns true if the agent has no meaningful SLTM — i.e. this is their first real interaction.
 */
export function isFirstInteraction(agentId: string): boolean {
  const markerFile = path.join(agentDir(agentId), ".first_contact_done");
  return !fs.existsSync(markerFile);
}

/**
 * Mark the first interaction as done — call this immediately when first contact is detected.
 * Creates a simple marker file so subsequent calls to isFirstInteraction() return false.
 */
export function markFirstInteractionDone(agentId: string): void {
  const dir = agentDir(agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".first_contact_done"),
    new Date().toISOString(),
    "utf-8"
  );
}

/**
 * Load an agent's memory context (SLTM + last 2 LTM daily logs).
 * Returns a formatted string to prepend to the agent's prompt.
 * Returns empty string if no memory exists yet.
 */
export function loadAgentMemory(agentId: string): string {
  const dir = agentDir(agentId);
  const ltmDir = path.join(dir, "ltm");

  const sltm = readIfExists(path.join(dir, "sltm.md"));
  const yestLtm = readIfExists(path.join(ltmDir, `${yesterday()}_memory.md`));
  const todayLtm = readIfExists(path.join(ltmDir, `${today()}_memory.md`));

  const sections: string[] = [];
  if (sltm) sections.push(`### Permanent Memory\n${sltm}`);
  if (yestLtm) sections.push(`### Yesterday (${yesterday()})\n${yestLtm}`);
  if (todayLtm) sections.push(`### Today (${today()})\n${todayLtm}`);

  if (!sections.length) return "";

  return (
    `[MEMORY — loaded from your memory files]\n` +
    sections.join("\n\n") +
    `\n[END MEMORY]\n`
  );
}

/**
 * Grep-style search across all of an agent's memory files.
 * Returns matching lines with file context.
 */
export function searchAgentMemory(agentId: string, query: string): string {
  const dir = agentDir(agentId);
  const ltmDir = path.join(dir, "ltm");
  const results: string[] = [];
  const lq = query.toLowerCase();

  function searchFile(filePath: string, label: string): void {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const hits = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.toLowerCase().includes(lq));
    for (const { line, i } of hits) {
      results.push(`[${label}:${i + 1}] ${line.trim()}`);
    }
  }

  searchFile(path.join(dir, "sltm.md"), "permanent");
  searchFile(path.join(dir, "stm.md"), "today-stm");

  if (fs.existsSync(ltmDir)) {
    const files = fs
      .readdirSync(ltmDir)
      .filter((f) => f.endsWith("_memory.md"))
      .sort()
      .reverse()
      .slice(0, 14); // last 2 weeks
    for (const f of files) {
      const date = f.replace("_memory.md", "");
      searchFile(path.join(ltmDir, f), date);
    }
  }

  if (!results.length) return `No memory entries found for: "${query}"`;
  return `Memory search — "${query}" (${results.length} hit${results.length === 1 ? "" : "s"}):\n${results.join("\n")}`;
}
