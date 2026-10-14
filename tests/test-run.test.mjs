import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeExitCode, readTestRun, runnerKind, testCounts } from "../server/test-run.mjs";

// Real tool results from Claude Code 2.1.289 and Codex 0.141.0 on Windows 11,
// both running `node --test` against a repo with one failing test (14 Oct 2026).
const CLAUDE_FAILED =
  "Exit code 1\n✖ adds two numbers (0.8833ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 69.446\n\n✖ failing tests:\n\ntest at math.test.mjs:5:1\n✖ adds two numbers (0.8833ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  \n  -1 !== 5\n";
const CODEX_SANDBOXED = {
  command: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'node --test'",
  exit_code: 1,
  aggregated_output:
    "✖ math.test.mjs (1.9288ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 10.873\n\n✖ failing tests:\n\ntest at math.test.mjs:1:1\n✖ math.test.mjs (1.9288ms)\n  Error: spawn EPERM\n      at ChildProcess.spawn (node:internal/child_process:421:11)\n  {\n    errno: -4048,\n    code: 'EPERM',\n    syscall: 'spawn'\n  }\n",
};
const NODE_GREEN = "✔ adds two numbers (0.6ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\n";

test("a real Claude Code failure reads red, with its exit code and counts", () => {
  const run = readTestRun({ command: "node --test", output: CLAUDE_FAILED, exitCode: claudeExitCode(CLAUDE_FAILED, true) });
  assert.equal(run.verdict, "red");
  assert.equal(run.exitCode, 1);
  assert.deepEqual(run.counts, { total: 1, passed: 0, failed: 1 });
});

test("a run Codex's Windows sandbox blocked is unknown, not red", () => {
  const run = readTestRun({
    command: CODEX_SANDBOXED.command,
    output: CODEX_SANDBOXED.aggregated_output,
    exitCode: CODEX_SANDBOXED.exit_code,
  });
  assert.equal(run.verdict, "unknown");
  assert.match(run.reason, /sandbox/);
});

test("green needs exit code 0 and at least one test that ran", () => {
  assert.equal(readTestRun({ command: "node --test", output: NODE_GREEN, exitCode: 0 }).verdict, "green");
  assert.equal(readTestRun({ command: "node --test", output: NODE_GREEN, exitCode: null }).verdict, "unknown");
});

test("zero tests is never green, whichever runner says it", () => {
  for (const output of [
    " Test Files  0 passed (0)\n      Tests  0 passed (0)\n",
    "ℹ tests 0\nℹ pass 0\nℹ fail 0\n",
    "No tests found, exiting with code 0\n",
    "collected 0 items\n",
  ]) {
    assert.equal(readTestRun({ command: "npx vitest run", output, exitCode: 0 }).verdict, "unknown", output);
  }
});

test("runners the old classifier missed are recognised", () => {
  for (const command of ["node --test", "bun test", "npx playwright test", "npm t", "deno test"]) {
    assert.notEqual(readTestRun({ command, output: "", exitCode: 0 }).kind, null, command);
  }
});

test("counts come from each runner's own summary line", () => {
  assert.deepEqual(testCounts("Tests:       1 failed, 2 passed, 3 total"), { total: 3, passed: 2, failed: 1 });
  assert.deepEqual(testCounts("      Tests  1 failed | 2 passed (3)"), { total: 3, passed: 2, failed: 1 });
  assert.deepEqual(testCounts("test result: ok. 3 passed; 0 failed; 0 ignored"), { total: 3, passed: 3, failed: 0 });
  assert.deepEqual(testCounts("===== 2 passed, 1 failed in 0.12s ====="), { total: 3, passed: 2, failed: 1 });
  assert.deepEqual(testCounts("OK (3 tests, 5 assertions)"), { total: 3, passed: 3, failed: 0 });
  assert.deepEqual(testCounts("  3 passing (12ms)\n  1 failing"), { total: 4, passed: 3, failed: 1 });
});

// The PowerShell line a test agent ran on 14 Oct: it posted an issue whose
// text mentioned `node --test`, and the old reader counted it as a green run.
test("a runner named inside a string is not a test run", () => {
  const posted =
    "$tok = (Get-Content -Raw \"$env:USERPROFILE\\.api-token\") -replace '\\s',''; curl.exe -s --data-urlencode \"title=Fix math.mjs, then run node --test once\" https://example.invalid/issues";
  const run = readTestRun({ command: posted, output: "{\"iid\":1}", exitCode: 0 });
  assert.equal(run.kind, null);
  assert.equal(run.verdict, "unknown");
});

test("a runner still counts after cd, env vars, launchers and wrapper shells", () => {
  assert.equal(runnerKind("cd api && npm test"), "test");
  assert.equal(runnerKind("CI=1 pnpm vitest run"), "test");
  assert.equal(runnerKind("npx vitest run"), "test");
  assert.equal(runnerKind("uv run pytest -q"), "test");
  assert.equal(runnerKind("\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'node --test'"), "test");
  assert.equal(runnerKind("bash -lc 'go test ./...'"), "test");
  assert.equal(runnerKind("echo \"npm test\""), null);
});

test("go test has no counts, so its exit code decides", () => {
  assert.equal(readTestRun({ command: "go test ./...", output: "ok  \texample.com/m\t0.01s", exitCode: 0 }).verdict, "green");
  assert.equal(readTestRun({ command: "go test ./...", output: "FAIL\texample.com/m\t0.01s", exitCode: 1 }).verdict, "red");
});

test("a denied command has no exit code; a clean Claude result is exit 0", () => {
  assert.equal(claudeExitCode("This PowerShell command contains multiple operations.", true), null);
  assert.equal(claudeExitCode(NODE_GREEN, false), 0);
  assert.equal(claudeExitCode([{ type: "text", text: "Exit code 2\nboom" }], true), 2);
});
