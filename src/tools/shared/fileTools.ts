/**
 * File-system tools for VEC agents — thin wrappers over @mariozechner/pi-coding-agent.
 *
 * Coding tools  (read, bash, edit, write) — for Dev and DevOps agents.
 * ReadOnly tools (read, grep, find, ls)   — for all other specialist agents.
 *
 * The `cwd` defaults to config.workspace (sandboxed workspace directory).
 *
 * Usage:
 *   import { getCodingTools, getReadOnlyTools, getGlobTool } from "./fileTools.js";
 *   tools: [...getCodingTools(), getGlobTool(), ...]   // dev / devops
 *   tools: [...getReadOnlyTools(), ...]                // ba / qa / security / architect / etc.
 */

import { createCodingTools, createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import { globSync } from "glob";
import path from "path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { config } from "../../config.js";
import { getEmployeeId } from "../../ar/roster.js";

/** Full coding tools: read, bash, edit, write — for Dev/DevOps agents. */
export function getCodingTools(cwd?: string): AgentTool[] {
  return createCodingTools(cwd ?? config.workspace) as AgentTool[];
}

/** Read-only tools: read, grep, find, ls — for all other specialist agents. */
export function getReadOnlyTools(cwd?: string): AgentTool[] {
  return createReadOnlyTools(cwd ?? config.workspace) as AgentTool[];
}

// ── Path sandboxing ──────────────────────────────────────────────────────────

const AGENTS_DIR = path.resolve(config.workspace, "agents");
const MEMORY_DIR = path.resolve(config.memoryDir);

/**
 * Check if a resolved path is allowed for the given agent.
 *
 * Rules:
 * 1. Within workspace: block other agents' private folders (workspace/agents/{other}/)
 * 2. Outside workspace: block everything EXCEPT the agent's own memory folder
 */
function isPathAllowed(agentId: string, filePath: string): boolean {
  const workspace = path.resolve(config.workspace);
  const resolved = path.resolve(workspace, filePath);

  // ── Inside workspace ──
  if (resolved.startsWith(workspace + path.sep) || resolved === workspace) {
    // Block access to other agents' private workspace folders
    if (resolved.startsWith(AGENTS_DIR + path.sep)) {
      const ownDir = path.resolve(AGENTS_DIR, getEmployeeId(agentId));
      if (!resolved.startsWith(ownDir + path.sep) && resolved !== ownDir) {
        return false;
      }
    }
    return true;
  }

  // ── Outside workspace — only allow agent's own memory dir ──
  const ownMemory = path.resolve(MEMORY_DIR, agentId);
  if (resolved === ownMemory || resolved.startsWith(ownMemory + path.sep)) {
    return true;
  }

  // Everything else outside workspace is blocked
  return false;
}

function accessDenied(toolName: string, filePath: string) {
  return {
    content: [{
      type: "text" as const,
      text:
        `ACCESS DENIED: '${toolName}' cannot access '${filePath}'.\n` +
        `You can only access your own agent folder, shared/, and projects/.\n` +
        `Other agents' private folders and memory are not accessible.`,
    }],
    details: {},
  };
}

/**
 * Wrap file tools with per-agent path sandboxing.
 * Blocks access to other agents' private workspace/memory folders.
 * Bash tool is passed through (too complex to sandbox reliably).
 */
export function sandboxFileTools(agentId: string, tools: AgentTool[]): AgentTool[] {
  return tools.map((tool) => {
    // Bash is hard to sandbox via path checks — skip it
    if (tool.name === "bash") return tool;

    return {
      ...tool,
      execute: async (ctx: any, params: any) => {
        const filePath: string = params?.path ?? params?.file_path ?? params?.dir ?? "";
        if (filePath && !isPathAllowed(agentId, filePath)) {
          return accessDenied(tool.name, filePath);
        }
        return tool.execute(ctx, params);
      },
    };
  });
}

// ── Scoped write tools ──────────────────────────────────────────────────────

const DOC_EXTENSIONS = [".md", ".mmd"];

function isDocFile(filePath: string): boolean {
  const lower = (filePath ?? "").toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function docBlocked(toolName: string, filePath: string) {
  return {
    content: [{
      type: "text" as const,
      text:
        `BLOCKED: '${toolName}' is restricted to .md and .mmd files only.\n` +
        `'${filePath}' is not a documentation file.\n` +
        `You can write/edit documentation files (.md, .mmd) in agents/<your-folder>/ and shared/.`,
    }],
    details: {},
  };
}

/**
 * Scoped write + edit tools for non-Dev agents (QA, Security, Architect, Researcher).
 * Restricted to .md and .mmd files only — these agents write reports, not code.
 * Path sandboxing is applied separately via sandboxFileTools().
 */
export function getScopedWriteTools(): AgentTool[] {
  const base = createCodingTools(config.workspace) as AgentTool[];
  const byName = new Map(base.map((t) => [t.name, t]));

  const writeTool = byName.get("write")!;
  const editTool = byName.get("edit")!;

  return [
    {
      ...writeTool,
      description:
        "Write a .md or .mmd documentation file. Only documentation extensions are allowed — you write reports, not code.",
      execute: async (ctx: any, params: any) => {
        const filePath: string = params?.path ?? params?.file_path ?? "";
        if (filePath && !isDocFile(filePath)) {
          return docBlocked("write", filePath);
        }
        return writeTool.execute(ctx, params);
      },
    },
    {
      ...editTool,
      description:
        "Make targeted edits to a .md or .mmd documentation file. Only documentation extensions are allowed.",
      execute: async (ctx: any, params: any) => {
        const filePath: string = params?.path ?? params?.file_path ?? "";
        if (filePath && !isDocFile(filePath)) {
          return docBlocked("edit", filePath);
        }
        return editTool.execute(ctx, params);
      },
    },
  ];
}

/** Glob tool — find files matching a pattern. Paths are relative to the workspace root. */
export function getGlobTool(cwd?: string): AgentTool {
  const root = cwd ?? config.workspace;
  return {
    name: "glob",
    label: "Glob",
    description:
      "Find files matching a glob pattern. Paths are relative to the workspace root. " +
      "Examples: '**/*.ts', 'src/**/*.py', 'shared/*.md', 'projects/my-app/**'.",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Glob pattern to match against, e.g. '**/*.ts' or 'shared/*.md'",
      }),
    }),
    execute: async (_: any, params: any) => {
      const matches = globSync(params.pattern as string, { cwd: root, nodir: true });
      if (!matches.length) {
        return { content: [{ type: "text" as const, text: `No files matched: ${params.pattern}` }], details: {} };
      }
      // Normalize to forward slashes for consistent output across platforms
      const normalized = matches.map((p) => p.replace(/\\/g, "/"));
      return {
        content: [{ type: "text" as const, text: normalized.join("\n") }],
        details: {},
      };
    },
  };
}
