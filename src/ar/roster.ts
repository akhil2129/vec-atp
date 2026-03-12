/**
 * AR Department — Roster loader.
 * Single source of truth for all agent definitions, loaded from data/roster.json.
 * Supports role templates for dynamic agent instance creation.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RoleTemplate {
  role: string;
  designation: string;
  department: string;
  category: "pm" | "specialist";
  hierarchy_level: number;
  reports_to: string;
  tool_profile: "coding" | "coding_extended" | "scoped_write" | "ba" | "pm";
  capabilities: { git?: boolean; glob?: boolean; bash?: boolean };
  domain_tools: string[];
  prompt_file: string;
  default_skills: string[];
  /** If true, this role cannot be removed or disabled. */
  mandatory?: boolean;
}

export interface RosterEntry {
  agent_id: string;
  employee_id: string;
  name: string;
  template: string;
  role: string;
  designation: string;
  department: string;
  category: "pm" | "specialist";
  hierarchy_level: number;
  reports_to: string;
  skills: string[];
  tool_profile: "coding" | "coding_extended" | "scoped_write" | "ba" | "pm";
  capabilities: {
    git?: boolean;
    glob?: boolean;
    bash?: boolean;
  };
  domain_tools: string[];
  prompt_file: string;
  color: string;
  initials: string;
  enabled: boolean;
}

export interface Roster {
  meta: { version: string; company: string };
  role_templates: Record<string, RoleTemplate>;
  agents: RosterEntry[];
}

// ── Loader ────────────────────────────────────────────────────────────────────

// Lazy — avoids circular-import TDZ (config.ts ↔ roster.ts).
let _rosterPath: string | null = null;
function getRosterPath(): string {
  return (_rosterPath ??= join(PROJECT_ROOT, "data", "roster.json"));
}
let _cached: Roster | null = null;

export function loadRoster(): Roster {
  if (_cached) return _cached;
  const raw = readFileSync(getRosterPath(), "utf-8");
  const roster = JSON.parse(raw) as Roster;

  // Validate: every agent must have an employee_id
  for (const entry of roster.agents) {
    if (!entry.employee_id) {
      throw new Error(
        `roster.json: agent '${entry.agent_id}' is missing employee_id. ` +
        `Add an explicit EMP-NNN value.`
      );
    }
    if (!entry.agent_id) {
      throw new Error(`roster.json: found entry with missing agent_id.`);
    }
  }

  // Validate: no duplicate agent_ids or employee_ids
  const seenIds = new Set<string>();
  const seenEmpIds = new Set<string>();
  for (const entry of roster.agents) {
    if (seenIds.has(entry.agent_id)) {
      throw new Error(`roster.json: duplicate agent_id '${entry.agent_id}'.`);
    }
    if (seenEmpIds.has(entry.employee_id)) {
      throw new Error(`roster.json: duplicate employee_id '${entry.employee_id}'.`);
    }
    seenIds.add(entry.agent_id);
    seenEmpIds.add(entry.employee_id);
  }

  _cached = roster;
  return _cached;
}

