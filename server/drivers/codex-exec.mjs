/**
 * Fleet driver: Codex, through `codex exec --json`.
 *
 * The plain CLI, the way a person runs it in a terminal: one process per
 * turn, the prompt on stdin, events back as JSON lines. The first turn
 * starts a thread; every later turn is `codex exec resume <thread>`.
 * foolscap never touches Codex's login. It is the user's own `codex`,
 * signed in with their own ChatGPT plan, and an OPENAI_API_KEY in the
 * environment is stripped so it cannot switch them to API billing.
 *
 * Headless Codex has no one to ask for approval, so it runs in its
 * workspace-write sandbox and "needs you" means the turn ended. Each
 * finished command arrives as an item with a real exit code, which is
 * what the evidence gate reads (see test-run.mjs).
 *
 * `FOOLSCAP_CODEX="…"` overrides the binary; `model` overrides the one
 * in ~/.codex/config.toml, which may name a model the plan cannot use.
 */
import { spawnAgent } from "../acp.mjs";
import { agentEnv, resolveAgentBinary } from "../agent-bin.mjs";
import { terminateProcessTree } from "./process.mjs";

export function codexSpec() {
  const override = process.env.FOOLSCAP_CODEX;
  if (override) {
    const parts = override.trim().split(/\s+/);
    return { label: "codex", command: parts[0], args: parts.slice(1) };
  }
  const found = resolveAgentBinary("codex");
  return { label: "codex", command: found?.command ?? "codex", args: found?.args ?? [] };
}

/** The argv for one turn: a new thread, or a resumed one. */
export function codexTurnArgs({ threadId = null, cwd, model = null }) {
  const common = ["--json", "-c", 'sandbox_mode="workspace-write"', ...(model ? ["-m", model] : [])];
  return threadId
    ? ["exec", "resume", threadId, ...common, "-"]
    : ["exec", ...common, "-C", cwd, "-"];
}

export function createCodexExecDriver({ cwd, model = null, env: extraEnv = {}, log, onFrame }) {
  const spec = codexSpec();
  let child = null;
  let onExitOnce = null;
  let lastError = null;
  const driver = { kind: "codex-exec", sessionId: null };

  driver.start = async ({ onExit }) => {
    // No long-lived process to start: each prompt is its own run.
    onExitOnce = onExit;
  };

  driver.prompt = (text) =>
    new Promise((resolve, reject) => {
      const args = [...spec.args, ...codexTurnArgs({ threadId: driver.sessionId, cwd, model })];
      lastError = null;
      let buffered = "";
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      child = spawnAgent({ ...spec, args }, cwd, agentEnv(process.env, extraEnv));
      onFrame("c2a", { type: "prompt", text });
      child.stdin.end(text);

      child.stdout.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        let nl;
        while ((nl = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // not protocol
          }
          onFrame("a2c", event);
          if (event.type === "thread.started") driver.sessionId = event.thread_id ?? driver.sessionId;
          if (event.type === "error" || event.type === "turn.failed") {
            lastError = event.error?.message ?? event.message ?? "Codex reported an error";
          }
          if (event.type === "turn.completed") settle(resolve, { stopReason: "end_turn" });
          if (event.type === "turn.failed") settle(resolve, { stopReason: "error", error: readableError(lastError) });
        }
      });
      child.stderr.on("data", (c) => log(c.toString().trim()));
      child.on("error", (err) => settle(reject, err));
      child.on("exit", (code) => {
        child = null;
        if (code === 0) settle(resolve, { stopReason: "end_turn" });
        else settle(resolve, { stopReason: "error", error: readableError(lastError) ?? `codex exited with ${code}` });
      });
    });

  driver.answerPermission = () => {}; // headless: nothing ever asks
  driver.cancel = () => terminateProcessTree(child);
  driver.close = () => {
    terminateProcessTree(child);
    onExitOnce?.(0);
  };
  return driver;
}

/** Codex nests the API's error JSON inside its message; show the sentence. */
export function readableError(message) {
  if (!message) return null;
  try {
    const inner = JSON.parse(message);
    return inner?.error?.message ?? message;
  } catch {
    return message;
  }
}
