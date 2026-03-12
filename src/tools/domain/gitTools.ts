/**
 * Git versioning tools for the Dev agent.
 *
 * Provides explicit git operations (init, status, diff, add, commit, log)
 * scoped to workspace/projects/ directories, plus a helper for auto-commit
 * on task completion.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, normalize } from "path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { projectsWorkspace } from "../../config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * Resolve a project name to an absolute path inside workspace/projects/.
 * Throws if the resolved path escapes the projects directory.
 */
function resolveProjectDir(project: string): string {
  const resolved = resolve(projectsWorkspace, normalize(project));
  if (!resolved.startsWith(projectsWorkspace)) {
    throw new Error(`Path traversal blocked: '${project}' resolves outside projects/`);
  }
  return resolved;
}

/** Run a git command in a directory and return stdout. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/** Check if a directory has a .git folder. */
function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

const DEFAULT_GITIGNORE = `node_modules/
dist/
build/
.env
.env.*
*.log
.DS_Store
Thumbs.db
coverage/
.cache/
`;

// ── Git Tools ─────────────────────────────────────────────────────────────────

export function getGitTools(): AgentTool[] {
  const git_init: AgentTool = {
    name: "git_init",
    label: "Git Init",
    description:
      "Initialize a new git repository in a project folder under workspace/projects/. " +
      "Creates a .gitignore and makes an initial commit.",
    parameters: Type.Object({
      project: Type.String({ description: "Project folder name under workspace/projects/ (e.g. 'my-app')" }),
    }),
    execute: async (_, params: any) => {
      const dir = resolveProjectDir(params.project);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      if (isGitRepo(dir)) {
        return ok(`Project '${params.project}' already has a git repository.`);
      }
      git(dir, ["init"]);
      // Create .gitignore if it doesn't exist
      const gitignorePath = join(dir, ".gitignore");
      if (!existsSync(gitignorePath)) {
        writeFileSync(gitignorePath, DEFAULT_GITIGNORE, "utf-8");
      }
      git(dir, ["add", "-A"]);
      git(dir, [
        "-c", "user.name=Rohan Mehta",
        "-c", "user.email=rohan@vec.company",
        "commit", "-m", "Initial commit",
        "--allow-empty",
      ]);
      return ok(`Initialized git repository in projects/${params.project}/ with initial commit.`);
    },
  };

  const git_status: AgentTool = {
    name: "git_status",
    label: "Git Status",
    description: "Show the git status of a project directory.",
    parameters: Type.Object({
      project: Type.String({ description: "Project folder name under workspace/projects/" }),
    }),
    execute: async (_, params: any) => {
      const dir = resolveProjectDir(params.project);
      if (!isGitRepo(dir)) return ok(`ERROR: '${params.project}' is not a git repository. Use git_init first.`);
      const output = git(dir, ["status"]);
      return ok(output);
    },
  };

  const git_diff: AgentTool = {
    name: "git_diff",
    label: "Git Diff",
    description: "Show file changes in a project. Use staged=true to see staged changes.",
    parameters: Type.Object({
      project: Type.String({ description: "Project folder name under workspace/projects/" }),
      staged: Type.Optional(Type.Boolean({ description: "If true, show staged changes (--staged). Default: false." })),
    }),
    execute: async (_, params: any) => {
      const dir = resolveProjectDir(params.project);
      if (!isGitRepo(dir)) return ok(`ERROR: '${params.project}' is not a git repository.`);
      const args = params.staged ? ["diff", "--staged"] : ["diff"];
      const output = git(dir, args);
      return ok(output || "(no changes)");
    },
  };

  const git_add: AgentTool = {
    name: "git_add",
    label: "Git Add",
    description: "Stage files for commit. Defaults to staging all changes.",
    parameters: Type.Object({
      project: Type.String({ description: "Project folder name under workspace/projects/" }),
      files: Type.Optional(Type.String({ description: "Space-separated file paths to stage. Default: '.' (all)" })),
    }),
    execute: async (_, params: any) => {
      const dir = resolveProjectDir(params.project);
      if (!isGitRepo(dir)) return ok(`ERROR: '${params.project}' is not a git repository.`);
      const fileArgs = params.files ? params.files.split(/\s+/) : ["."];
      git(dir, ["add", ...fileArgs]);
      const status = git(dir, ["status", "--short"]);
      return ok(`Staged files in '${params.project}'.\n${status}`);
    },
  };

  const git_commit: AgentTool = {
    name: "git_commit",
    label: "Git Commit",
    description:
      "Commit staged changes with a message. If nothing is staged, auto-stages all changes first. " +
      "Author is set to Rohan Mehta.",
    parameters: Type.Object({
      project: Type.String({ description: "Project folder name under workspace/projects/" }),
      message: Type.String({ description: "Commit message describing the changes" }),
    }),
    execute: async (_, params: any) => {
      const dir = resolveProjectDir(params.project);
      if (!isGitRepo(dir)) return ok(`ERROR: '${params.project}' is not a git repository. Use git_init first.`);

      // Auto-stage if nothing is staged
      const staged = git(dir, ["diff", "--staged", "--stat"]);
      if (!staged) {
        const porcelain = git(dir, ["status", "--porcelain"]);
        if (!porcelain) return ok("Nothing to commit — working tree clean.");
        git(dir, ["add", "-A"]);
      }

      const output = git(dir, [
        "-c", "user.name=Rohan Mehta",
        "-c", "user.email=rohan@vec.company",
        "commit", "-m", params.message,
      ]);
      return ok(output);
    },
  };

  const git_log: AgentTool = {
    name: "git_log",
    label: "Git Log",
    description: "Show commit history for a project.",
    parameters: Type.Object({
      project: Type.String({ description: "Project folder name under workspace/projects/" }),
      limit: Type.Optional(Type.Number({ description: "Max number of commits to show. Default: 20." })),
    }),
    execute: async (_, params: any) => {
      const dir = resolveProjectDir(params.project);
      if (!isGitRepo(dir)) return ok(`ERROR: '${params.project}' is not a git repository.`);
      const n = params.limit ?? 20;
      const output = git(dir, ["log", "--oneline", `-n`, String(n)]);
      return ok(output || "(no commits yet)");
    },
  };

  return [git_init, git_status, git_diff, git_add, git_commit, git_log];
}

