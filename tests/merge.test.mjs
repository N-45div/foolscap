/**
 * A task in its own worktree, end to end against the fake Claude Code:
 * the queued step goes out after green, Merge lands one commit whose body
 * tells the whole story, and the task never flashes as exited on the way.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fleet } from "../server/fleet.mjs";
import { git } from "../server/worktree.mjs";
import { ClaudeStreamBuilder } from "../server/claude-stream.mjs";

process.env.FOOLSCAP_CLAUDE = `node ${join(import.meta.dirname, "fake-claude-stream.mjs")}`;
process.env.FOOLSCAP_WORKTREES = await mkdtemp(join(tmpdir(), "foolscap-merge-wt-"));

const fleets = [];
after(async () => {
  for (const f of fleets) await f.closeAll();
});

const until = (fn, ms = 20000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error("timed out waiting"));
      setTimeout(tick, 25);
    };
    tick();
  });

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-merge-repo-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "m", private: true, type: "module", scripts: { test: "node --test" } }));
  await mkdir(join(dir, "tests"));
  await writeFile(join(dir, "tests", "a.test.mjs"), 'import { test } from "node:test";\ntest("a", () => {});\n');
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("Merge lands one commit naming every prompt and the last check, and never shows the task as exited", async () => {
  const dir = await repo();
  const fleet = new Fleet({});
  fleets.push(fleet);
  const snap = await fleet.launchTask({ agent: "claude", cwd: dir, worktree: true, prompt: "edit the first thing", queue: ["then the second thing"] });
  const s = fleet.get(snap.id);
  await until(() => s.status === "done" && s.turns === 2 && s.verified?.verdict === "green");

  // What the agent would have changed.
  await writeFile(join(s.worktree.path, "b.txt"), "from the task\n");
  const seen = [];
  s.on("change", () => seen.push(s.status));
  const sha = await s.merge();
  assert.ok(!seen.includes("exited"), `statuses during merge: ${seen.join(", ")}`);
  assert.equal(s.worktree, null);

  const message = await git(dir, ["log", "-1", "--format=%B"]);
  assert.equal(await git(dir, ["rev-parse", "--short", "HEAD"]), sha);
  assert.match(message, /^Claude Code: edit the first thing/);
  assert.match(message, /Prompts:\n- edit the first thing\n- then the second thing/);
  // Inside node --test, a nested node --test reports to its parent and prints
  // no count, so only the verdict is pinned here.
  assert.match(message, /\n\nChecked by foolscap: npm test green, .+\.$/);
  assert.ok(existsSync(join(dir, "b.txt")));
});

test("what a task is doing names files from its folder", () => {
  const cwd = process.platform === "win32" ? "C:\\work\\wt\\abc" : "/work/wt/abc";
  const file = process.platform === "win32" ? "C:\\work\\wt\\abc\\src\\q.ts" : "/work/wt/abc/src/q.ts";
  const b = new ClaudeStreamBuilder({ cwd });
  b.feed("c2a", { type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } });
  b.feed("a2c", { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] } });
  assert.equal(b.activity.text, "Edit src/q.ts");
});
