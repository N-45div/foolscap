/**
 * The fleet — many agents, one queue.
 *
 * Working with five running agents fails for one reason: every surface
 * shows you five terminals, so you end up polling all of them, and the
 * bookkeeping costs more than the work. The fleet inverts that. foolscap
 * drives each agent itself — it sends the prompts, receives the stream,
 * and answers permission requests — so it knows, exactly and in real
 * time, which agent is blocked on you, which one's tests just went red,
 * and which is fine and should be left alone. The UI shows that as a
 * queue, not a grid.
 *
 * Drivers own the transport; the session core owns everything else:
 *   claude      Claude Code natively (stream-json; permissions via an MCP
 *               relay), the user's own CLI on their own login
 *   codex-exec  Codex natively (`codex exec --json`, one run per turn)
 *   acp         any agent that speaks ACP over stdio: Gemini CLI,
 *               OpenCode, Goose, Hermes, OpenClaw, or a command you name
 *
 * Whatever the driver, every frame is recorded, the document is built
 * by the same builders the archive replays, and evidence (tests red or
 * green, errors, files edited) is read strictly from exit codes and the
 * runner's own counts.
 *
 * After a turn, the repo's own tests are run by foolscap (verify.mjs).
 * A session can hold a queue of next prompts: the next one goes out only
 * when that check is green, and is held, with the reason, when it isn't.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { AGENTS, Recorder, acpArchiveDir, resolveAgent } from "./acp.mjs";
import { TranscriptBuilder } from "./acp-doc.mjs";
import { resolveAgentBinary } from "./agent-bin.mjs";
import { ClaudeStreamBuilder } from "./claude-stream.mjs";
import { CodexExecBuilder } from "./codex-exec-doc.mjs";
import { commandOf, validationKey } from "./outcome.mjs";
import { claudeExitCode, readTestRun } from "./test-run.mjs";
import { verifyRepo } from "./verify.mjs";
import { createWorktree, mergeWorktree, removeWorktree, repoRoot, worktreeChanges } from "./worktree.mjs";
import { createAcpDriver } from "./drivers/acp.mjs";
import { createClaudeDriver } from "./drivers/claude.mjs";
import { createCodexExecDriver } from "./drivers/codex-exec.mjs";

/** Personal assistants rather than coding agents: no tests to gate on. */
const ASSISTANTS = new Set(["hermes", "openclaw"]);

/** What the new-task form offers. Raw commands are treated as ACP agents. */
export const FLEET_AGENTS = {
  claude: { label: "Claude Code", driver: "claude" },
  codex: { label: "Codex", driver: "codex-exec" },
  ...Object.fromEntries(
    Object.entries(AGENTS).map(([key, spec]) => [
      key === "claude" || key === "codex" ? `${key}-acp` : key,
      { label: spec.label, driver: "acp", acp: key, assistant: ASSISTANTS.has(key) },
    ]),
  ),
};

// "checking" too: the repo's tests are running in that checkout.
const WRITER_ACTIVE = new Set(["starting", "idle", "working", "blocked", "checking"]);
const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;

/** Synchronous because Fleet.launch is intentionally immediate. This guards
    the direct Agents API too; workspace launches perform the same check while
    holding their durable state lock. */
