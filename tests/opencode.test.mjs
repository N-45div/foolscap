/**
 * The OpenCode adapter, against a synthetic opencode.db built with the
 * real table and JSON shapes. Never real data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasSqlite,
  opencodeRef,
  parseOpencodeRef,
  readOpencodeSession,
  scanOpencode,
} from "../server/opencode.mjs";
import { judge, segmentsFor } from "../server/outcome.mjs";

async function synthDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "foolscap-opencode-"));
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec(`
    create table session (id text primary key, project_id text, parent_id text, directory text, title text,
      version text, model text, agent text, cost real, tokens_input integer, tokens_output integer,
      time_created integer, time_updated integer);
    create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
  `);
  const ins = (t, cols, vals) =>
    db.prepare(`insert into ${t} (${cols.join(",")}) values (${cols.map(() => "?").join(",")})`).run(...vals);
  const t0 = 1787724914000;
  ins("session", ["id", "parent_id", "directory", "title", "version", "model", "agent", "cost", "tokens_input", "tokens_output", "time_created", "time_updated"],
    ["ses_1", null, "C:/Users/demo/copperline", "make the tests pass", "1.2.3", JSON.stringify({ providerID: "anthropic", modelID: "claude-x" }), "build", 0.02, 900, 240, t0, t0 + 60000]);
  // a child (subtask) session must not be listed on its own
  ins("session", ["id", "parent_id", "directory", "title", "time_created", "time_updated"], ["ses_child", "ses_1", "C:/Users/demo/copperline", "subtask", t0, t0]);

  ins("message", ["id", "session_id", "time_created", "data"], ["msg_u1", "ses_1", t0 + 1, JSON.stringify({ role: "user", time: { created: t0 + 1 }, agent: "build" })]);
  ins("part", ["id", "message_id", "session_id", "time_created", "data"], ["prt_u1", "msg_u1", "ses_1", t0 + 1, JSON.stringify({ type: "text", text: "make the tests pass" })]);

  ins("message", ["id", "session_id", "time_created", "data"], ["msg_a1", "ses_1", t0 + 2, JSON.stringify({ role: "assistant", time: { created: t0 + 2, completed: t0 + 9000 }, modelID: "claude-x", providerID: "anthropic", tokens: { input: 900, output: 240 }, cost: 0.02 })]);
  const parts = [
    ["prt_1", { type: "step-start", snapshot: "abc" }],
    ["prt_2", { type: "reasoning", text: "One failing assertion in queue.test.ts; the ack is not awaited." }],
    ["prt_3", { type: "text", text: "Fixing the ack, then rerunning." }],
    ["prt_4", { type: "tool", tool: "edit", callID: "call_edit_1", state: { status: "completed", input: { filePath: "src/queue.ts", oldString: "q.ack(job)", newString: "await q.ack(job)" }, output: "edited src/queue.ts", title: "src/queue.ts" } }],
    ["prt_5", { type: "tool", tool: "bash", callID: "call_bash_1", state: { status: "completed", input: { command: "pnpm test" }, output: "Tests  11 passed (11)", title: "pnpm test" } }],
    ["prt_6", { type: "text", text: "Green." }],
    ["prt_7", { type: "step-finish", reason: "stop", tokens: { input: 900, output: 240 }, cost: 0.02 }],
  ];
  parts.forEach(([id, data], i) =>
    ins("part", ["id", "message_id", "session_id", "time_created", "data"], [id, "msg_a1", "ses_1", t0 + 10 + i, JSON.stringify(data)]),
  );
  db.close();
  return dir;
}

test("scan lists top-level sessions grouped by directory, with byte and time estimates", { skip: !hasSqlite && "node:sqlite unavailable" }, async () => {
  const dir = await synthDb();
  const groups = scanOpencode(dir);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].source, "opencode");
  assert.equal(groups[0].dir, "C:/Users/demo/copperline");
  assert.equal(groups[0].sessions.length, 1, "the child session is folded into its parent");
  const s = groups[0].sessions[0];
  assert.equal(s.id, "ses_1");
  assert.ok(s.bytes > 200);
  assert.ok(s.file.startsWith("opencode://ses_1?db="));
  assert.deepEqual(parseOpencodeRef(s.file), { id: "ses_1", db: join(dir, "opencode.db") });
  assert.equal(parseOpencodeRef("C:/x.jsonl"), null);
});

test("a session expands to NDJSON and parses into cells with mapped tool inputs", { skip: !hasSqlite && "node:sqlite unavailable" }, async () => {
  const dir = await synthDb();
  const text = readOpencodeSession(join(dir, "opencode.db"), "ses_1");
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "opencode-session");
  assert.equal(lines[0].directory, "C:/Users/demo/copperline");
  assert.equal(lines.filter((l) => l.type === "message").length, 2);
  assert.equal(lines.filter((l) => l.type === "part").length, 8);
  assert.equal(lines.find((l) => l.type === "part" && l.tool === "bash").partType, "tool");

  const { parseOpencodeSession } = await import("../src/sources/opencode.ts");
  const doc = parseOpencodeSession(text);
  assert.equal(doc.cells.length, 1);
  assert.equal(doc.cells[0].prompt, "make the tests pass");
  assert.equal(doc.cells[0].outputTokens, 240);
  assert.match(doc.meta.agent, /opencode · claude-x · build/);
  const tools = doc.cells[0].parts.filter((p) => p.kind === "tool").map((p) => p.tool);
  assert.deepEqual(tools.map((t) => t.name), ["edit", "bash"]);
  assert.equal(tools[0].input.file_path, "src/queue.ts");
  assert.equal(tools[0].input.old_string, "q.ack(job)");
  assert.equal(tools[0].input.new_string, "await q.ack(job)");
  assert.equal(tools[1].result, "Tests  11 passed (11)");
  assert.equal(doc.cells[0].parts.filter((p) => p.kind === "thinking").length, 1);
  assert.equal(doc.cells[0].parts.filter((p) => p.kind === "text").length, 2);
});

test("the shelf and the judge read OpenCode sessions like any other", { skip: !hasSqlite && "node:sqlite unavailable" }, async () => {
  const dir = await synthDb();
  const text = readOpencodeSession(join(dir, "opencode.db"), "ses_1");
  const segments = segmentsFor("opencode", text.split("\n"));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "make the tests pass");
  assert.equal(segments[0].tools.length, 2);
  assert.equal(judge(segments[0]).verdict, "verified");
});

test("the reference format round-trips a database path with spaces", () => {
  const ref = opencodeRef("C:/Users/some one/.local/share/opencode/opencode.db", "ses_9");
  assert.deepEqual(parseOpencodeRef(ref), { id: "ses_9", db: "C:/Users/some one/.local/share/opencode/opencode.db" });
});
