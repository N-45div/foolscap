import { test } from "node:test";
import assert from "node:assert/strict";
import { ExternalSessions } from "../server/external.mjs";

const base = { session_id: "abc", cwd: "/work/api", transcript_path: null };
const green = async () => ({ verdict: "green", reason: "3/3 passed", counts: { total: 3, passed: 3, failed: 0 } });
const red = async () => ({ verdict: "red", reason: "1 of 3 failed", counts: { total: 3, passed: 2, failed: 1 } });

test("hook events become an inbox session", async () => {
  const ext = new ExternalSessions({ verify: green });
  await ext.handle({ ...base, hook_event_name: "SessionStart" });
  await ext.handle({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix the login bug" });
  const [s] = ext.list();
  assert.equal(s.id, "claude:abc");
  assert.equal(s.name, "api");
  assert.equal(s.status, "working");
  assert.equal(s.lastPrompt, "fix the login bug");
  await ext.handle({ ...base, hook_event_name: "Stop" });
  assert.equal(ext.list()[0].status, "done");
  await ext.handle({ ...base, hook_event_name: "SessionEnd" });
  assert.equal(ext.list().length, 0);
});

test("a permission request waits for the answer given in foolscap", async () => {
  const ext = new ExternalSessions({ verify: green });
  const pending = ext.handle({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "t1" });
  await new Promise((r) => setImmediate(r));
  const s = ext.get("claude:abc");
  assert.equal(s.snapshot().status, "blocked");
  assert.equal(s.snapshot().pendingPermission.toolCall.title, "rm -rf build");
  s.answerPermission("reject_once");
  assert.deepEqual(await pending, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied in foolscap." } },
  });
});

test("no answer in time hands the question back to the terminal", async () => {
  const ext = new ExternalSessions({ holdMs: 10, verify: green });
  assert.deepEqual(await ext.handle({ ...base, hook_event_name: "PermissionRequest", tool_name: "Edit", tool_input: { file_path: "a.js" } }), {});
});

test("a queued prompt goes out at Stop only when the tests are green", async () => {
  const ok = new ExternalSessions({ verify: green });
  await ok.handle({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix it" });
  ok.get("claude:abc").enqueue("now add a test");
  assert.deepEqual(await ok.handle({ ...base, hook_event_name: "Stop" }), { decision: "block", reason: "now add a test" });

  const held = new ExternalSessions({ verify: red });
  await held.handle({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix it" });
  held.get("claude:abc").enqueue("now add a test");
  assert.deepEqual(await held.handle({ ...base, hook_event_name: "Stop" }), {});
  assert.match(held.get("claude:abc").snapshot().held.reason, /tests red/);
});
