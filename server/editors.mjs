/**
 * Opening a task's folder in the person's editor, so several tasks can
 * each have their own editor window, side by side.
 *
 * VS Code and its forks (Cursor, Windsurf, Antigravity) ship the same
 * launcher. On Windows it is a `.cmd` that runs the editor's own exe on
 * its `cli.js` with ELECTRON_RUN_AS_NODE=1:
 *
 *   "%~dp0..\Code.exe" "%~dp0..\resources\app\out\cli.js" %*
 *
 * foolscap runs exactly that, with an argument array and no shell, the
 * way agent-bin.mjs launches agents. The launcher is found on PATH or in
 * the editor's default install folder; on Linux it is a program on PATH.
 *
 * The editor starts detached and never sees foolscap's own VSCODE_* or
 * ELECTRON_* variables: started from a VS Code terminal, those would send
 * the request to that VS Code window, or run the editor as plain Node.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

/** The editors foolscap knows, in menu order. `win` paths are under an install root. */
export const EDITORS = [
  { id: "vscode", label: "VS Code", names: ["code"], win: ["Microsoft VS Code\\bin\\code.cmd"] },
  { id: "cursor", label: "Cursor", names: ["cursor"], win: ["cursor\\resources\\app\\bin\\cursor.cmd"] },
  { id: "windsurf", label: "Windsurf", names: ["windsurf"], win: ["Windsurf\\bin\\windsurf.cmd"] },
  { id: "antigravity", label: "Antigravity", names: ["antigravity-ide", "antigravity"], win: ["Antigravity IDE\\bin\\antigravity-ide.cmd", "Antigravity\\bin\\antigravity.cmd"] },
  { id: "zed", label: "Zed", names: ["zed", "zeditor"], win: [] },
];

/** Windows env names are case-insensitive; a copied env object is not. */
function lookup(env, key) {
  const hit = Object.keys(env).find((k) => k.toUpperCase() === key);
  return hit === undefined ? undefined : env[hit];
}

/**
 * The editor exe and cli.js a VS Code-style `.cmd` launcher runs, or null
 * when the text is not that launcher or either file is missing.
 */
export function readLauncher(shimPath, { read = readFileSync, exists = existsSync } = {}) {
  let text;
  try {
    text = read(shimPath, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/"%~dp0([^"]+?\.exe)"\s+"%~dp0([^"]+?\.js)"/i);
  if (!m) return null;
  const dir = win32.dirname(shimPath);
  const exe = win32.resolve(dir, m[1]);
  const cli = win32.resolve(dir, m[2]);
  if (!exists(exe) || !exists(cli)) return null;
  return { command: exe, args: [cli], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** How to launch one editor here: `{ command, args, env }`, or null when it is not installed. */
export function resolveEditor(editor, { env = process.env, platform = process.platform, exists = existsSync, read = readFileSync } = {}) {
  const { join, delimiter } = platform === "win32" ? win32 : posix;
  const dirs = (lookup(env, "PATH") ?? "").split(delimiter).filter(Boolean);
  if (platform !== "win32") {
    for (const name of editor.names) {
      for (const dir of dirs) {
        const candidate = join(dir, name);
        if (exists(candidate)) return { command: candidate, args: [], env: {} };
      }
    }
    return null;
  }
  for (const name of editor.names) {
    for (const dir of dirs) {
      const launcher = readLauncher(join(dir, `${name}.cmd`), { read, exists });
      if (launcher) return launcher;
      const exe = join(dir, `${name}.exe`);
      if (exists(exe)) return { command: exe, args: [], env: {} };
    }
  }
  const roots = [
    join(lookup(env, "LOCALAPPDATA") ?? join(lookup(env, "USERPROFILE") ?? "", "AppData", "Local"), "Programs"),
    lookup(env, "PROGRAMFILES"),
  ].filter(Boolean);
  for (const root of roots) {
    for (const rel of editor.win) {
      const launcher = readLauncher(join(root, rel), { read, exists });
      if (launcher) return launcher;
    }
  }
  return null;
}

/** The editors installed here, as `{ id, label }`. */
export function installedEditors(opts) {
  return EDITORS.filter((editor) => resolveEditor(editor, opts)).map(({ id, label }) => ({ id, label }));
}

/** foolscap's environment without the VSCODE_* and ELECTRON_* variables, plus `extra`. */
export function editorEnv(base = process.env, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^(VSCODE_|ELECTRON_)/i.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Open `folder` in the editor `id`. Resolves once the launcher has started. */
export function openInEditor(id, folder, { spawnFn = spawn, ...opts } = {}) {
  const editor = EDITORS.find((e) => e.id === id);
  if (!editor) return Promise.reject(new Error(`unknown editor: ${id}`));
  const spec = resolveEditor(editor, opts);
  if (!spec) return Promise.reject(new Error(`${editor.label} is not installed`));
  return new Promise((resolve, reject) => {
    const child = spawnFn(spec.command, [...spec.args, folder], {
      cwd: folder,
      env: editorEnv(opts.env ?? process.env, spec.env),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (err) => reject(new Error(`could not start ${editor.label}: ${err.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve({ editor: editor.label });
    });
  });
}
