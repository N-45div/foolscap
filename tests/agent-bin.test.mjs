import { test } from "node:test";
import assert from "node:assert/strict";
import { win32, posix } from "node:path";
import { agentEnv, resolveAgentBinary, unwrapCmdShim } from "../server/agent-bin.mjs";

const { join } = win32;

// The shim npm wrote for Claude Code 2.1.289 on Windows, verbatim.
const CLAUDE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

const NODE_SHIM = `@ECHO off
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\cli.js" %*
`;

const fakeFs = (files) => ({
  exists: (p) => p in files,
  read: (p) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  },
});

test("an npm shim that wraps a native exe resolves to the exe itself", () => {
  const npm = "C:\\Users\\you\\AppData\\Roaming\\npm";
  const exe = join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const fs = fakeFs({ [join(npm, "claude.cmd")]: CLAUDE_SHIM, [exe]: "" });
  const found = resolveAgentBinary("claude", { env: { Path: npm, USERPROFILE: "C:\\Users\\you" }, platform: "win32", ...fs });
  assert.deepEqual(found, { command: exe, args: [], via: "shim" });
});

test("a node-script shim resolves to node plus the script", () => {
  const npm = "C:\\npm";
  const script = join(npm, "node_modules", "opencode-ai", "bin", "cli.js");
  const node = join("C:\\node", "node.exe");
  const shim = join(npm, "opencode.cmd");
  assert.deepEqual(unwrapCmdShim(shim, { ...fakeFs({ [shim]: NODE_SHIM, [script]: "" }), node }), {
    command: node,
    args: [script],
  });
});

test("a native installer outside PATH is still found", () => {
  const codex = join("C:\\Users\\you\\AppData\\Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  const found = resolveAgentBinary("codex", {
    env: { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\you", LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local" },
    platform: "win32",
    ...fakeFs({ [codex]: "" }),
  });
  assert.equal(found?.command, codex);
});

test("an exe on PATH wins over a shim later on PATH", () => {
  const fs = fakeFs({ [join("C:\\a", "codex.exe")]: "", [join("C:\\b", "codex.cmd")]: "@echo off" });
  const found = resolveAgentBinary("codex", { env: { PATH: "C:\\a;C:\\b" }, platform: "win32", ...fs });
  assert.equal(found?.via, "exe");
});

test("a shim we cannot read through falls back to cmd.exe", () => {
  const shim = join("C:\\npm", "gemini.cmd");
  const found = resolveAgentBinary("gemini", { env: { PATH: "C:\\npm" }, platform: "win32", ...fakeFs({ [shim]: "@echo off\r\nweird" }) });
  assert.deepEqual(found, { command: "cmd.exe", args: ["/d", "/s", "/c", shim], via: "cmd" });
});

test("a missing agent resolves to null", () => {
  assert.equal(resolveAgentBinary("claude", { env: { PATH: "/usr/bin", HOME: "/home/you" }, platform: "linux", ...fakeFs({ [posix.join("/opt", "claude")]: "" }) }), null);
});

test("agents never inherit API keys or nesting markers, whatever their case", () => {
  const env = agentEnv({
    PATH: "x",
    ANTHROPIC_API_KEY: "sk-ant",
    openai_api_key: "sk-proj",
    CODEX_API_KEY: "k",
    CLAUDECODE: "1",
    CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe",
  });
  assert.deepEqual(env, { PATH: "x", CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe" });
});
