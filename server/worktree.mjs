/**
 * A git worktree per task, so several agents can work on one repo at once.
 *
 * Each task gets its own checkout on its own branch (`foolscap/<id>`),
 * made from the repo's current HEAD, under a short root so Windows paths
 * stay well inside MAX_PATH. When the task is done the person merges it
 * (one squashed commit on the branch they had checked out) or discards
 * it; either way the worktree and its branch are removed.
 *
 * A fresh worktree has no installed dependencies, so the big ignored
 * folders that make a repo runnable (node_modules, .venv) are linked in
 * from the main checkout: a junction on Windows, a symlink elsewhere,
 * neither needing admin rights. Files listed in a `.worktreeinclude` at
 * the repo root (one path per line, e.g. `.env.local`) are copied.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rmdir, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const LINKED = ["node_modules", ".venv", "venv"];

/** Run git and resolve to trimmed stdout; reject with git's own message. */
export function git(cwd, args, { timeout = 60_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = String(stderr || err.message).trim().split(/\r?\n/).slice(-3).join(" ");
        return reject(new Error(message || `git ${args[0]} failed`));
      }
      resolvePromise(String(stdout).trim());
    });
  });
}

/** Where worktrees live: short, outside the repo, per user. */
export function worktreeRoot(env = process.env, platform = process.platform) {
  if (env.FOOLSCAP_WORKTREES) return env.FOOLSCAP_WORKTREES;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "foolscap", "wt");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "foolscap", "wt");
}

/** The repo's top folder, or null when the folder is not in a git repo. */
export async function repoRoot(cwd) {
  try {
    return resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    return null;
  }
}

/** Create the task's worktree. Returns `{ repo, path, branch, base }`. */
export async function createWorktree({ cwd, id, root = worktreeRoot() }) {
  const repo = await repoRoot(cwd);
  if (!repo) throw new Error("this folder is not a git repo, so it cannot have a worktree");
  const base = await git(repo, ["rev-parse", "HEAD"]);
  const branch = `foolscap/${id}`;
  const path = join(root, id);
  await mkdir(root, { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, path, base]);
  await linkDependencies(repo, path);
  return { repo, path, branch, base };
}

/** Link the main checkout's installed dependencies into a new worktree. */
async function linkDependencies(repo, path) {
  for (const name of LINKED) {
    const from = join(repo, name);
    const to = join(path, name);
    if (!existsSync(from) || existsSync(to)) continue;
    await symlink(from, to, process.platform === "win32" ? "junction" : "dir").catch(() => {});
  }
  let include = "";
  try {
    include = await readFile(join(repo, ".worktreeinclude"), "utf8");
  } catch {
    return;
  }
  for (const line of include.split(/\r?\n/)) {
    const rel = line.trim();
    if (!rel || rel.startsWith("#") || rel.includes("..")) continue;
    const from = join(repo, rel);
    if (!existsSync(from)) continue;
    await mkdir(dirname(join(path, rel)), { recursive: true });
    await copyFile(from, join(path, rel)).catch(() => {});
  }
}

/** The dependency folders foolscap linked into this worktree. */
async function linkedHere(path) {
  const names = [];
  for (const name of LINKED) {
    try {
      if ((await lstat(join(path, name))).isSymbolicLink()) names.push(name);
    } catch {
      // not there
    }
  }
  return names;
}

/**
 * Stage the agent's work without the dependency links. A link is never
 * the task's work: it exists only because the folder was not tracked. On
 * Linux git does not match a symlink against `node_modules/` in
 * .gitignore (the slash means "a folder"), so without this a merge would
 * commit the link. So it is unstaged after every add, which also covers an
 * agent that staged it itself. (An exclude pathspec would be neater, but
 * Git for Windows refuses one that names an ignored path.)
 */
async function stageWork(wt, { intentOnly = false } = {}) {
  const linked = await linkedHere(wt.path);
  await git(wt.path, ["add", "-A", ...(intentOnly ? ["-N"] : [])]);
  if (linked.length) await git(wt.path, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...linked]);
}

/** Commit whatever the agent left in the worktree, so the branch holds it all. */
async function snapshot(wt, message) {
  await stageWork(wt);
  const staged = await git(wt.path, ["diff", "--cached", "--name-only"]);
  if (!staged) return false;
  await git(wt.path, ["-c", "core.hooksPath=", "commit", "-q", "--no-verify", "-m", message]);
  return true;
}

/** What the task changed since it started: `{ files, added, removed }`. */
export async function worktreeChanges(wt) {
  // Include files the agent created but never staged.
  await stageWork(wt, { intentOnly: true }).catch(() => {});
  const numstat = await git(wt.path, ["diff", "--numstat", wt.base]);
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
    const [a, r] = line.split("\t");
    files++;
    added += Number.parseInt(a, 10) || 0;
    removed += Number.parseInt(r, 10) || 0;
  }
  return { files, added, removed };
}

/**
 * Bring the task's work onto the branch checked out in the main repo, as
 * one commit. Refuses when the main checkout has uncommitted changes, and
 * backs out cleanly on a conflict, so the person's work is never mixed.
 */
export async function mergeWorktree(wt, { message }) {
  await snapshot(wt, message);
  const dirty = await git(wt.repo, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) throw new Error("your checkout has uncommitted changes; commit or stash them, then merge");
  const ahead = await git(wt.repo, ["rev-list", "--count", `HEAD..${wt.branch}`]);
  if (ahead === "0") throw new Error("this task changed nothing to merge");
  try {
    await git(wt.repo, ["merge", "--squash", wt.branch]);
  } catch (err) {
    await git(wt.repo, ["reset", "--merge"]).catch(() => {});
    throw new Error(`the merge conflicts with your branch (${err.message}); nothing was changed`);
  }
  await git(wt.repo, ["commit", "-q", "-m", message]);
  return git(wt.repo, ["rev-parse", "--short", "HEAD"]);
}

/** Take the dependency links out before anything deletes the folder, so a
    recursive delete can never follow one into the main checkout. */
async function unlinkDependencies(path) {
  for (const name of LINKED) {
    const link = join(path, name);
    try {
      if (!(await lstat(link)).isSymbolicLink()) continue;
      if (process.platform === "win32") await rmdir(link);
      else await unlink(link);
    } catch {
      // not there, or not ours
    }
  }
}

/** Remove the worktree and its branch. */
export async function removeWorktree(wt) {
  await unlinkDependencies(wt.path);
  await git(wt.repo, ["worktree", "remove", "--force", wt.path]).catch(() => {});
  await git(wt.repo, ["worktree", "prune"]).catch(() => {});
  await git(wt.repo, ["branch", "-D", wt.branch]).catch(() => {});
}
