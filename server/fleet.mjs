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
 *   claude   Claude Code natively (stream-json; permissions via an MCP
 *            relay) — no adapter to download
 *   acp      any agent that speaks ACP over stdio (Codex, Gemini CLI,
 *            Claude Code through its adapter, or a command you name)
 *
 * Whatever the driver, every frame is recorded, the document is built
 * by the same builders the archive replays, and evidence (tests red or
 * green, errors, files edited) comes from the same classifier the
 * archive judge uses — the moat, in the present tense.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { AGENTS, Recorder, acpArchiveDir, resolveAgent } from "./acp.mjs";
import { TranscriptBuilder } from "./acp-doc.mjs";
import { ClaudeStreamBuilder } from "./claude-stream.mjs";
import { DevinBuilder } from "./devin-doc.mjs";
import { classifyRun, commandOf } from "./outcome.mjs";
import { createAcpDriver } from "./drivers/acp.mjs";
import { createClaudeDriver } from "./drivers/claude.mjs";
import { createDevinDriver } from "./drivers/devin.mjs";

/** What the launch form offers. Raw commands are treated as ACP agents. */
export const FLEET_AGENTS = {
  claude: { label: "claude code", driver: "claude" },
  "claude-acp": { label: "claude code · acp", driver: "acp", acp: "claude" },
  codex: { label: "codex", driver: "acp", acp: "codex" },
  antigravity: { label: "antigravity cli", driver: "acp", acp: "antigravity" },
  opencode: { label: "opencode", driver: "acp", acp: "opencode" },
  devin: { label: "devin", driver: "devin" },
};

const TRANSPORT = { claude: "native", devin: "cloud", acp: "acp" };

const now = () => new Date().toISOString();

const freshEvidence = () => ({
  testsPassed: 0,
  testsFailed: 0,
  errors: 0,
  edited: 0,
});

/** Present-tense evidence: read the current turn's tools as they land. */
function evidenceFor(cell) {
  const ev = freshEvidence();
  if (!cell) return ev;
  const edited = new Set();
  for (const part of cell.parts) {
    if (part.kind !== "tool") continue;
    const tool = part.tool;
    if (tool.isError) ev.errors++;
    const run = classifyRun(commandOf(tool), tool.result ?? "", tool.isError);
    if (run.failed) ev.testsFailed++;
    else if (run.passed) ev.testsPassed++;
    const isEdit =
      /^(edit|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool.name) ||
      typeof tool.input.old_string === "string" ||
      typeof tool.input.new_string === "string";
    if (isEdit && tool.input.file_path) edited.add(String(tool.input.file_path));
  }
  ev.edited = edited.size;
  return ev;
}

export class AgentSession extends EventEmitter {
  constructor({
    id,
    name,
    agent,
    cwd,
    fleetUrl,
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
      this.driver = createClaudeDriver({ id, cwd, fleetUrl, ...hooks });
      this.builder = new ClaudeStreamBuilder();
    } else if (this.driverKind === "devin") {
      this.label = entry.label;
      this.driver = createDevinDriver({ name, ...hooks });
      this.builder = new DevinBuilder();
    } else {
      const spec = resolveAgent(entry?.acp ?? agent);
      this.label = entry?.label ?? spec.label;
      this.driver = createAcpDriver({ spec, cwd, ...hooks });
      this.builder = new TranscriptBuilder();
    }

    this.status = "starting"; // starting | idle | working | blocked | done | exited | error
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
          if (this.status === "exited" || this.status === "error") return;
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
    this.evidence = evidenceFor(this.builder.current);
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
    if (this.status !== "idle" && this.status !== "done") {
      throw new Error(`session is ${this.status}`);
    }
    this.status = "working";
    this.turnStartedAt = now();
    this.doneAt = null;
    this.stopReason = null;
    this.evidence = freshEvidence();
    this.driver
      .prompt(text)
      .then((r) => {
        this.stopReason = r?.stopReason ?? "end_turn";
        if (this.status === "working" || this.status === "blocked") {
          this.status = "done";
          this.doneAt = now();
          this.pendingPermission = null;
        }
        this.changed();
      })
      .catch((err) => {
        if (this.status === "working" || this.status === "blocked") {
          this.status = "done";
          this.stopReason = "error";
          this.doneAt = now();
          this.evidence.errors++;
          this.log(`turn failed: ${err.message}`);
        }
        this.changed();
      });
    this.changed();
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

  cancel() {
    const pendingRequestId = this.pendingPermission?.requestId;
    this.pendingPermission = null;
    this.blockedSince = null;
    if (this.status === "working" || this.status === "blocked") {
      this.driver.cancel({ pendingRequestId });
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
  constructor({ record = true, recordDir, log = () => {} } = {}) {
    super();
    this.record = record;
    this.recordDir = recordDir;
    this.log = log;
    this.sessions = new Map();
    this.counter = 0;
  }

  /** Spawn a session; returns at once — the agent boots in the background. */
  launch({ agent = "claude", cwd = process.cwd(), name, fleetUrl } = {}) {
    const id = randomBytes(6).toString("hex");
    const s = new AgentSession({
      id,
      name: name?.trim() || `${basename(cwd) || "agent"}-${++this.counter}`,
      agent,
      cwd,
      fleetUrl,
      record: this.record,
      recordDir: this.recordDir,
      log: this.log,
    });
    s.on("change", () => this.emit("change"));
    this.sessions.set(id, s);
    this.emit("change");
    s.start().catch((err) => s.fail(err.message));
    return s.snapshot();
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.snapshot());
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
