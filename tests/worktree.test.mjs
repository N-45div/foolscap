/**
 * Worktrees against a real temporary git repo: create, count changes,
 * merge as one commit, refuse a dirty checkout, back out of a conflict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, git, mergeWorktree, removeWorktree, sweepWorktrees, worktreeChanges } from "../server/worktree.mjs";

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-repo-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await writeFile(join(dir, "a.txt"), "one\n");
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, ".gitignore"), "node_modules/\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  const root = await mkdtemp(join(tmpdir(), "foolscap-wt-"));
  return { dir, root };
}

test("a task's worktree is a separate checkout with dependencies linked in", async () => {
  const { dir, root } = await repo();
  const wt = await createWorktree({ cwd: dir, id: "t1", root });
  assert.equal(wt.branch, "foolscap/t1");
  assert.ok(existsSync(join(wt.path, "a.txt")));
  assert.ok(existsSync(join(wt.path, "node_modules")));
  await writeFile(join(dir, "node_modules", "keep.txt"), "the main checkout's own\n");
  await removeWorktree(wt);
  assert.equal(existsSync(wt.path), false);
  assert.ok(existsSync(join(dir, "node_modules", "keep.txt")), "removing a worktree never touches the linked folder");
});

test("changes are counted, new files included, and merged as one commit", async () => {
  const { dir, root } = await repo();
  const wt = await createWorktree({ cwd: dir, id: "t2", root });
  await writeFile(join(wt.path, "a.txt"), "one\ntwo\n");
  await writeFile(join(wt.path, "b.txt"), "new\n");
  assert.deepEqual(await worktreeChanges(wt), { files: 2, added: 2, removed: 0 });
  await mergeWorktree(wt, { message: "foolscap: add two" });
  assert.equal(await readFile(join(dir, "b.txt"), "utf8"), "new\n");
  assert.equal(await git(dir, ["log", "-1", "--format=%s"]), "foolscap: add two");
  assert.equal(await git(dir, ["ls-files", "node_modules"]), "", "the dependency link is never merged");
  await removeWorktree(wt);
});

test("removing a worktree that a just-closed process still sits in leaves no folder behind", async () => {
  const { dir, root } = await repo();
  const wt = await createWorktree({ cwd: dir, id: "t5", root });
  const held = spawn(process.execPath, ["-e", "setTimeout(() => {}, 700)"], { cwd: wt.path, stdio: "ignore" });
  await removeWorktree(wt);
  await new Promise((r) => (held.exitCode === null ? held.on("exit", r) : r()));
  assert.equal(existsSync(wt.path), false);
  assert.equal(await git(dir, ["branch", "--list", "foolscap/t5"]), "");
});

test("a dependency link stays out of the merge even when the agent staged everything", async () => {
  const { dir, root } = await repo();
  const wt = await createWorktree({ cwd: dir, id: "t4", root });
  await writeFile(join(wt.path, "c.txt"), "agent\n");
  await git(wt.path, ["add", "-A"]);
  assert.deepEqual(await worktreeChanges(wt), { files: 1, added: 1, removed: 0 });
  await mergeWorktree(wt, { message: "foolscap: add c" });
  assert.equal(await git(dir, ["ls-files", "node_modules"]), "");
  assert.equal(await readFile(join(dir, "c.txt"), "utf8"), "agent\n");
  await removeWorktree(wt);
});

test("a dirty main checkout is refused, and a conflict leaves it untouched", async () => {
  const { dir, root } = await repo();
  const wt = await createWorktree({ cwd: dir, id: "t3", root });
  await writeFile(join(wt.path, "a.txt"), "theirs\n");
  await writeFile(join(dir, "a.txt"), "mine, uncommitted\n");
  await assert.rejects(() => mergeWorktree(wt, { message: "m" }), /uncommitted changes/);
  await git(dir, ["commit", "-q", "-am", "mine"]);
  await assert.rejects(() => mergeWorktree(wt, { message: "m" }), /conflicts/);
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "mine, uncommitted\n");
  assert.equal(await git(dir, ["status", "--porcelain", "--untracked-files=no"]), "");
  await removeWorktree(wt);
});

test("the sweep takes empty leftover folders and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "foolscap-sweep-"));
  await mkdir(join(root, "left-empty"));
  await mkdir(join(root, "live-task"));
  await writeFile(join(root, "live-task", "work.txt"), "keep me\n");
  await writeFile(join(root, "a-file"), "not a folder\n");
  const removed = await sweepWorktrees(root);
  assert.deepEqual(removed, [join(root, "left-empty")]);
  assert.equal(existsSync(join(root, "live-task", "work.txt")), true);
  assert.equal(existsSync(join(root, "a-file")), true);
  assert.deepEqual(await sweepWorktrees(join(root, "missing")), []);
});
