/**
 * Checking a turn with the repo's own tests, run by foolscap itself.
 *
 * An agent's own test run is evidence, not proof: it can skip the run,
 * run the wrong suite, or be stopped by its sandbox (on Windows, Codex's
 * sandbox makes `node --test` fail with spawn EPERM before any test code
 * runs). So after a turn, foolscap runs the repo's test command outside
 * any sandbox and reads the result strictly (test-run.mjs). That verdict
 * is the one the next-prompt queue trusts.
 *
 * The command comes from `.foolscap.json` (`{"test": "…"}`) when the repo
 * has one, else from what the repo is: a package.json test script run by
 * the package manager its lockfile names, Cargo, Go, or pytest.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentEnv } from "./agent-bin.mjs";
import { terminateProcessTree } from "./drivers/process.mjs";
import { readTestRun } from "./test-run.mjs";

const NPM_PLACEHOLDER = /no test specified/i;

/** The package manager the repo's lockfile names: npm, pnpm, yarn or bun. */
export function packageManager(cwd, { exists = existsSync } = {}) {
  if (exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(join(cwd, "yarn.lock"))) return "yarn";
  if (exists(join(cwd, "bun.lock")) || exists(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

/** The command that tests this repo, as `{ line, source }`, or null. */
export async function testCommandFor(cwd, { exists = existsSync, read = (p) => readFile(p, "utf8") } = {}) {
  try {
    const config = JSON.parse(await read(join(cwd, ".foolscap.json")));
    if (typeof config.test === "string" && config.test.trim()) return { line: config.test.trim(), source: ".foolscap.json" };
  } catch {
    // no config, or not JSON: fall through to detection
  }
  try {
    const pkg = JSON.parse(await read(join(cwd, "package.json")));
    const script = pkg.scripts?.test;
    if (typeof script === "string" && script.trim() && !NPM_PLACEHOLDER.test(script)) {
      // `bun test` is Bun's own runner, not the script.
      const manager = packageManager(cwd, { exists });
      return { line: `${manager === "bun" ? "bun run" : manager} test`, source: "package.json" };
    }
  } catch {
    // no package.json
  }
  if (exists(join(cwd, "Cargo.toml"))) return { line: "cargo test", source: "Cargo.toml" };
  if (exists(join(cwd, "go.mod"))) return { line: "go test ./...", source: "go.mod" };
  if (["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some((f) => exists(join(cwd, f)))) {
    return { line: "python -m pytest -q", source: "python project" };
  }
  return null;
}

/** Keep the end of long output: the summary lines live there. */
const TAIL = 200_000;

/**
 * Run the repo's tests. Resolves to the read run plus `{ line, source,
 * durationMs }`, or null when the repo has no test command we can find.
 */
export async function verifyRepo(cwd, { timeoutMs = 10 * 60_000, command } = {}) {
  const found = command ? { line: command, source: "given" } : await testCommandFor(cwd);
  if (!found) return null;
  const started = Date.now();
  const { output, exitCode, timedOut } = await new Promise((resolve) => {
    // The line is the repo's own (its config or its manifest), so it runs
    // through the platform shell the way the repo's owner would run it.
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${found.line}"`], { cwd, env: agentEnv(process.env, { CI: "1" }), windowsHide: true, windowsVerbatimArguments: true })
      : spawn("sh", ["-c", found.line], { cwd, env: agentEnv(process.env, { CI: "1" }) });
    let out = "";
    const keep = (chunk) => {
      out += chunk.toString("utf8");
      if (out.length > TAIL * 2) out = out.slice(-TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      resolve({ output: out.slice(-TAIL), exitCode: null, timedOut: true });
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ output: out.slice(-TAIL), exitCode: null, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output: out.slice(-TAIL), exitCode: code, timedOut: false });
    });
  });
  const run = readTestRun({ command: found.line, output, exitCode, kind: "test" });
  return {
    ...run,
    reason: timedOut ? `no result after ${Math.round(timeoutMs / 60_000)} min` : run.reason,
    line: found.line,
    source: found.source,
    durationMs: Date.now() - started,
    outputTail: output.slice(-2_000),
  };
}
