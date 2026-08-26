/**
 * The outcome engine decides whether foolscap will tell you a prompt
 * worked. It must never flatter: a claim in prose is not evidence, a
 * suite that printed failures is not a pass, and work the user took
 * back is not a success no matter how green the tests were.
 *
 *   node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, segmentsFor } from "../server/outcome.mjs";

const seg = (tools, next = null) => ({ text: "p", at: undefined, tools, next });
const tool = (command, result, isError = false) => ({
  name: "Bash",
  input: { command },
  result,
  isError,
});

test("tests that pass are evidence", () => {
  const v = judge(seg([tool("pnpm vitest run", "Tests  11 passed (11)")]));
  assert.equal(v.verdict, "verified");
  assert.equal(v.passed, true);
});

test("a successful commit is evidence", () => {
  const v = judge(
    seg([tool("git commit -m 'fix'", "[main 1c08e25] fix\n 1 file changed")]),
  );
  assert.equal(v.verdict, "verified");
  assert.equal(v.committed, true);
});

test("prose claiming success is NOT evidence", () => {
  // The agent says the suite is green but never ran it.
  const v = judge(seg([tool("cat README.md", "All tests pass, everything works")]));
  assert.equal(v.verdict, "unknown");
  assert.equal(v.passed, false);
});

test("a run that printed failures is never a pass", () => {
  // Mixed output: one file green, another red. Must not read as verified.
  const v = judge(
    seg([tool("pnpm test", "Test Files  1 passed\n 2 failed\nFAILED tests/a.ts")]),
  );
  assert.equal(v.verdict, "rocky");
  assert.equal(v.passed, false);
});

test("a correction outranks green tests", () => {
  const v = judge(
    seg([tool("pnpm test", "42 passed")], "no, that broke the reconnect path"),
  );
  assert.equal(v.verdict, "corrected");
});

test("correction detection does not fire on ordinary follow-ups", () => {
  const ordinary = [
    "now add a test for the empty case",
    "nice — can you also update the README?",
    "notify me when the deploy finishes",
    "revertible migrations would be good here",
  ];
  for (const next of ordinary) {
    const v = judge(seg([tool("pnpm test", "9 passed")], next));
    assert.equal(v.verdict, "verified", `false positive on: ${next}`);
  }
});

test("real corrections are caught", () => {
  const corrections = [
    "no, that's wrong",
    "nope, still failing",
    "that didn't work",
    "revert that",
    "it's still broken",
    "you broke the build",
  ];
  for (const next of corrections) {
    const v = judge(seg([tool("pnpm test", "9 passed")], next));
    assert.equal(v.verdict, "corrected", `missed correction: ${next}`);
  }
});

test("errored tool calls make a segment rocky, not verified", () => {
  const v = judge(seg([tool("pnpm build", "error TS2352: bad cast", true)]));
  assert.equal(v.verdict, "rocky");
  assert.equal(v.errors, 1);
});

test("no evidence either way is unknown", () => {
  assert.equal(judge(seg([])).verdict, "unknown");
  assert.equal(judge(seg([tool("ls", "a.txt b.txt")])).verdict, "unknown");
});

test("codex argv-array commands are read", () => {
  const v = judge(
    seg([
      { name: "shell", input: { command: ["bash", "-lc", "cargo test"] }, result: "test result: ok. 12 passed", isError: false },
    ]),
  );
  assert.equal(v.verdict, "verified");
});

// ── Segmentation ─────────────────────────────────────────────────────

test("claude segmentation pairs tools and carries the next prompt", () => {
  const lines = [
    JSON.stringify({ type: "user", timestamp: "t1", message: { role: "user", content: "make the tests pass" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "Bash", input: { command: "pnpm test" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "7 passed" }] } }),
    JSON.stringify({ type: "user", timestamp: "t2", message: { role: "user", content: "no, that's wrong" } }),
  ];
  const segments = segmentsFor("claude", lines);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].tools.length, 1);
  assert.equal(segments[0].tools[0].result, "7 passed");
  assert.equal(segments[0].next, "no, that's wrong");
  assert.equal(judge(segments[0]).verdict, "corrected");
});

test("claude segmentation ignores subagent sidechains", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "real prompt" } }),
    JSON.stringify({ isSidechain: true, type: "user", message: { role: "user", content: "subagent task prompt" } }),
  ];
  assert.equal(segmentsFor("claude", lines).length, 1);
});

test("dsh segmentation reads events and pairs by callId", () => {
  const lines = [
    JSON.stringify({ type: "session", version: 1, id: "x", cwd: "/tmp" }),
    JSON.stringify({ type: "user/message", seq: 1, time: 1, data: { message: { content: "fix the queue" } } }),
    JSON.stringify({ type: "tool/call", seq: 2, time: 2, data: { callId: "c1", name: "bash", arguments: JSON.stringify({ command: "pytest" }) } }),
    JSON.stringify({ type: "tool/result", seq: 3, time: 3, data: { callId: "c1", message: { content: "5 passed" } } }),
  ];
  const segments = segmentsFor("dsh", lines);
  assert.equal(segments.length, 1);
  assert.equal(judge(segments[0]).verdict, "verified");
});

test("malformed lines never throw", () => {
  const lines = ["{not json", "", JSON.stringify({ type: "nonsense" })];
  for (const source of ["claude", "codex", "dsh"]) {
    assert.doesNotThrow(() => segmentsFor(source, lines));
  }
  assert.deepEqual(segmentsFor("unknown-harness", lines), []);
});