export function checkoutKey(cwd) {
  const workdir = resolve(cwd);
  try {
    const top = String(execFileSync("git", ["-C", workdir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
    if (top) return pathKey(resolve(top));
  } catch {
    // A non-Git working directory is its own checkout.
  }
  return pathKey(workdir);
}

const TRANSPORT = { claude: "native", "codex-exec": "native", acp: "acp" };

/** Multiple transports for one underlying agent are one review family. */
export const agentFamily = (id) => id === "claude-acp" ? "claude" : id === "codex-acp" ? "codex" : id;

function commandExists(command, env = process.env) {
  if (!command) return false;
  const names = process.platform === "win32"
    ? ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")]
    : [""];
  const direct = isAbsolute(command) || /[\\/]/.test(command);
  const roots = direct ? [""] : String(env.PATH ?? "").split(delimiter).filter(Boolean);
  return roots.some((root) => names.some((extension) => existsSync(root ? join(root, command + extension) : command + extension)));
}

/** Honest local readiness; no child process is started by this check. */
export function fleetAgentCatalog(env = process.env) {
  const overrideCommand = (name) => String(env[name] ?? "").trim().split(/\s+/)[0] || null;
  const found = (command) => commandExists(command, env) || resolveAgentBinary(command, { env }) !== null;
  const requirementsFor = (id, entry) => {
    if (id === "claude") return [overrideCommand("FOOLSCAP_CLAUDE") ?? "claude"];
    if (id === "codex") return [overrideCommand("FOOLSCAP_CODEX") ?? "codex"];
    const spec = AGENTS[entry.acp];
    const command = overrideCommand(`FOOLSCAP_ACP_${entry.acp.toUpperCase()}`) ?? spec.command;
    // An adapter fetched by npx also needs the CLI it wraps.
    if (entry.acp === "claude" || entry.acp === "codex") return [command, entry.acp];
    if (entry.acp === "antigravity") return [command, "agy"];
    return [command];
  };
  return Object.entries(FLEET_AGENTS).map(([id, entry]) => {
    const missing = requirementsFor(id, entry).filter((command) => !found(command));
    const available = missing.length === 0;
    const unverified = id === "antigravity";
    return {
      id,
      label: entry.label,
      driver: entry.driver,
      assistant: Boolean(entry.assistant),
      available,
      status: available ? (unverified ? "unverified" : "ready") : "setup",
      reason: available ? (unverified ? "launch path has not been verified on this machine" : null) : `missing command: ${missing.join(", ")}`,
    };
  });
}

const now = () => new Date().toISOString();

const freshEvidence = () => ({
  testsPassed: 0,
  testsFailed: 0,
  errors: 0,
  edited: 0,
});

/** Present-tense evidence plus the final-code validation suites behind it. */
export function evidenceReportFor(cell) {
  const ev = freshEvidence();
  if (!cell) return { evidence: ev, validations: [] };
  const edited = new Set();
  let nonValidationErrors = 0;
  const validations = new Map();
  const summarize = () => {
    ev.testsFailed = [...validations.values()].filter((item) => item.failed).length;
    ev.testsPassed = [...validations.values()].filter((item) => item.passed).length;
    ev.errors = nonValidationErrors + [...validations.values()].filter((item) => item.isError).length;
  };
  for (const part of cell.parts) {
    if (part.kind !== "tool") continue;
    const tool = part.tool;
    const isEdit =
      /^(edit|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool.name) ||
      typeof tool.input.old_string === "string" ||
      typeof tool.input.new_string === "string";
    if (isEdit && tool.input.file_path) {
      edited.add(String(tool.input.file_path));
      // Validation proves a particular code state. Any later edit makes all
      // earlier results stale until their suites run again.
      validations.clear();
      summarize();
    }
    const command = commandOf(tool);
    const exitCode = typeof tool.exitCode === "number" ? tool.exitCode : claudeExitCode(tool.result, tool.isError);
    const run = readTestRun({ command, output: tool.result ?? "", exitCode });
    if (run.kind) {
      const key = validationKey(command) ?? `${run.kind}:${command.trim().toLowerCase()}`;
      validations.set(key, {
        key,
        kind: run.kind,
        command: command.slice(0, 200),
        outputTail: String(tool.result ?? "").slice(-1200),
        tested: true,
        passed: run.verdict === "green",
        failed: run.verdict === "red",
        verdict: run.verdict,
        reason: run.reason,
        counts: run.counts,
        isError: tool.isError,
      });
      summarize();
    } else if (tool.isError) {
      nonValidationErrors++;
      summarize();
    }
  }
  ev.edited = edited.size;
  return { evidence: ev, validations: [...validations.values()] };
}

/** The agent's latest words in a turn, trimmed for a row in the inbox. */
function lastText(cell) {
  const parts = cell?.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].kind === "text" && parts[i].text?.trim()) return parts[i].text.trim().slice(0, 2000);
  }
  return null;
}

/** Summary kept stable for attention ranking and existing API consumers. */
export function evidenceFor(cell) {
  return evidenceReportFor(cell).evidence;
}


/** Shorten to at most `max` characters, ending on a whole word. */
export function clip(text, max) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1).replace(/\s+\S*$/, "");
  return `${cut || t.slice(0, max - 1)}…`;
}