/** Force reload on next access (useful for tests or hot-reload). */
export function clearRosterCache(): void {
  _cached = null;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** All enabled non-PM agents. */
export function getSpecialistEntries(): RosterEntry[] {
  return loadRoster().agents.filter(
    (a) => a.enabled && a.category === "specialist"
  );
}

/** The PM entry (first enabled PM). */
export function getPMEntry(): RosterEntry {
  const pm = loadRoster().agents.find((a) => a.category === "pm" && a.enabled);
  if (!pm) throw new Error("roster.json: no enabled PM entry found.");
  return pm;
}

/** Lookup a single entry by agent_id. */
export function getRosterEntry(agentId: string): RosterEntry | undefined {
  return loadRoster().agents.find((a) => a.agent_id === agentId);
}

/** All enabled agent IDs (PM + specialists). */
export function getAllAgentIds(): string[] {
  return loadRoster().agents.filter((a) => a.enabled).map((a) => a.agent_id);
}

/** All enabled specialist agent IDs (excluding PM). */
export function getSpecialistAgentIds(): string[] {
  return getSpecialistEntries().map((a) => a.agent_id);
}

/**
 * Resolve an agent key to its employee ID.
 * Replacement for the old agentIds.ts getEmployeeId().
 */
export function getEmployeeId(agentId: string): string {
  const entry = getRosterEntry(agentId);
  return entry?.employee_id ?? agentId;
}

// ── Role Templates ────────────────────────────────────────────────────────────

/** Get all role template definitions. */
export function getRoleTemplates(): Record<string, RoleTemplate> {
  return loadRoster().role_templates ?? {};
}

/** Get a single role template by ID. */
export function getRoleTemplate(templateId: string): RoleTemplate | undefined {
  return getRoleTemplates()[templateId];
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

/** Persist the current roster to disk. */
export function saveRoster(roster: Roster): void {
  writeFileSync(getRosterPath(), JSON.stringify(roster, null, 2) + "\n", "utf-8");
  _cached = null; // invalidate cache so next load picks up changes
}

/** Randomly pick a pleasing hex color for a new agent. */
const PALETTE = [
  "#3fb950", "#1158c7", "#7928ca", "#e36209", "#0891b2",
  "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4",
  "#10b981", "#f97316", "#6366f1", "#14b8a6", "#d946ef",
];

function pickColor(existing: string[]): string {
  const used = new Set(existing);
  const available = PALETTE.filter((c) => !used.has(c));
  if (available.length > 0) return available[Math.floor(Math.random() * available.length)];
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

/** Get the next available EMP-NNN id. */
function nextEmployeeId(agents: RosterEntry[]): string {
  let max = 0;
  for (const a of agents) {
    const n = parseInt(a.employee_id.split("-")[1], 10);
    if (n > max) max = n;
  }
  return `EMP-${String(max + 1).padStart(3, "0")}`;
}

/** Generate a unique agent_id from template + existing IDs. */
function generateAgentId(templateId: string, agents: RosterEntry[]): string {
  const existing = new Set(agents.map((a) => a.agent_id));
  // First agent of this template uses the templateId directly (or a short alias)
  const base = templateId === "developer" ? "dev" : templateId;
  if (!existing.has(base)) return base;
  // Subsequent instances: dev2, dev3, ...
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Could not generate unique agent_id for template '${templateId}'`);
}

/**
 * Add a new agent instance from a role template.
 * Returns the new RosterEntry (already persisted to disk).
 */
export function addAgentToRoster(
  templateId: string,
  name: string,
  overrides?: Partial<Pick<RosterEntry, "skills" | "color" | "initials" | "agent_id">>
): RosterEntry {
  const roster = loadRoster();
  const template = roster.role_templates?.[templateId];
  if (!template) throw new Error(`Unknown role template: '${templateId}'`);

  if (template.mandatory) {
    // Check if a PM already exists
    const existingPM = roster.agents.find((a) => a.template === templateId && a.enabled);
    if (existingPM) throw new Error(`Role '${templateId}' is mandatory and already has an active instance.`);
  }

  const agentId = overrides?.agent_id ?? generateAgentId(templateId, roster.agents);
  const employeeId = nextEmployeeId(roster.agents);
  const initials = overrides?.initials ?? name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
  const color = overrides?.color ?? pickColor(roster.agents.map((a) => a.color));

  const entry: RosterEntry = {
    agent_id: agentId,
    employee_id: employeeId,
    name,
    template: templateId,
    role: template.role,
    designation: template.designation,
    department: template.department,
    category: template.category,
    hierarchy_level: template.hierarchy_level,
    reports_to: template.reports_to,
    skills: overrides?.skills ?? [...template.default_skills],
    tool_profile: template.tool_profile,
    capabilities: { ...template.capabilities },
    domain_tools: [...template.domain_tools],
    prompt_file: template.prompt_file,
    color,
    initials,
    enabled: true,
  };

  // Validate uniqueness
  if (roster.agents.some((a) => a.agent_id === agentId)) {
    throw new Error(`Agent ID '${agentId}' already exists.`);
  }

  roster.agents.push(entry);
  saveRoster(roster);
  return entry;
}

/**
 * Remove an agent instance from the roster.
 * Throws if trying to remove a mandatory role (PM).
 */
export function removeAgentFromRoster(agentId: string): RosterEntry {
  const roster = loadRoster();
  const idx = roster.agents.findIndex((a) => a.agent_id === agentId);
  if (idx === -1) throw new Error(`Agent '${agentId}' not found in roster.`);

  const entry = roster.agents[idx];
  const template = roster.role_templates?.[entry.template];
  if (template?.mandatory) {
    throw new Error(`Cannot remove agent '${agentId}' — role '${entry.template}' is mandatory.`);
  }

  roster.agents.splice(idx, 1);
  saveRoster(roster);
  return entry;
}

/**
 * Toggle an agent's enabled state.
 * Throws if trying to disable a mandatory role (PM).
 */
export function toggleAgentInRoster(agentId: string, enabled: boolean): RosterEntry {
  const roster = loadRoster();
  const entry = roster.agents.find((a) => a.agent_id === agentId);
  if (!entry) throw new Error(`Agent '${agentId}' not found in roster.`);

  if (!enabled) {
    const template = roster.role_templates?.[entry.template];
    if (template?.mandatory) {
      throw new Error(`Cannot disable agent '${agentId}' — role '${entry.template}' is mandatory.`);
    }
  }

  entry.enabled = enabled;
  saveRoster(roster);
  return entry;
}
