/**
 * The fleet is foolscap acting as the ACP client for many agents. These
 * tests drive it against the fake stdio agent and pin the state machine
 * the cockpit depends on: idle → working → blocked → done, evidence in
 * the present tense, and a recording that replays into the identical
 * document.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fleet } from "../server/fleet.mjs";
import { attention } from "../server/attention.mjs";
import { TranscriptBuilder } from "../server/acp-doc.mjs";

const AGENT = `node ${join(import.meta.dirname, "fake-acp-agent.mjs")}`;
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

async function one(name = "worker") {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-fleet-"));
  const fleet = new Fleet({ record: true, recordDir: dir });
  fleets.push(fleet);
  const snap = fleet.launch({ agent: AGENT, cwd: process.cwd(), name });
  const s = fleet.get(snap.id);
  await until(() => s.status === "idle");
  return { fleet, s, dir };
}

test("a launched agent boots to idle with a session id", async () => {
  const { s } = await one();
  assert.equal(s.sessionId, "sess-fake-1");
  assert.equal(s.snapshot().name, "worker");
  assert.equal(attention(s.snapshot()).tier, 3);
});

test("a turn streams into the document and ends done, with evidence", async () => {
  const { s } = await one();
  s.prompt("make it green");
  assert.equal(s.status, "working");
  await until(() => s.status === "done");

  assert.equal(s.stopReason, "end_turn");
  assert.equal(s.evidence.testsPassed, 1);
  assert.equal(s.evidence.testsFailed, 0);

  const doc = s.doc();
  assert.equal(doc.cells.length, 1);
  assert.equal(doc.cells[0].prompt, "make it green");
  const tools = doc.cells[0].parts.filter((p) => p.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool.name, "execute");
  assert.equal(tools[0].tool.input.title, "pnpm test");
  assert.match(tools[0].tool.result, /11 passed/);
  const text = doc.cells[0].parts
    .filter((p) => p.kind === "text")
    .map((p) => p.text)
    .join("|");
  assert.match(text, /working on it/);
  assert.match(text, /all green/);

  // Finished and unread → waiting for review.
  assert.equal(attention(s.snapshot()).tier, 1);
});

test("red tests put the session at the top of the queue", async () => {
  const { s } = await one();
  s.prompt("this will fail");
  await until(() => s.status === "done");
  assert.equal(s.evidence.testsFailed, 1);
  assert.equal(s.evidence.errors, 1); // the tool itself reported failed
  const a = attention(s.snapshot());
  assert.equal(a.tier, 0);
  assert.match(a.reason, /tests failing/);
});

test("a permission request blocks the session until answered", async () => {
  const { s } = await one();
  s.prompt("ask before writing");
  await until(() => s.status === "blocked");

  assert.equal(s.pendingPermission.toolCall.title, "Write .env");
  assert.deepEqual(
    s.pendingPermission.options.map((o) => o.optionId),
    ["allow-once", "reject-once"],
  );
  assert.equal(attention(s.snapshot()).tier, 0);
  assert.throws(() => s.answerPermission("nonsense"), /unknown option/);

  s.answerPermission("allow-once");
  assert.equal(s.status, "working");
  await until(() => s.status === "done");

  const tool = s
    .doc()
    .cells[0].parts.find((p) => p.kind === "tool" && p.tool.id === "t-ask").tool;
  assert.equal(tool.status, "completed");
  assert.match(tool.result, /permission: allow-once/);
});

test("rejecting a permission is recorded as a failed tool", async () => {
  const { s } = await one();
  s.prompt("ask first");
  await until(() => s.status === "blocked");
  s.answerPermission("reject-once");
  await until(() => s.status === "done");
  const tool = s
    .doc()
    .cells[0].parts.find((p) => p.kind === "tool" && p.tool.id === "t-ask").tool;
  assert.equal(tool.isError, true);
  assert.equal(tool.status, "failed");
});

test("cancel ends a slow turn with stopReason cancelled", async () => {
  const { s } = await one();
  s.prompt("slow one");
  await until(() => s.status === "working" && s.doc().cells[0].parts.length > 0);
  s.cancel();
  await until(() => s.status === "done");
  assert.equal(s.stopReason, "cancelled");
});

test("prompting while a turn is running is refused", async () => {
  const { s } = await one();
  s.prompt("slow");
  assert.throws(() => s.prompt("again"), /session is working/);
  s.cancel();
  await until(() => s.status === "done");
});

test("the recording replays into the same document", async () => {
  const { s, dir } = await one();
  s.prompt("record me");
  await until(() => s.status === "done");
  await new Promise((r) => setTimeout(r, 250)); // let appends flush

  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const lines = (await readFile(join(dir, files[0]), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "foolscap-acp");
  assert.equal(lines[0].name, "worker");

  const b = new TranscriptBuilder();
  for (const l of lines.slice(1)) b.feed(l.dir, l.msg, l.t);
  const live = s.doc().cells;
  assert.deepEqual(
    b.cells.map((c) => c.prompt),
    live.map((c) => c.prompt),
  );
  assert.equal(b.cells[0].parts.length, live[0].parts.length);
  assert.equal(b.cells[0].stopReason, "end_turn");
});

test("closing a session kills the agent and drops it from the list", async () => {
  const { fleet, s } = await one();
  fleet.close(s.id);
  assert.equal(s.status, "exited");
  assert.equal(fleet.list().length, 0);
});
