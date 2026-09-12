import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorktree as createWorktreeLive, removeWorktree } from "../src/worktree.js";

// ── Existing tests (unchanged) ──

test("createWorktree no-ops (not isolated) outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-nogit-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");
    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.match(wt.reason ?? "", /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWorktree isolates in a git repo, then removeWorktree cleans up", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-9-0-edit");
    assert.equal(wt.isolated, true);
    assert.ok(wt.cwd !== repo && existsSync(wt.cwd), "worktree dir exists");
    assert.ok(existsSync(join(wt.cwd, "file.txt")), "worktree has a checkout");

    // Editing inside the worktree must not touch the base tree.
    writeFileSync(join(wt.cwd, "file.txt"), "changed in worktree\n");
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");

    await removeWorktree(wt);
    assert.ok(!existsSync(wt.cwd), "worktree dir removed");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.equal(branches.trim(), "", "branch deleted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── NEW TESTS ──

test("createWorktree falls back when git fails (non-git directory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-noexec-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");

    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.ok(wt.reason, "should provide a fallback reason when git fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree does not throw when worktree directory is already missing", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-missing-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-missing-dir");
    assert.equal(wt.isolated, true);

    // Remove the worktree directory so git worktree remove --force fails
    rmSync(wt.cwd, { recursive: true, force: true });
    assert.ok(!existsSync(wt.cwd), "worktree dir removed manually before removeWorktree");

    // removeWorktree must not throw despite git commands failing
    await assert.doesNotReject(removeWorktree(wt));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree gives repeated long names independent retained worktrees", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-retained-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    // These names intentionally share the complete 32-character slug prefix.
    const name = "same-run-id-with-a-very-long-label-that-would-previously-collide";
    const first = await createWorktreeLive(repo, name);
    assert.equal(first.isolated, true);
    writeFileSync(join(first.cwd, "retained.txt"), "first execution\n");

    const second = await createWorktreeLive(repo, name);
    assert.equal(second.isolated, true);
    assert.notEqual(second.cwd, first.cwd, "a later execution must not reuse a retained worktree");
    assert.notEqual(second.branch, first.branch, "a later execution owns a distinct branch");
    assert.equal(readFileSync(join(first.cwd, "retained.txt"), "utf8"), "first execution\n");
    assert.equal(
      existsSync(join(second.cwd, "retained.txt")),
      false,
      "later worktree starts from base, not retained edits",
    );
    assert.equal(existsSync(join(repo, "retained.txt")), false, "retained edits never reach the base checkout");

    await removeWorktree(second);
    await removeWorktree(first);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree preserves the branch when a locked worktree cannot be removed", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-failrm-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-fail-rm");
    assert.equal(wt.isolated, true);

    git("worktree", "lock", "--reason", "test lock", wt.cwd);
    await assert.doesNotReject(removeWorktree(wt));
    assert.ok(existsSync(wt.cwd), "a locked worktree remains inspectable after failed cleanup");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.notEqual(branches.trim(), "", "failed worktree removal must not delete its branch");

    git("worktree", "unlock", wt.cwd);
    await removeWorktree(wt);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
