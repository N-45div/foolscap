import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EDITORS, editorEnv, installedEditors, openInEditor, readLauncher, resolveEditor } from "../server/editors.mjs";

const byId = (id) => EDITORS.find((e) => e.id === id);

// The launchers these editors installed on Windows (22 Oct 2026), verbatim lines.
const CODE_CMD = `@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\\Code.exe" "%~dp0..\\2d0b7506a3\\resources\\app\\out\\cli.js" %*
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
`;
const CURSOR_CMD = `@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\\..\\..\\Cursor.exe" "%~dp0..\\out\\cli.js" %*
endlocal
`;

const fakeFs = (files) => ({
  exists: (p) => p in files,
  read: (p) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  },
});

test("a VS Code launcher on PATH resolves to Code.exe running its cli.js as Node", () => {
  const bin = "C:\\Users\\you\\AppData\\Local\\Programs\\Microsoft VS Code\\bin";
  const fs = fakeFs({
    [`${bin}\\code.cmd`]: CODE_CMD,
    "C:\\Users\\you\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe": "",
    "C:\\Users\\you\\AppData\\Local\\Programs\\Microsoft VS Code\\2d0b7506a3\\resources\\app\\out\\cli.js": "",
  });
  const spec = resolveEditor(byId("vscode"), { env: { Path: `C:\\Windows;${bin}` }, platform: "win32", ...fs });
  assert.deepEqual(spec, {
    command: "C:\\Users\\you\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    args: ["C:\\Users\\you\\AppData\\Local\\Programs\\Microsoft VS Code\\2d0b7506a3\\resources\\app\\out\\cli.js"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
});

test("an editor missing from PATH is found in its default install folder", () => {
  const local = "C:\\Users\\you\\AppData\\Local";
  const app = `${local}\\Programs\\cursor`;
  const fs = fakeFs({
    [`${app}\\resources\\app\\bin\\cursor.cmd`]: CURSOR_CMD,
    [`${app}\\Cursor.exe`]: "",
    [`${app}\\resources\\app\\out\\cli.js`]: "",
  });
  const spec = resolveEditor(byId("cursor"), { env: { PATH: "C:\\Windows", LOCALAPPDATA: local }, platform: "win32", ...fs });
  assert.equal(spec.command, `${app}\\Cursor.exe`);
  assert.deepEqual(spec.args, [`${app}\\resources\\app\\out\\cli.js`]);
});

test("a launcher whose exe is gone, or a file that is not a launcher, is not an editor", () => {
  const bin = "C:\\Code\\bin";
  assert.equal(readLauncher(`${bin}\\code.cmd`, fakeFs({ [`${bin}\\code.cmd`]: CODE_CMD })), null);
  assert.equal(readLauncher(`${bin}\\code.cmd`, fakeFs({ [`${bin}\\code.cmd`]: "@echo off\r\nnode %*\r\n" })), null);
  assert.equal(readLauncher(`${bin}\\missing.cmd`, fakeFs({})), null);
});

test("on Linux an editor is the first of its names on PATH", () => {
  const fs = fakeFs({ "/usr/bin/zeditor": "", "/usr/share/code/bin/code": "" });
  assert.deepEqual(resolveEditor(byId("zed"), { env: { PATH: "/usr/local/bin:/usr/bin" }, platform: "linux", ...fs }), { command: "/usr/bin/zeditor", args: [], env: {} });
  assert.equal(resolveEditor(byId("vscode"), { env: { PATH: "/usr/bin" }, platform: "linux", ...fs }), null);
});

test("installedEditors lists only what resolves, in menu order", () => {
  const fs = fakeFs({ "/usr/bin/windsurf": "", "/usr/bin/code": "" });
  assert.deepEqual(installedEditors({ env: { PATH: "/usr/bin" }, platform: "linux", ...fs }), [
    { id: "vscode", label: "VS Code" },
    { id: "windsurf", label: "Windsurf" },
  ]);
});

test("the editor never inherits foolscap's VSCODE_* or ELECTRON_* variables", () => {
  const env = editorEnv({ PATH: "x", VSCODE_IPC_HOOK_CLI: "pipe", electron_run_as_node: "1", HOME: "/h" }, { ELECTRON_RUN_AS_NODE: "1" });
  assert.deepEqual(env, { PATH: "x", HOME: "/h", ELECTRON_RUN_AS_NODE: "1" });
});

test("openInEditor starts the launcher detached with the folder last", async () => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => (child.unrefed = true);
    queueMicrotask(() => child.emit("spawn"));
    calls.at(-1).child = child;
    return child;
  };
  const fs = fakeFs({ "/usr/bin/code": "" });
  const result = await openInEditor("vscode", "/work/task-1", { spawnFn, env: { PATH: "/usr/bin", VSCODE_PID: "1" }, platform: "linux", ...fs });
  assert.deepEqual(result, { editor: "VS Code" });
  assert.equal(calls[0].command, "/usr/bin/code");
  assert.deepEqual(calls[0].args, ["/work/task-1"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.env.VSCODE_PID, undefined);
  assert.equal(calls[0].child.unrefed, true);
});

test("openInEditor says plainly when the editor is not installed or unknown", async () => {
  await assert.rejects(openInEditor("cursor", "/w", { env: { PATH: "/usr/bin" }, platform: "linux", ...fakeFs({}) }), /Cursor is not installed/);
  await assert.rejects(openInEditor("notepad", "/w"), /unknown editor/);
});
