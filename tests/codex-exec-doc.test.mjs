import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexExecBuilder } from "../server/codex-exec-doc.mjs";
import { evidenceReportFor } from "../server/fleet.mjs";

const at = "2026-10-14T09:00:00.000Z";

// Events in the shape Codex 0.141.0 printed on Windows 11 (14 Oct 2026).
const turn = [
  ["c2a", { type: "prompt", text: "Run node --test once" }],
  ["a2c", { type: "thread.started", thread_id: "01a139a0-a3eb-7443-bd72-5711e569dd7a" }],
  ["a2c", { type: "turn.started" }],
  ["a2c", { type: "item.started", item: { id: "item_1", type: "command_execution", command: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'node --test'", status: "in_progress" } }],
  ["a2c", { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'node --test'", aggregated_output: "ℹ tests 1\nℹ pass 0\nℹ fail 1\n", exit_code: 1, status: "failed" } }],
  ["a2c", { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Failed." } }],
  ["a2c", { type: "turn.completed", usage: { input_tokens: 35226, cached_input_tokens: 21248, output_tokens: 96 } }],
];

test("a codex exec turn becomes one cell with the command row and the reply", () => {
  const b = new CodexExecBuilder();
  for (const [dir, msg] of turn) b.feed(dir, msg, at);
  assert.equal(b.cells.length, 1);
  const [cell] = b.cells;
  assert.equal(cell.prompt, "Run node --test once");
  const tool = cell.parts.find((p) => p.kind === "tool").tool;
  assert.equal(tool.name, "execute");
  assert.equal(tool.exitCode, 1);
  assert.equal(tool.isError, true);
  assert.ok(cell.parts.some((p) => p.kind === "text" && p.text === "Failed."));
  assert.equal(b.totalOutputTokens, 96);
  assert.equal(b.activity, null);
});

test("each changed file is an edit, so evidence counts it and stales older runs", () => {
  const b = new CodexExecBuilder();
  for (const [dir, msg] of turn.slice(0, 5)) b.feed(dir, msg, at);
  b.feed("a2c", { type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: "math.mjs", kind: "update" }, { path: "README.md", kind: "update" }], status: "completed" } }, at);
  const report = evidenceReportFor(b.current);
  assert.equal(report.evidence.edited, 2);
  assert.equal(report.validations.length, 0);
});