// ── Auto-commit helper (used by devAgent task lifecycle) ──────────────────────

/**
 * Auto-initialize a git repo in a project folder if it doesn't have one yet.
 * Called before task execution when folder_access points to a projects/ path.
 */
export function autoInitRepo(projectDir: string): void {
  if (!existsSync(projectDir) || isGitRepo(projectDir)) return;

  git(projectDir, ["init"]);
  const gitignorePath = join(projectDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, DEFAULT_GITIGNORE, "utf-8");
  }
  git(projectDir, ["add", "-A"]);
  try {
    git(projectDir, [
      "-c", "user.name=Rohan Mehta",
      "-c", "user.email=rohan@vec.company",
      "commit", "-m", "Initial commit [auto-init]",
      "--allow-empty",
    ]);
  } catch {
    // empty repo, nothing to commit — that's fine
  }
}

/**
 * Auto-commit any uncommitted changes after a completed task.
 * Returns true if a commit was made, false if working tree was clean.
 */
export function autoCommitIfDirty(projectDir: string, taskId: string, taskDescription: string): boolean {
  if (!existsSync(projectDir) || !isGitRepo(projectDir)) return false;

  const porcelain = git(projectDir, ["status", "--porcelain"]);
  if (!porcelain) return false; // clean

  git(projectDir, ["add", "-A"]);
  const msg = `${taskId}: ${taskDescription.slice(0, 100)} [auto-commit]`;
  git(projectDir, [
    "-c", "user.name=Rohan Mehta",
    "-c", "user.email=rohan@vec.company",
    "commit", "-m", msg,
  ]);
  return true;
}

/**
 * Extract the project directory from a task's folder_access field.
 * Returns the absolute path if it's a projects/ path, null otherwise.
 */
export function getProjectDirFromFolderAccess(folderAccess: string): string | null {
  if (!folderAccess) return null;
  // folder_access is relative to workspace, e.g. "projects/my-app"
  const normalized = normalize(folderAccess);
  if (!normalized.startsWith("projects")) return null;
  const resolved = resolve(projectsWorkspace, "..", normalized);
  if (!resolved.startsWith(projectsWorkspace)) return null;
  return resolved;
}
