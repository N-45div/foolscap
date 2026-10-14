/**
 * Agents that speak ACP, the Agent Client Protocol, over stdio.
 *
 * ACP is the universal connector: one client implementation drives any
 * agent that speaks it — coding agents (OpenCode, Gemini CLI, Goose…)
 * and personal assistants alike (Hermes and OpenClaw both ship an `acp`
 * mode whose permission requests carry real approvals). This module
 * knows how to launch them and how to record what they said.
 *
 * Claude Code and Codex have native drivers (drivers/claude.mjs,
 * drivers/codex-exec.mjs) that run the user's own CLI on their own
 * login. Their ACP adapters are listed too, for people who bring an API
 * key: the adapters authenticate through SDKs whose terms do not cover
 * routing a personal subscription through someone else's app.
 */
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where recorded sessions land — a first-class archive source. */
export const acpArchiveDir = () => join(homedir(), ".foolscap", "acp");

/**
 * Agents that speak ACP over stdio, by short name. Adapters fetched with
 * npx are pinned, so a launch is the version that was reviewed.
 */
export const AGENTS = {
  claude: {
    label: "claude code (API key)",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.90.0"],
  },
  codex: {
    label: "codex (API key)",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.2.2"],
  },
  gemini: { label: "gemini cli", command: "gemini", args: ["--acp"] },
  opencode: { label: "opencode", command: "opencode", args: ["acp"] },
  goose: { label: "goose", command: "goose", args: ["acp"] },
  qwen: { label: "qwen code", command: "qwen", args: ["--acp"] },
  kimi: { label: "kimi cli", command: "kimi", args: ["acp"] },
  copilot: { label: "github copilot cli", command: "copilot", args: ["--acp"] },
  kiro: { label: "kiro", command: "kiro-cli", args: ["acp"] },
  // Personal assistants: their ACP side relays approvals to the client.
  hermes: { label: "hermes agent", command: "hermes", args: ["acp"] },
  openclaw: { label: "openclaw", command: "openclaw", args: ["acp"] },
  // Antigravity CLI (`agy`) has no ACP mode of its own; this is the
  // community adapter. Its README notes Google's FAQ treats third-party
  // access as a terms-of-service violation — the user's call.
  antigravity: { label: "antigravity cli", command: "npx", args: ["-y", "agy-acp"] },
};

/**
 * Resolve an agent key, or a raw command line, into a launch spec.
 * A raw command is labelled by its script or binary name, so
 * "node tests/fake-acp-agent.mjs" reads as "fake-acp-agent".
 */
export function resolveAgent(agent) {
  if (AGENTS[agent]) {
    // FOOLSCAP_ACP_HERMES="…" swaps the launch command for a known
    // agent — a custom install, a wrapper, a pinned version — while it
    // keeps its name everywhere it's shown.
    const override = process.env[`FOOLSCAP_ACP_${agent.toUpperCase()}`];
    if (override) {
      const parts = override.trim().split(/\s+/);
      return { label: AGENTS[agent].label, command: parts[0], args: parts.slice(1) };
    }
    return AGENTS[agent];
  }
  const parts = String(agent).trim().split(/\s+/);
  const named = parts.length > 1 ? parts.at(-1) : parts[0];
  const label =
    named
      .split(/[\\/]/)
      .pop()
      .replace(/\.[a-z]+$/i, "") || String(agent);
  return { label, command: parts[0], args: parts.slice(1) };
}

/**
 * Launch an agent as a child process.
 *
 * A resolved executable is spawned directly everywhere (see
 * agent-bin.mjs). An unresolved Windows `.cmd` shim still needs a
 * shell, and a shell handed a *separate* args array concatenates them
 * unescaped (Node's DEP0190), so for that case alone we build one
 * command string and quote every argument ourselves.
 */
export function spawnAgent(spec, cwd, env = process.env) {
  const stdio = ["pipe", "pipe", "pipe"];
  // Agents that read $PWD (as Claude Code does) must see the launch
  // directory there, not the shell foolscap happened to start from.
  const childEnv = { ...env, PWD: cwd };
  delete childEnv.OLDPWD;
  if (process.platform !== "win32" || /\.exe$/i.test(spec.command)) {
    return spawn(spec.command, spec.args, { cwd, stdio, env: childEnv, windowsHide: true });
  }
  const quote = (a) => `"${String(a).replaceAll('"', '\\"')}"`;
  const line = [spec.command, ...spec.args.map(quote)].join(" ");
  return spawn(line, { cwd, stdio, env: childEnv, shell: true, windowsHide: true });
}

/**
 * A recorder writes one line per frame, plus a header. It is
 * append-only and never blocks the session: a failed write loses the
 * recording, never the work.
 */
export class Recorder {
  constructor(file, header) {
    this.file = file;
    this.queue = appendFile(file, JSON.stringify(header) + "\n").catch(
      () => {},
    );
  }
  frame(dir, msg) {
    const line =
      JSON.stringify({ t: new Date().toISOString(), dir, msg }) + "\n";
    // Serialize appends so frames keep their order on disk.
    this.queue = this.queue.then(() =>
      appendFile(this.file, line).catch(() => {}),
    );
  }
}