/** A task's name from its first sentence: "Fix add() in src/math.mjs…". */
export function nameFromPrompt(prompt) {
  const line = String(prompt ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const sentence = line.trim().split(/[.!?](?:\s|$)/)[0].trim();
  return sentence ? clip(sentence, 32) : null;
}

export class AgentSession extends EventEmitter {
  constructor({
    id,
    name,
    agent,
    cwd,
    relay = null,
    settingSources = null,
    codexModel = null,
    verify = true,
    worktree = null,
    record = true,
    recordDir = acpArchiveDir(),
    log = () => {},
  }) {
    super();
    this.id = id;
    this.name = name;
    this.agent = agent;
    this.cwd = cwd;
    this.record = record;
    this.recordDir = recordDir;
    this.log = (m) => log(`[${name}] ${m}`);

    const entry = FLEET_AGENTS[agent];
    this.driverKind = entry?.driver ?? "acp";
    const hooks = {
      log: this.log,
      onFrame: (dir, msg) => this.onFrame(dir, msg),
      onPermission: (p) => this.onPermission(p),
    };
    if (this.driverKind === "claude") {
      this.label = entry.label;
      this.driver = createClaudeDriver({ id, cwd, fleetUrl: relay?.url, fleetToken: relay?.token, settingSources, ...hooks });
      this.builder = new ClaudeStreamBuilder({ cwd });
    } else if (this.driverKind === "codex-exec") {
      this.label = entry.label;
      this.driver = createCodexExecDriver({ cwd, model: codexModel, ...hooks });
      this.builder = new CodexExecBuilder();
    } else {
      const spec = resolveAgent(entry?.acp ?? agent);
      this.label = entry?.label ?? spec.label;
      this.driver = createAcpDriver({ spec, cwd, ...hooks });
      this.builder = new TranscriptBuilder();
    }

    this.assistant = Boolean(entry?.assistant);
    this.verifyEnabled = verify && !this.assistant;
    this.queue = []; // next prompts, sent one per green turn
    this.held = null; // { reason } when the queue is waiting on you
    this.verified = null; // the repo's own test run after the last turn
    this.worktree = worktree; // { repo, path, branch, base } when the task has its own checkout
    this.changes = null; // { files, added, removed } in the worktree since it started

    this.status = "starting"; // starting | idle | working | blocked | checking | done | exited | error
    this.startedAt = now();
    this.turnStartedAt = null;
    this.doneAt = null;
    this.blockedSince = null;
    this.endedAt = null;
    this.lastActivityAt = this.startedAt;
    this.exitCode = null;
    this.error = null;
    this.stopReason = null;
    this.pendingPermission = null;
    this.evidence = freshEvidence();
    this.validations = [];
    this.recorder = null;
  }

  get turns() {
    return this.builder.cells.length;
  }

  get sessionId() {
    return this.driver.sessionId ?? null;
  }

  changed() {
    this.emit("change", this);
  }

  async start() {
    if (this.record) {
      await mkdir(this.recordDir, { recursive: true });
      this.recorder = new Recorder(join(this.recordDir, `${this.id}.jsonl`), {
        type: "foolscap-acp",
        version: 1,
        driver: this.driverKind,
        id: this.id,
        name: this.name,
        agent: this.label,
        cwd: this.cwd,
        startedAt: this.startedAt,
      });
    }
    try {
      await this.driver.start({
        onExit: (code, err) => {
          // Merge stops the agent on purpose; the task is removed right after.
          if (this.merging || this.status === "exited" || this.status === "error") return;
          this.exitCode = code;
          this.endedAt = now();
          this.status = err || code !== 0 ? "error" : "exited";
          if (err) this.error = err.message;
          else if (code !== 0) this.error ??= `agent exited with code ${code}`;
          this.log(this.error ?? "exited");
          this.changed();
        },
      });
      if (this.status === "starting") this.status = "idle";
      this.changed();
    } catch (err) {
      this.fail(err.message);
    }
  }

  fail(message) {
    this.status = "error";
    this.error = message;
    this.endedAt = now();
    this.log(message);
    this.changed();
  }

  /** Every frame, either direction, from whichever driver. */
  onFrame(dir, msg) {
    this.recorder?.frame(dir, msg);
    this.builder.feed(dir, msg, now());
    const report = evidenceReportFor(this.builder.current);
    this.evidence = report.evidence;
    this.validations = report.validations;
    this.lastActivityAt = now();
    this.changed();
  }

  onPermission(p) {
    this.pendingPermission = p;
    this.status = "blocked";
    this.blockedSince = now();
    this.changed();
  }

  prompt(text) {
    if (this.cancelled) throw new Error("session was stopped");
    if (this.status !== "idle" && this.status !== "done") {
      throw new Error(`session is ${this.status}`);
    }
    this.status = "working";
    this.turnStartedAt = now();
    this.doneAt = null;
    this.stopReason = null;
    this.held = null;
    this.verified = null;
    this.evidence = freshEvidence();
    this.validations = [];
    this.driver
      .prompt(text)
      .then((r) => {
        this.stopReason = r?.stopReason ?? "end_turn";
        if (r?.error) this.error = r.error;
        if (this.status === "working" || this.status === "blocked") {
          this.pendingPermission = null;
          return this.afterTurn();
        }
        this.changed();
      })
      .catch((err) => {
        if (this.status === "working" || this.status === "blocked") {
          this.stopReason = "error";
          this.evidence.errors++;
          this.log(`turn failed: ${err.message}`);
          return this.afterTurn();
        }
        this.changed();
      });
    this.changed();
  }

  /**
   * A turn ended: check it with the repo's own tests, then send the next
   * queued prompt only on green. Anything else holds the queue, with the
   * reason, until the person decides.
   */
  async afterTurn() {
    if (this.verifyEnabled && this.stopReason !== "error" && this.stopReason !== "cancelled") {
      this.status = "checking";
      this.changed();
      try {
        this.verified = await verifyRepo(this.cwd);
      } catch (err) {
        this.log(`verify failed: ${err.message}`);
        this.verified = null;
      }
    }
    if (this.worktree) this.changes = await worktreeChanges(this.worktree).catch(() => this.changes);
    if (!["checking", "working", "blocked"].includes(this.status)) return;
    this.status = "done";
    this.doneAt = now();
    this.emit("event", {
      type: "turn",
      verdict: this.verified?.verdict ?? null,
      stopReason: this.stopReason,
      ms: this.turnStartedAt ? Date.now() - Date.parse(this.turnStartedAt) : 0,
    });
    if (this.queue.length) {
      const gate = this.gate();
      if (gate.open) {
        const next = this.queue.shift();
        this.log(`queue: sending the next prompt (${gate.reason})`);
        this.emit("event", { type: "queue-sent", reason: gate.reason });
        this.prompt(next);
        return;
      }
      this.held = { reason: gate.reason };
      this.emit("event", { type: "held", reason: gate.reason });
    }
    this.changed();
  }

  /** May the next queued prompt go out on its own? */
  gate() {
    if (this.stopReason === "error") return { open: false, reason: "the turn ended with an error" };
    if (this.stopReason === "cancelled") return { open: false, reason: "the turn was stopped" };
    if (this.assistant) return { open: false, reason: "waiting for you to read the reply" };
    const v = this.verified;
    if (v) {
      if (v.verdict === "green") return { open: true, reason: `tests green: ${v.reason}` };
      return { open: false, reason: v.verdict === "red" ? `tests red: ${v.reason}` : `tests unclear: ${v.reason}` };
    }
    // No test command we could run: fall back to the agent's own runs.
    const runs = this.validations.filter((item) => item.kind === "test");
    if (runs.length && runs.every((item) => item.verdict === "green")) {
      return { open: true, reason: "the agent's own test runs were green" };
    }
    return { open: false, reason: "no green test run to go on" };
  }

  /** Line up a prompt for after the next green turn. */
  enqueue(text) {
    const prompt = String(text ?? "").trim();
    if (!prompt) throw new Error("a prompt is required");
    this.queue.push(prompt);
    // Idle with nothing in flight: there is no turn to wait for.
    if (this.status === "idle" && this.queue.length === 1 && !this.held) {
      this.prompt(this.queue.shift());
      return;
    }
    this.changed();
  }

  /** Drop a queued prompt by position. */
  dequeue(index) {
    if (index < 0 || index >= this.queue.length) throw new Error("no such queued prompt");
    this.queue.splice(index, 1);
    if (!this.queue.length) this.held = null;
    this.changed();
  }

  /** Bring this task's worktree onto the person's branch as one commit,
      then remove it. Returns the new commit's short hash. */
  async merge() {
    if (!this.worktree) throw new Error("this task works in your checkout directly; there is nothing to merge");
    if (["starting", "working", "blocked", "checking"].includes(this.status)) throw new Error("wait for the agent to finish first");
    const asked = this.builder.cells[0]?.prompt ?? this.name;
    const subject = clip(`${this.label}: ${asked.split(/\r?\n/)[0].trim()}`, 72);
    // The body tells the whole story: every prompt sent, and the last check.
    const prompts = this.builder.cells.map((c) => c.prompt?.trim()).filter(Boolean);
    const body = [
      prompts.length > 1 ? `Prompts:\n${prompts.map((p) => `- ${p.split(/\r?\n/)[0]}`).join("\n")}` : null,
      this.verified ? `Checked by foolscap: ${this.verified.line ?? "tests"} ${this.verified.verdict}, ${this.verified.reason}.` : null,
    ].filter(Boolean).join("\n\n");
    const sha = await mergeWorktree(this.worktree, { message: body ? `${subject}\n\n${body}` : subject });
    this.emit("event", { type: "merged", sha, ...(this.changes ?? {}) });
    this.merged = sha;
    // The agent goes first: on Windows its process holds the folder open.
    // Only the process stops; the task stays "done" until it is removed, so
    // nothing flashes as exited.
    const worktree = this.worktree;
    this.merging = true;
    this.driver.close();
    await removeWorktree(worktree);
    this.worktree = null;
    this.changed();
    return sha;
  }

  /** Throw this task's worktree away. */
  async discard() {
    if (!this.worktree) throw new Error("this task has no worktree to discard");
    this.cancel();
    this.close();
    await removeWorktree(this.worktree);
    this.worktree = null;
    this.changed();
  }

  /** The person overrides a hold: send the next queued prompt now. */
  sendNext() {
    if (!this.queue.length) throw new Error("nothing is queued");
    this.prompt(this.queue.shift());
  }

  /** Answer the pending request: an option id, or free text when the
      agent asked a question (`answer: "text"`). */
  answerPermission(optionId, text) {
    const p = this.pendingPermission;
    if (!p) throw new Error("no permission is pending");
    if (p.answer === "text") {
      if (typeof text !== "string" || !text.trim()) throw new Error("an answer is required");
    } else if (p.options.length && !p.options.some((o) => o.optionId === optionId)) {
      throw new Error(`unknown option ${optionId}`);
    }
    this.driver.answerPermission(p.requestId, optionId, text?.trim());
    this.pendingPermission = null;
    this.blockedSince = null;
    this.status = "working";
    this.changed();
  }

  /** Native Claude Code asks through the permission relay. */
  ask(args) {
    if (typeof this.driver.ask !== "function") {
      throw new Error("this driver does not relay permissions");
    }
    return this.driver.ask(args);
  }

  decision(requestId) {
    if (typeof this.driver.decision !== "function") return { decided: true, allow: false };
    return this.driver.decision(requestId);
  }

  /**
   * Stop means stop. A turn in flight is interrupted through the driver;
   * a session that has not been given one yet is shut down instead, so an
   * agent still booting when you press stop never receives its prompt and
   * never touches the repository.
   */
  cancel() {
    const pendingRequestId = this.pendingPermission?.requestId;
    this.pendingPermission = null;
    this.blockedSince = null;
    this.cancelled = true;
    if (this.status === "working" || this.status === "blocked") {
      this.driver.cancel({ pendingRequestId });
      this.changed();
      return;
    }
    if (this.status === "starting" || this.status === "idle") {
      this.stopReason ??= "cancelled";
      this.close(); // close() emits its own change
      return;
    }
    this.changed();
  }

  close() {
    if (this.status !== "exited" && this.status !== "error") {
      this.status = "exited";
      this.endedAt = now();
    }
    this.driver.close();
    this.changed();
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      agent: this.agent,
      agentLabel: this.label,
      driver: this.driverKind,
      url: this.driver.url ?? null,
      cwd: this.cwd,
      status: this.status,
      stopReason: this.stopReason,
      activity: this.builder.activity,
      plan: this.builder.plan ?? null,
      pendingPermission: this.pendingPermission,
      evidence: this.evidence,
      validations: this.validations,
      verified: this.verified,
      queue: [...this.queue],
      held: this.held,
      assistant: this.assistant,
      worktree: this.worktree ? { branch: this.worktree.branch, repo: this.worktree.repo } : null,
      changes: this.changes,
      merged: this.merged ?? null,
      lastPrompt: this.builder.current?.prompt ?? null,
      lastReply: lastText(this.builder.current),
      model: this.builder.model ?? null,
      outputTokens: this.builder.totalOutputTokens ?? 0,
      costUsd: typeof this.builder.costUsd === "number" ? this.builder.costUsd : null,
      turns: this.turns,
      startedAt: this.startedAt,
      turnStartedAt: this.turnStartedAt,
      doneAt: this.doneAt,
      blockedSince: this.blockedSince,
      endedAt: this.endedAt,
      lastActivityAt: this.lastActivityAt,
      exitCode: this.exitCode,
      error: this.error,
    };
  }

  doc() {
    const model = this.builder.model ? ` · ${this.builder.model}` : "";
    return {
      cells: this.builder.cells,
      meta: {
        cwd: this.cwd,
        agent: `${this.label}${model} · ${TRANSPORT[this.driverKind] ?? this.driverKind}`,
        startedAt: this.startedAt,
        endedAt: this.endedAt ?? undefined,
        totalOutputTokens: this.builder.totalOutputTokens ?? 0,
        entryCount: this.builder.entryCount,
        skippedLines: 0,
      },
    };
  }
}

