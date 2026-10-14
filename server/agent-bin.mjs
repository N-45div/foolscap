/**
 * Finding an agent's real executable, and the environment it runs in.
 *
 * Windows is the hard case. Agents arrive as npm `.cmd` shims, native
 * installers that never touch PATH, or both. Node refuses to spawn a
 * `.cmd` without a shell, and a shell re-parses every argument. So we
 * look through the shim to the program it runs, usually a native
 * `.exe`, and spawn that directly with an argument array: no shell, no
 * quoting, no `%VAR%` expansion.
 *
 * The environment matters as much as the binary. An `ANTHROPIC_API_KEY`
 * or `OPENAI_API_KEY` in the parent silently switches an agent from the
 * user's subscription to pay-per-token API billing, so a launched agent
 * never sees one. Neither does it see the markers that make Claude Code
 * refuse to start inside another Claude Code session.
 */
import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Where native installers put agents without adding them to PATH. */
function extraDirs(name, env, platform) {
  const { join } = platform === "win32" ? win32 : posix;
  const home = env.USERPROFILE || env.HOME || "";
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    if (name === "claude") return [join(home, ".local", "bin")];
    if (name === "codex") return [join(local, "Programs", "OpenAI", "Codex", "bin")];
    return [];
  }
  if (name === "claude") return [join(home, ".local", "bin"), join(home, ".claude", "local")];
  return [join(home, ".local", "bin")];
}

/** Windows env names are case-insensitive; a copied env object is not. */
function lookup(env, key) {
  const hit = Object.keys(env).find((k) => k.toUpperCase() === key);
  return hit === undefined ? undefined : env[hit];
}

/**
 * The program an npm `.cmd` shim runs, or null.
 *
 * npm writes one of two shapes: a direct call to a bundled executable
 * (`"%dp0%\node_modules\…\claude.exe" %*`) or node plus a script
 * (`"%_prog%" "%dp0%\node_modules\…\cli.js" %*`).
 */
export function unwrapCmdShim(shimPath, { read = readFileSync, exists = existsSync, node = null } = {}) {
  let text;
  try {
    text = read(shimPath, "utf8");
  } catch {
    return null;
  }
  const dir = win32.dirname(shimPath);
  const local = (raw) => win32.resolve(dir, raw.replace(/^%~?dp0%?\\?/i, ""));
  const exe = text.match(/"(%~?dp0%?\\[^"]+\.exe)"/i);
  if (exe) {
    const path = local(exe[1]);
    if (exists(path)) return { command: path, args: [] };
  }
  const script = text.match(/"(%~?dp0%?\\[^"]+\.[cm]?js)"/i);
  if (script && node) {
    const path = local(script[1]);
    if (exists(path)) return { command: node, args: [path] };
  }
  return null;
}

/**
 * Resolve an agent name to `{ command, args, via }`, or null when it is
 * not installed. `via` says how it was found, for doctor-style reports.
 */
export function resolveAgentBinary(
  name,
  { env = process.env, platform = process.platform, exists = existsSync, read = readFileSync } = {},
) {
  const { join, delimiter } = platform === "win32" ? win32 : posix;
  const path = lookup(env, "PATH") ?? "";
  const dirs = [...path.split(delimiter).filter(Boolean), ...extraDirs(name, env, platform)];

  if (platform !== "win32") {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (exists(candidate)) return { command: candidate, args: [], via: "path" };
    }
    return null;
  }

  const node = dirs.map((d) => join(d, "node.exe")).find((p) => exists(p)) ?? null;
  for (const dir of dirs) {
    const exe = join(dir, `${name}.exe`);
    if (exists(exe)) return { command: exe, args: [], via: "exe" };
    const shim = join(dir, `${name}.cmd`);
    if (exists(shim)) {
      const inner = unwrapCmdShim(shim, { read, exists, node });
      if (inner) return { ...inner, via: "shim" };
      return { command: "cmd.exe", args: ["/d", "/s", "/c", shim], via: "cmd" };
    }
  }
  return null;
}

/** Variables a launched agent must never inherit (compared case-insensitively). */
export const STRIPPED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
];

/** A copy of `base` that is safe to hand to an agent. */
export function agentEnv(base = process.env, extra = {}) {
  const drop = new Set(STRIPPED_ENV);
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!drop.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ...extra };
}
