/**
 * it runs in a git worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged. The path is logged
 * and kept by default (`keepWorktree: false` deletes after the call).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Bound every git invocation (audit2 #21): a hung git (network FS, credential
 * helper prompt) must not block agent spawn or teardown forever. 30s is far
 * above any local worktree add/remove; maxBuffer caps a noisy stderr.
 */
const GIT_EXEC_OPTIONS = { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 } as const;

/** Options for the git invocations behind worktree creation/removal. */
export interface WorktreeExecOptions {
  /** Per-invocation timeout; defaults to 30s (see GIT_EXEC_OPTIONS). */
  timeoutMs?: number;
}

const gitOptions = (opts?: WorktreeExecOptions) =>
  opts?.timeoutMs !== undefined ? { ...GIT_EXEC_OPTIONS, timeout: opts.timeoutMs } : GIT_EXEC_OPTIONS;

export interface Worktree {
  /** True when a real worktree was created; false means isolation failed. */
  isolated: boolean;
  /** cwd the agent should run in (worktree path when isolated, else the base cwd). */
  cwd: string;
  branch?: string;
  /** Repo root the worktree was added to (for teardown). */
  repoRoot?: string;
  /** Why isolation was skipped, when isolated === false. */
  reason?: string;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

/**
 * Create an isolated worktree under `<repoRoot>/.pi/worktrees/<name>` on branch
 * `pi/wf/<name>`. A unique suffix gives each live execution its own ownership;
 * retained results from earlier executions are never reused or overwritten.
 * Journal identity is independent of this path. Returns a failed Worktree on error.
 */
export async function createWorktree(
  baseCwd: string,
  name: string,
  execOptions?: WorktreeExecOptions,
): Promise<Worktree> {
  const id = `${slug(name)}-${randomUUID()}`;
  let repoRoot: string;
  try {
    const { stdout } = await exec("git", ["-C", baseCwd, "rev-parse", "--show-toplevel"], gitOptions(execOptions));
    repoRoot = stdout.trim();
  } catch {
    return { isolated: false, cwd: baseCwd, reason: "not a git repository" };
  }

  const path = join(repoRoot, ".pi", "worktrees", id);
  const branch = `pi/wf/${id}`;
  try {
    await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"], gitOptions(execOptions));
    return { isolated: true, cwd: path, branch, repoRoot };
  } catch (error) {
    return { isolated: false, cwd: baseCwd, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Remove a worktree and its branch. Best-effort; safe to call on a no-op Worktree. */
export async function removeWorktree(wt: Worktree, execOptions?: WorktreeExecOptions): Promise<void> {
  if (!wt.isolated || !wt.repoRoot) return;
  try {
    await exec("git", ["-C", wt.repoRoot, "worktree", "remove", "--force", wt.cwd], gitOptions(execOptions));
  } catch {
    // A failed removal (e.g. a locked tree) does not authorize deleting its branch.
    return;
  }
  if (wt.branch) {
    try {
      await exec("git", ["-C", wt.repoRoot, "branch", "-D", wt.branch], gitOptions(execOptions));
    } catch {
      // branch already deleted
    }
  }
}
