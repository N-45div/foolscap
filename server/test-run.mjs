/**
 * One test run, read strictly enough to gate an automatic next prompt.
 *
 * `classifyRun` in outcome.mjs reads output text alone, which is fine for
 * labelling the archive and too weak for acting on: "Tests 0 passed (0)"
 * reads as a pass there. The queue only sends the next prompt on green,
 * so this reads the exit code first, then the runner's own counts, and
 * answers green only when both agree that tests ran and none failed.
 *
 * Anything unclear is "unknown", never green. That includes a run the
 * agent's sandbox stopped: on Windows, Codex's sandbox makes `node --test`
 * fail with `spawn EPERM` before any test code runs, which says nothing
 * about the code. The desktop app then runs the repo's own test command
 * itself, outside any sandbox, for the verdict that counts.
 */
import { leadingValidationKind } from "./outcome.mjs";

/** Shells agents wrap a command in; the command is the quoted argument. */
const WRAPPERS = [
  /^(?:"[^"]*[\\/])?(?:[^\s"']*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*-command\s+/i,
  /^(?:"[^"]*[\\/])?(?:[^\s"']*[\\/])?cmd(?:\.exe)?"?\s+\/[cs]\s+(?:\/[cs]\s+)?/i,
  /^(?:"[^"]*[\\/])?(?:[^\s"']*[\\/])?(?:ba|z)?sh(?:\.exe)?"?\s+-l?c\s+/i,
];

/** Launchers that run a tool by name: `npx vitest`, `uv run pytest`. */
const LAUNCHER = /^(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run|python3?\s+-m|py\s+-m)\s+/i;

/**
 * The validation kind of what a command actually runs, or null.
 *
 * A runner named inside a string is not a run: on 14 Oct a PowerShell
 * line that posted an issue whose text said "run node --test" read as a
 * green test run. So the wrapper shell is peeled off, quoted strings are
 * blanked, the line is split into its commands, and a runner counts only
 * when it starts one of them.
 */
export function runnerKind(command) {
  let text = String(command ?? "").trim();
  for (const wrapper of WRAPPERS) {
    if (wrapper.test(text)) {
      text = text.replace(wrapper, "").trim();
      const q = text[0];
      if ((q === "'" || q === '"') && text.at(-1) === q) text = text.slice(1, -1);
      break;
    }
  }
  const blanked = text.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
  for (const segment of blanked.split(/\r?\n|;|&&|\|\||\|/)) {
    const lead = segment
      .trim()
      .replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, "")
      .replace(LAUNCHER, "");
    const kind = leadingValidationKind(lead);
    if (kind) return kind;
  }
  return null;
}

/** Counts as each runner prints them. First match wins. */
const COUNTERS = [
  // node --test (spec and TAP reporters)
  (t) => {
    const total = t.match(/^[ℹ#]\s*tests\s+(\d+)/m);
    if (!total) return null;
    const pass = t.match(/^[ℹ#]\s*pass\s+(\d+)/m);
    const fail = t.match(/^[ℹ#]\s*fail\s+(\d+)/m);
    return { total: +total[1], passed: pass ? +pass[1] : 0, failed: fail ? +fail[1] : 0 };
  },
  // jest: "Tests:       1 failed, 2 passed, 3 total"
  (t) => {
    const m = t.match(/^Tests:\s+(.*\d+ total)/m);
    if (!m) return null;
    return {
      total: +m[1].match(/(\d+) total/)[1],
      passed: +(m[1].match(/(\d+) passed/)?.[1] ?? 0),
      failed: +(m[1].match(/(\d+) failed/)?.[1] ?? 0),
    };
  },
  // vitest: "Tests  1 failed | 2 passed (3)"
  (t) => {
    const m = t.match(/^\s*Tests\s+(.*)\((\d+)\)\s*$/m);
    if (!m) return null;
    return {
      total: +m[2],
      passed: +(m[1].match(/(\d+) passed/)?.[1] ?? 0),
      failed: +(m[1].match(/(\d+) failed/)?.[1] ?? 0),
    };
  },
  // cargo test: "test result: ok. 3 passed; 0 failed;"
  (t) => {
    const m = t.match(/test result: \w+\. (\d+) passed; (\d+) failed/);
    return m ? { total: +m[1] + +m[2], passed: +m[1], failed: +m[2] } : null;
  },
  // pytest summary line: "=== 2 passed, 1 failed in 0.12s ==="
  (t) => {
    const m = t.match(/^=+ (.*\d+ (?:passed|failed).*) in [\d.]+s/m);
    if (!m) return null;
    const passed = +(m[1].match(/(\d+) passed/)?.[1] ?? 0);
    const failed = +(m[1].match(/(\d+) failed/)?.[1] ?? 0) + +(m[1].match(/(\d+) errors?/)?.[1] ?? 0);
    return { total: passed + failed, passed, failed };
  },
  // phpunit: "OK (3 tests, 5 assertions)" / "Tests: 3, Assertions: 5, Failures: 1."
  (t) => {
    const ok = t.match(/^OK \((\d+) tests?/m);
    if (ok) return { total: +ok[1], passed: +ok[1], failed: 0 };
    const m = t.match(/^Tests: (\d+), Assertions: \d+(?:, Errors: (\d+))?(?:, Failures: (\d+))?/m);
    if (!m) return null;
    const failed = +(m[2] ?? 0) + +(m[3] ?? 0);
    return { total: +m[1], passed: +m[1] - failed, failed };
  },
  // mocha / playwright: "3 passing", "1 failing" / "3 passed", "1 failed"
  (t) => {
    const pass = t.match(/^\s*(\d+) pass(?:ing|ed)\b/m);
    const fail = t.match(/^\s*(\d+) fail(?:ing|ed)\b/m);
    if (!pass && !fail) return null;
    const passed = pass ? +pass[1] : 0;
    const failed = fail ? +fail[1] : 0;
    return { total: passed + failed, passed, failed };
  },
];

/** Runner output that means nothing ran, whatever the exit code says. */
const NOTHING_RAN = /\b(no tests? (?:found|ran|to run)|no test files found|collected 0 items|ran 0 tests|0 tests? total)\b/i;

/** The agent's sandbox stopped the run before it could say anything. */
const SANDBOX_BLOCKED = /\bspawn EPERM\b|\bcode: 'EPERM'|\bAccess is denied\b|\bOperation not permitted\b|\bsandbox(?:ed)? (?:denied|blocked)\b/i;

/** The runner's own counts, or null when it printed none we know. */
export function testCounts(output) {
  const text = String(output ?? "");
  for (const read of COUNTERS) {
    const counts = read(text);
    if (counts) return counts;
  }
  return null;
}

/** Claude Code prefixes a failed command's result with "Exit code N". */
export function claudeExitCode(content, isError) {
  const text = Array.isArray(content)
    ? content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("\n")
    : String(content ?? "");
  const m = text.match(/^Exit code (\d+)/);
  if (m) return +m[1];
  // A clean result carries no prefix; an error without one never ran
  // (a permission denial, say), so its exit code is unknown.
  return isError ? null : 0;
}

/**
 * Read one run. `exitCode` is null when unknown. Returns
 * `{ kind, verdict, exitCode, counts, reason }` with verdict one of
 * "green" | "red" | "unknown"; `kind` is null for non-validation commands.
 */
export function readTestRun({ command, output, exitCode = null, kind: knownKind = null }) {
  // A caller that ran the repo's test command itself already knows the kind.
  const kind = knownKind ?? runnerKind(command);
  const text = String(output ?? "");
  const counts = testCounts(text);
  const result = (verdict, reason) => ({ kind, verdict, exitCode, counts, reason });
  if (!kind) return result("unknown", "not a test or build command");

  // A run that exited 0 and counted its own passing tests has proved itself.
  // Real suites print "Operation not permitted" or "no tests found" in tests
  // of their own that pass, so those words only count without that proof.
  const proven = exitCode === 0 && counts?.total > 0 && counts.passed > 0 && counts.failed === 0;
  if (SANDBOX_BLOCKED.test(text) && !proven) return result("unknown", "the agent's sandbox blocked the run");
  if (exitCode === null) {
    if (counts?.failed > 0) return result("red", `${counts.failed} of ${counts.total} failed`);
    return result("unknown", "exit code not reported");
  }
  if (exitCode !== 0) return result("red", `exit code ${exitCode}`);
  if (kind === "build") return result("green", "exit code 0");
  if (NOTHING_RAN.test(text) && !proven) return result("unknown", "no tests ran");
  if (!counts) return result("green", "exit code 0 (test count not printed)");
  if (counts.total === 0 || counts.passed + counts.failed === 0) return result("unknown", "no tests ran");
  if (counts.failed > 0) return result("red", `${counts.failed} of ${counts.total} failed`);
  return result("green", `${counts.passed}/${counts.total} passed`);
}
