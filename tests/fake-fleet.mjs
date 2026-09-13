/**
 * A fleet whose agents do what the test says. Same surface the workspace
 * and coordinator use: launch / get / list, and sessions that emit
 * "change", expose a snapshot, and render a document with tool rows the
 * evidence engine can classify.
 */
import { EventEmitter } from "node:events";

export class FakeSession extends EventEmitter {
  constructor(id, input) {
    super();
    this.id = id;
    this.agent = input.agent;
    this.cwd = input.cwd;
    this.name = input.name;
    this.status = "idle";
    this.startedAt = new Date().toISOString();
    this.lastActivityAt = this.startedAt;
    this.doneAt = null;
    this.error = null;
    this.evidence = { testsPassed: 0, testsFailed: 0, errors: 0, edited: 0 };
    this.outputTokens = 0;
    this.costUsd = null;
    this.turns = 0;
    this.stopReason = null;
    this.cells = [];
    this.prompts = [];
  }
  get promptText() {
    return this.prompts.at(-1) ?? null;
  }
  snapshot() {
    return {
      id: this.id, agent: this.agent, agentLabel: this.agent === "claude" ? "claude code" : this.agent, driver: this.agent === "claude" ? "claude" : "acp", model: "fake-model",
      cwd: this.cwd, name: this.name, status: this.status, stopReason: this.stopReason, startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt, doneAt: this.doneAt, error: this.error,
      evidence: this.evidence, outputTokens: this.outputTokens, costUsd: this.costUsd,
    };
  }
  doc() {
    return { cells: this.cells, meta: { cwd: this.cwd } };
  }
  prompt(text) {
    this.prompts.push(text);
    this.turns += 1;
    this.status = "working";
    this.cells.push({ prompt: text, parts: [], outputTokens: 0 });
    this.lastActivityAt = new Date().toISOString();
    this.emit("change");
  }
  /** End the turn with the given evidence; parts become the document. */
  finish({ testsPassed = 1, testsFailed = 0, errors = 0, edited = 2, costUsd = null, parts = null, lastMessage = "Done." } = {}) {
    this.status = "done";
    this.stopReason = "end_turn";
    this.doneAt = new Date().toISOString();
    this.lastActivityAt = this.doneAt;
    this.outputTokens = 321;
    this.costUsd = costUsd;
    this.evidence = { testsPassed, testsFailed, errors, edited };
    const cell = this.cells.at(-1) ?? (this.cells.push({ prompt: "", parts: [], outputTokens: 0 }), this.cells.at(-1));
    cell.parts = parts ?? [
      { kind: "tool", tool: { id: "t1", name: "Edit", input: { title: "Edit src/a.ts", file_path: "src/a.ts", old_string: "a", new_string: "b" }, result: "ok", isError: false, status: "completed" } },
      { kind: "tool", tool: { id: "t2", name: "Bash", input: { title: "pnpm test", command: "pnpm test" }, result: testsFailed ? "✗ 1 failed\nTests  1 failed | 4 passed (5)" : "Tests  5 passed (5)", isError: testsFailed > 0, status: testsFailed ? "failed" : "completed" } },
      { kind: "text", text: lastMessage },
    ];
    this.emit("change");
  }
  cancel() {
    this.status = "done";
    this.stopReason = "cancelled";
    this.doneAt = new Date().toISOString();
    this.emit("change");
  }
  fail(message) {
    this.status = "error";
    this.error = message;
    this.emit("change");
  }
  close() {
    this.status = "exited";
    this.emit("change");
  }
}

export class FakeFleet {
  constructor() {
    this.sessions = new Map();
    this.counter = 0;
  }
  launch(input) {
    const session = new FakeSession(`fleet-${++this.counter}`, input);
    this.sessions.set(session.id, session);
    return session.snapshot();
  }
  get(id) {
    return this.sessions.get(id) ?? null;
  }
  list() {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }
  /**
   * Resolve once the nth session exists *and has been briefed* — launch
   * and prompt are separate steps, and tests want the agent as the
   * coordinator sees it: working on a prompt.
   */
  async session(n, timeoutMs = 5000) {
    const id = `fleet-${n}`;
    const until = Date.now() + timeoutMs;
    while (!this.sessions.get(id)?.prompts.length) {
      if (Date.now() > until) throw new Error(`${id} never launched and prompted`);
      await new Promise((r) => setTimeout(r, 15));
    }
    return this.sessions.get(id);
  }
}
