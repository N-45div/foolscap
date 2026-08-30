/**
 * The fleet — many agents, one queue.
 *
 * Working with five running agents fails for one reason: every surface
 * shows you five terminals, so you end up polling all of them, and the
 * bookkeeping costs more than the work. The fleet inverts that. foolscap
 * is the ACP *client* for each agent: it sends the prompts, receives
 * the stream, and answers permission requests — so it knows, exactly
 * and in real time, which agent is blocked on you, which one's tests
 * just went red, and which is fine and should be left alone. The UI
 * shows that as a queue, not a grid.
 *
 * Each AgentSession is one stdio ACP agent process. The transcript is
 * built by the same TranscriptBuilder the archive adapter uses, and
 * every frame is recorded, so a session looks identical while it runs
 * and after it ends. Evidence (tests red/green, errors, files edited)
 * comes from the same classifier the archive judge uses — the moat, in
 * the present tense.
 *
 * Capabilities we advertise to agents: none. No fs, no terminal. The
 * agent uses its own tools in its own cwd; foolscap only ever answers
 * session/request_permission. That keeps the trust boundary where the
 * harness already draws it.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Recorder, acpArchiveDir, resolveAgent, spawnAgent } from "./acp.mjs";
import { TranscriptBuilder } from "./acp-doc.mjs";
import { classifyRun, commandOf } from "./outcome.mjs";

const CLIENT_INFO = { name: "foolscap", title: "foolscap", version: "0.3.0" };
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
      tool.name === "edit" ||
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
    record = true,
    recordDir = acpArchiveDir(),
    log = () => {},
  }) {
    super();
    this.id = id;
    this.name = name;
    this.agent = agent;
    this.cwd = cwd;
    this.spec = resolveAgent(agent);
    this.record = record;
    this.recordDir = recordDir;
    this.log = log;

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
    this.sessionId = null;
    this.pendingPermission = null;
    this.evidence = freshEvidence();

    this.builder = new TranscriptBuilder();
    this.rpcId = 0;
    this.pending = new Map();
    this.buffered = "";
    this.child = null;
    this.recorder = null;
  }

  get turns() {
    return this.builder.cells.length;
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
        id: this.id,
        name: this.name,
        agent: this.spec.label,
        command: [this.spec.command, ...this.spec.args].join(" "),
        cwd: this.cwd,
        startedAt: this.startedAt,
      });
    }

    try {
      this.child = spawnAgent(this.spec, this.cwd);
    } catch (err) {
      this.fail(`could not start ${this.spec.command}: ${err.message}`);
      return;
    }

    this.child.stdout.on("data", (chunk) => {
      this.buffered += chunk.toString("utf8");
      let nl;
      while ((nl = this.buffered.indexOf("\n")) !== -1) {
        const line = this.buffered.slice(0, nl).trim();
        this.buffered = this.buffered.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // banners and warnings are not protocol
        }
        this.receive(msg);
      }
    });
    this.child.stderr.on("data", (c) =>
      this.log(`[${this.name}] ${c.toString().trim()}`),
    );
    this.child.on("error", (err) => this.fail(err.message));
    this.child.on("exit", (code) => {
      if (this.status === "exited" || this.status === "error") return;
      this.exitCode = code;
      this.endedAt = now();
      this.status = code === 0 ? "exited" : "error";
      if (code !== 0) this.error ??= `agent exited with code ${code}`;
      for (const [, p] of this.pending) p.reject(new Error("agent exited"));
      this.pending.clear();
      this.changed();
    });

    try {
      await this.rpc("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: CLIENT_INFO,
      });
      const r = await this.rpc("session/new", { cwd: this.cwd, mcpServers: [] });
      this.sessionId = r?.sessionId ?? null;
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
    this.log(`[${this.name}] ${message}`);
    this.changed();
  }

  send(msg) {
    this.recorder?.frame("c2a", msg);
    this.builder.feed("c2a", msg, now());
    this.child?.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** JSON-RPC request. timeout 0 = wait forever (a prompt turn). */
  rpc(method, params, { timeout = 90_000 } = {}) {
    const id = this.rpcId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out`));
            }, timeout)
          : null;
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  receive(msg) {
    this.recorder?.frame("a2c", msg);
    this.builder.feed("a2c", msg, now());
    this.lastActivityAt = now();

    if (msg.id !== undefined && msg.method === undefined) {
      // Response to one of our requests.
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "agent error"));
        else p.resolve(msg.result);
      }
    } else if (msg.method && msg.id !== undefined) {
      // A request from the agent to us.
      if (msg.method === "session/request_permission") {
        this.pendingPermission = {
          requestId: msg.id,
          toolCall: msg.params?.toolCall ?? {},
          options: msg.params?.options ?? [],
        };
        this.status = "blocked";
        this.blockedSince = now();
      } else {
        // We advertised no fs/terminal capabilities; say so honestly.
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `foolscap does not provide ${msg.method}` },
        });
      }
    } else if (msg.method === "session/update") {
      const u = msg.params?.update ?? {};
      const kind = u.sessionUpdate ?? u.type;
      if (kind === "tool_call" || kind === "tool_call_update") {
        this.evidence = evidenceFor(this.builder.current);
      }
    }
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
    this.rpc(
      "session/prompt",
      { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
      { timeout: 0 },
    )
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
          this.log(`[${this.name}] turn failed: ${err.message}`);
        }
        this.changed();
      });
    this.changed();
  }

  answerPermission(optionId) {
    const p = this.pendingPermission;
    if (!p) throw new Error("no permission is pending");
    if (p.options.length && !p.options.some((o) => o.optionId === optionId)) {
      throw new Error(`unknown option ${optionId}`);
    }
    this.send({
      jsonrpc: "2.0",
      id: p.requestId,
      result: { outcome: { outcome: "selected", optionId } },
    });
    this.pendingPermission = null;
    this.blockedSince = null;
    this.status = "working";
    this.changed();
  }

  cancel() {
    if (this.pendingPermission) {
      this.send({
        jsonrpc: "2.0",
        id: this.pendingPermission.requestId,
        result: { outcome: { outcome: "cancelled" } },
      });
      this.pendingPermission = null;
      this.blockedSince = null;
    }
    if (this.status === "working" || this.status === "blocked") {
      this.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.sessionId },
      });
    }
    this.changed();
  }

  close() {
    if (this.status !== "exited" && this.status !== "error") {
      this.status = "exited";
      this.endedAt = now();
    }
    this.child?.kill();
    for (const [, p] of this.pending) p.reject(new Error("session closed"));
    this.pending.clear();
    this.changed();
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      agent: this.agent,
      agentLabel: this.spec.label,
      cwd: this.cwd,
      status: this.status,
      stopReason: this.stopReason,
      activity: this.builder.activity,
      plan: this.builder.plan,
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
    return {
      cells: this.builder.cells,
      meta: {
        cwd: this.cwd,
        agent: `${this.spec.label} · acp`,
        startedAt: this.startedAt,
        endedAt: this.endedAt ?? undefined,
        totalOutputTokens: 0,
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
  launch({ agent = "claude", cwd = process.cwd(), name } = {}) {
    const id = randomBytes(6).toString("hex");
    const s = new AgentSession({
      id,
      name: name?.trim() || `${basename(cwd) || "agent"}-${++this.counter}`,
      agent,
      cwd,
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
