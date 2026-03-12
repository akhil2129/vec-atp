/**
 * AR Department — Agent registry builder.
 * Reads roster.json and creates BaseSpecialistAgent instances for all enabled specialists.
 */

import type { VECAgent } from "../atp/inboxLoop.js";
import { getSpecialistEntries } from "./roster.js";
import { BaseSpecialistAgent } from "./baseSpecialist.js";
import type { SpecialistDeps } from "./baseSpecialist.js";

/**
 * Build the specialist agent registry from roster.json.
 * Returns a Map<agentId, VECAgent> ready for use by tower.ts and the inbox loop.
 */
export function buildAgentRegistry(deps: SpecialistDeps): Map<string, VECAgent> {
  const registry = new Map<string, VECAgent>();
  const entries = getSpecialistEntries();

  for (const entry of entries) {
    const agent = new BaseSpecialistAgent(entry, deps);
    registry.set(entry.agent_id, agent);
    console.log(`  [AR] Registered: ${entry.employee_id} ${entry.name} (${entry.agent_id}) [${entry.tool_profile}]`);
  }

  console.log(`  [AR] ${registry.size} specialist agent(s) registered from roster.`);
  return registry;
}