export class Fleet extends EventEmitter {
  constructor({ record = true, recordDir, log = () => {}, defaults = {} } = {}) {
    super();
    this.record = record;
    this.recordDir = recordDir;
    this.log = log;
    // Launch options every session gets unless a launch says otherwise:
    // { relay, settingSources, codexModel, verify }.
    this.defaults = defaults;
    this.sessions = new Map();
    this.counter = 0;
  }

  /** Spawn a session; returns at once — the agent boots in the background.
      A `prompt` is sent as soon as it is up; `queue` lines up the ones after. */
  launch({ agent = "claude", cwd = process.cwd(), name, prompt, queue = [], fleetUrl, id: givenId, worktree = null, ...options } = {}) {
    const opts = { ...this.defaults, ...options };
    const relay = opts.relay ?? (fleetUrl ? { url: fleetUrl } : null);
    const capability = this.agents().find((entry) => entry.id === agent);
    if (capability && !capability.available) throw new Error(`${capability.label} is not ready: ${capability.reason}`);
    const key = checkoutKey(cwd);
    const occupant = [...this.sessions.values()].find((session) =>
      WRITER_ACTIVE.has(session.status) && checkoutKey(session.cwd) === key);
    if (occupant) throw new Error(`workspace is busy with ${occupant.name || occupant.agent || "another agent"}`);
    const id = givenId ?? randomBytes(6).toString("hex");
    const s = new AgentSession({
      id,
      name: name?.trim() || nameFromPrompt(prompt) || `${basename(worktree?.repo ?? cwd) || "agent"}-${++this.counter}`,
      agent,
      cwd,
      relay,
      settingSources: opts.settingSources ?? null,
      codexModel: opts.codexModel ?? null,
      verify: opts.verify ?? true,
      worktree,
      record: this.record,
      recordDir: this.recordDir,
      log: this.log,
    });
    s.queue.push(...queue.map((q) => String(q).trim()).filter(Boolean));
    s.on("change", () => this.emit("change", s));
    s.on("event", (event) => this.emit("event", { ...event, id, name: s.name, agent: s.label }));
    this.sessions.set(id, s);
    this.emit("change", s);
    s.start()
      .then(() => {
        if (prompt && s.status === "idle") s.prompt(prompt);
      })
      .catch((err) => s.fail(err.message));
    return s.snapshot();
  }

  /** Launch, in the task's own git worktree when asked and the folder is a
      repo, so several agents can work on one repo at once. */
  async launchTask({ worktree = false, cwd = process.cwd(), ...rest } = {}) {
    if (!worktree || !(await repoRoot(cwd))) return this.launch({ cwd, ...rest });
    const id = randomBytes(6).toString("hex");
    const wt = await createWorktree({ cwd, id });
    try {
      return this.launch({ ...rest, cwd: wt.path, id, worktree: wt });
    } catch (err) {
      await removeWorktree(wt);
      throw err;
    }
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  agents() {
    return fleetAgentCatalog();
  }

  close(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.close();
    this.sessions.delete(id);
    this.emit("change");
    return true;
  }

  async closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}

let singleton = null;

/** The one fleet per process. The first caller's options stick. */
export function getFleet(opts) {
  singleton ??= new Fleet(opts);
  return singleton;
}

export { AGENTS as ACP_AGENTS };
