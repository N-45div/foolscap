/**
 * Run: one task's dev server, in the task's folder, on the task's PORT,
 * so two tasks can be tried side by side.
 *
 * The command is the repo's own: `.foolscap.json` `"run"`, else the
 * package.json `dev` script, else its `start` script, run by the package
 * manager the lockfile names. `$PORT`, `${PORT}` and `%PORT%` in it are
 * replaced with the number, and PORT is set too, for servers that read
 * it themselves. BROWSER=none stops a server opening a browser on its own.
 *
 * The preview link is the first local URL the server prints (dev servers
 * colour it, so ANSI codes are stripped first), else `localhost:PORT`
 * once that port answers.
 *
 * Stop ends the whole process tree, and waits for it: on Windows a
 * running server holds the task's folder open, so Merge and Discard stop
 * it before the worktree is removed.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentEnv } from "./agent-bin.mjs";
import { portBusy } from "./ports.mjs";
import { packageManager } from "./verify.mjs";

/** The command that runs this repo's dev server, as `{ line, source }`, or null. */
export async function runCommandFor(cwd, { exists = existsSync, read = (p) => readFile(p, "utf8") } = {}) {
  try {
    const config = JSON.parse(await read(join(cwd, ".foolscap.json")));
    if (typeof config.run === "string" && config.run.trim()) return { line: config.run.trim(), source: ".foolscap.json" };
  } catch {
    // no config, or not JSON: fall through to package.json
  }
  try {
    const scripts = JSON.parse(await read(join(cwd, "package.json"))).scripts ?? {};
    for (const name of ["dev", "start"]) {
      if (typeof scripts[name] === "string" && scripts[name].trim()) {
        return { line: `${packageManager(cwd, { exists })} run ${name}`, source: "package.json" };
      }
    }
  } catch {
    // no package.json
  }
  return null;
}

/** `line` with every `$PORT`, `${PORT}` and `%PORT%` replaced by `port`. */
export function withPort(line, port) {
  return port == null ? line : line.replace(/\$\{PORT\}|\$PORT\b|%PORT%/g, String(port));
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'`<>)\]]*)?/i;

/** The first local URL in a server's output, made clickable, or null. */
export function localUrlIn(text) {
  const m = String(text).replace(ANSI, "").match(LOCAL_URL);
  return m ? m[0].replace("0.0.0.0", "localhost").replace("[::]", "localhost") : null;
}

const TAIL = 4_000;

export class DevRun extends EventEmitter {
  constructor({ cwd, port = null, env = {}, poll = portBusy, pollMs = 1_000 } = {}) {
    super();
    this.cwd = cwd;
    this.port = port;
    this.env = env;
    this.poll = poll;
    this.pollMs = pollMs;
    this.status = "idle"; // idle | starting | running | stopped | failed
    this.line = null;
    this.url = null;
    this.exitCode = null;
    this.error = null;
    this.output = "";
    this.child = null;
    this.exited = null;
  }

  changed() {
    this.emit("change", this);
  }

  async start() {
    if (this.status === "starting" || this.status === "running") throw new Error("it is already running");
    const found = await runCommandFor(this.cwd);
    if (!found) throw new Error('nothing to run: add "run" to .foolscap.json, or a dev script to package.json');
    this.line = withPort(found.line, this.port);
    this.url = null;
    this.exitCode = null;
    this.error = null;
    this.output = "";
    this.stopping = false;
    const env = agentEnv(process.env, { ...this.env, ...(this.port ? { PORT: String(this.port) } : {}), BROWSER: "none" });
    // The line is the repo's own, so it runs through the platform shell the
    // way its owner runs it. On Linux the shell leads its own process group,
    // so stop() can end the server it starts as well.
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${this.line}"`], { cwd: this.cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn("sh", ["-c", this.line], { cwd: this.cwd, env, detached: true });
    this.child = child;
    this.status = "starting";
    this.exited = new Promise((resolve) => child.once("close", resolve));
    const keep = (chunk) => {
      this.output = (this.output + chunk.toString("utf8")).slice(-TAIL);
      if (!this.url) {
        const url = localUrlIn(this.output);
        if (url) this.ready(url);
      }
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", (err) => {
      this.status = "failed";
      this.error = err.message;
      this.changed();
    });
    child.once("close", (code) => {
      this.exitCode = code;
      this.child = null;
      clearTimeout(this.timer);
      if (this.status !== "failed") this.status = this.stopping || code === 0 ? "stopped" : "failed";
      if (this.status === "failed") this.error ??= `it exited with code ${code}`;
      this.changed();
    });
    this.changed();
    this.watchPort();
  }

  /** Until the server prints a URL, look for its port answering. */
  watchPort() {
    if (!this.port) return;
    const tick = async () => {
      if (this.status !== "starting" || this.url) return;
      if (await this.poll(this.port)) this.ready(`http://localhost:${this.port}`);
      else this.timer = setTimeout(tick, this.pollMs);
    };
    this.timer = setTimeout(tick, this.pollMs);
  }

  ready(url) {
    if (this.status !== "starting" && this.status !== "running") return;
    this.url = url;
    this.status = "running";
    this.changed();
  }

  /** End the server and everything it started; resolves once it has exited. */
  async stop({ timeoutMs = 5_000 } = {}) {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    clearTimeout(this.timer);
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          if (this.child) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 2_000).unref();
    }
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  snapshot() {
    return {
      status: this.status,
      line: this.line,
      url: this.url,
      port: this.port,
      exitCode: this.exitCode,
      error: this.error,
      tail: this.output.replace(ANSI, "").slice(-1_500),
    };
  }
}
