/**
 * The native Claude Code driver: stream-json in, stream-json out, and
 * permissions relayed through the fleet. Driven against a fake `claude`
 * so it costs nothing; the real binary is checked by hand.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fleet } from "../server/fleet.mjs";
import { attention } from "../server/attention.mjs";
import { ClaudeStreamBuilder } from "../server/claude-stream.mjs";

process.env.FOOLSCAP_CLAUDE = `node ${join(import.meta.dirname, "fake-claude-stream.mjs")}`;

const fleets = [];
after(async () => {
  for (const f of fleets) await f.closeAll();
});

const until = (fn, ms = 8000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error("timed out waiting"));
      setTimeout(tick, 20);
    };
    tick();
  });

async function one(name = "native") {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-claude-"));
  const fleet = new Fleet({ record: true, recordDir: dir });
  fleets.push(fleet);
  const snap = fleet.launch({ agent: "claude", cwd: process.cwd(), name });
  const s = fleet.get(snap.id);
  await until(() => s.status === "idle");
  return { fleet, s, dir };
}

test("builder: stream-json becomes cells with tools paired and a stop reason", () => {
  const b = new ClaudeStreamBuilder();
  b.feed("c2a", { type: "user", message: { role: "user", content: [{ type: "text", text: "run the tests" }] } });
  b.feed("a2c", { type: "system", subtype: "init", model: "claude-x", session_id: "s1" });
  b.feed("a2c", { type: "assistant", message: { content: [{ type: "text", text: "Sure." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }], usage: { output_tokens: 5 } } });
  b.feed("a2c", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "9 passed" }] } });
  b.feed("a2c", { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 });

  assert.equal(b.cells.length, 1);
  assert.equal(b.cells[0].prompt, "run the tests");
  assert.equal(b.cells[0].stopReason, "end_turn");
  const tool = b.cells[0].parts.find((p) => p.kind === "tool").tool;
  assert.equal(tool.name, "Bash");
  assert.equal(tool.input.title, "pnpm test");
  assert.equal(tool.result, "9 passed");
  assert.equal(tool.status, "completed");
  assert.equal(b.model, "claude-x");
  assert.equal(b.totalOutputTokens, 5);
  assert.equal(b.costUsd, 0.01);
});

test("the native driver boots, runs a turn, and reads evidence from Claude Code's own tool names", async () => {
  const { s } = await one();
  assert.equal(s.snapshot().driver, "claude");
  assert.equal(s.snapshot().agentLabel, "claude code");

  s.prompt("edit the ack then run tests");
  assert.equal(s.status, "working");
  await until(() => s.status === "done");

  assert.equal(s.stopReason, "end_turn");
  assert.equal(s.evidence.testsPassed, 1);
  assert.equal(s.evidence.edited, 1, "an Edit with old_string counts as an edited file");
  const doc = s.doc();
  const edit = doc.cells[0].parts.find((p) => p.kind === "tool" && p.tool.name === "Edit").tool;
  assert.equal(edit.input.old_string, "ack(job)");
  assert.match(doc.meta.agent, /claude code · claude-fake-1 · native/);
  assert.equal(attention(s.snapshot()).tier, 1);
});

test("red tests from a Bash tool_result put the session at the top", async () => {
  const { s } = await one();
  s.prompt("make it fail");
  await until(() => s.status === "done");
  assert.equal(s.evidence.testsFailed, 1);
  assert.equal(attention(s.snapshot()).tier, 0);
});

test("a permission asked through the relay blocks the session until answered", async () => {
  const { s } = await one();
  s.prompt("slow one");
  await until(() => s.status === "working");

  const requestId = s.ask({ tool_name: "Write", input: { file_path: ".env", content: "X=1" }, tool_use_id: "toolu_p1" });
  assert.equal(requestId, "toolu_p1");
  assert.equal(s.status, "blocked");
  assert.equal(s.pendingPermission.toolCall.title, "Write .env");
  assert.equal(s.pendingPermission.toolCall.kind, "edit");
  assert.deepEqual(s.decision(requestId), { decided: false, allow: false });
  assert.equal(attention(s.snapshot()).tier, 0);

  s.answerPermission("allow_once");
  assert.equal(s.status, "working");
  assert.deepEqual(s.decision(requestId), { decided: true, allow: true });

  await until(() => s.status === "done");
});

test("denying is recorded as a decision, and an unknown request is denied", async () => {
  const { s } = await one();
  s.prompt("slow again");
  await until(() => s.status === "working");
  const requestId = s.ask({ tool_name: "Bash", input: { command: "rm -rf build" } });
  assert.equal(s.pendingPermission.toolCall.kind, "execute");
  s.answerPermission("reject_once");
  assert.deepEqual(s.decision(requestId), { decided: true, allow: false });
  assert.deepEqual(s.decision("never-asked"), { decided: true, allow: false });
  await until(() => s.status === "done");
});

test("the recording replays into the same document through the claude builder", async () => {
  const { s, dir } = await one();
  s.prompt("edit then test");
  await until(() => s.status === "done");
  await new Promise((r) => setTimeout(r, 250));

  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const lines = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].driver, "claude");
  assert.equal(lines[0].agent, "claude code");

  const b = new ClaudeStreamBuilder();
  for (const l of lines.slice(1)) b.feed(l.dir, l.msg, l.t);
  const live = s.doc().cells;
  assert.equal(b.cells.length, live.length);
  assert.equal(b.cells[0].parts.length, live[0].parts.length);
  assert.equal(b.cells[0].stopReason, "end_turn");
});
