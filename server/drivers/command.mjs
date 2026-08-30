/**
 * Fleet driver: a headless command, one process per turn.
 *
 * Some agents have no streaming protocol and no local store, only a
 * one-shot mode: give it a prompt, it runs, prints, exits. Warp is the
 * first — `oz agent run --prompt … --cwd … --output-format json` — and
 * the same shape fits any CLI with a `--prompt`. This driver runs the
 * command once per turn with the prompt and working directory filled
 * into a template, captures what it prints, and ends the turn when the
 * process exits.
 *
 * What it can and cannot know: it sees output and an exit code, so the
 * queue gets working → finished / hit a problem. It cannot see a
 * permission prompt (headless runs auto-approve by their own config), so
 * "needs you" only means the turn ended. Each turn is a fresh process;
 * whether the agent remembers the previous turn is up to the agent.
 *
 * Templates: an argv array with `{prompt}` and `{cwd}` placeholders.
 * `FOOLSCAP_<AGENT>="…"` overrides the whole command line.
 */
import { spawn } from "node:child_process";

const MAX_OUTPUT = 200_000;

/** Try to read the process output as JSON — whole, or its last line. */
function parseOutput(text) {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* not one JSON document */
  }
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function fill(template, values) {
  return template.map((part) =>
    part.replaceAll("{prompt}", values.prompt).replaceAll("{cwd}", values.cwd),
  );
}

/** Spawn without a shell when we can; fall back to one for .cmd shims. */
function launch(argv, cwd, env) {
  const [command, ...args] = argv;
  const direct = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  return direct;
}

function launchViaShell(argv, cwd, env) {
  const quote = (a) => `"${String(a).replaceAll('"', '\\"')}"`;
  const line = [argv[0], ...argv.slice(1).map(quote)].join(" ");
  return spawn(line, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: true, windowsHide: true });
}

export function createCommandDriver({ template, cwd, log, onFrame }) {
  const driver = { kind: "command", sessionId: null };
  let child = null;
  let turn = null;

  const finish = (result) => {
    const t = turn;
    turn = null;
    child = null;
    t?.resolve(result);
  };

  driver.start = async () => {
    if (!Array.isArray(template) || template.length === 0) {
      throw new Error("the command driver needs a command template");
    }
  };

  driver.prompt = (text) =>
    new Promise((resolve, reject) => {
      turn = { resolve, reject };
      const argv = fill(template, { prompt: text, cwd });
      onFrame("c2a", { type: "command/prompt", text, argv });

      const env = { ...process.env, PWD: cwd };
      let out = "";
      let err = "";
      let retried = false;

      const wire = (proc) => {
        child = proc;
        proc.stdout.on("data", (c) => {
          if (out.length < MAX_OUTPUT) out += c.toString("utf8");
        });
        proc.stderr.on("data", (c) => {
          const s = c.toString("utf8");
          if (err.length < MAX_OUTPUT) err += s;
          log(s.trim());
        });
        proc.on("error", (e) => {
          // A .cmd shim on Windows needs a shell; try once that way.
          if (e.code === "ENOENT" && !retried && process.platform === "win32") {
            retried = true;
            wire(launchViaShell(argv, cwd, env));
            return;
          }
          onFrame("a2c", { type: "command/exit", code: null, error: e.message });
          const t = turn;
          turn = null;
          child = null;
          t?.reject(e);
        });
        proc.on("exit", (code) => {
          if (retried && code === null) return; // superseded by the shell retry
          const json = parseOutput(out);
          onFrame("a2c", { type: "command/output", json, text: out.slice(0, MAX_OUTPUT), stderr: err.slice(0, 20_000) });
          onFrame("a2c", { type: "command/exit", code });
          finish({ stopReason: code === 0 ? "end_turn" : "error" });
        });
      };

      try {
        wire(launch(argv, cwd, env));
      } catch (e) {
        turn = null;
        reject(e);
      }
    });

  driver.answerPermission = () => {};

  driver.cancel = () => {
    if (child) {
      child.kill();
      onFrame("c2a", { type: "command/cancel" });
      finish({ stopReason: "cancelled" });
    }
  };

  driver.close = () => {
    child?.kill();
    if (turn) finish({ stopReason: "cancelled" });
  };

  return driver;
}
