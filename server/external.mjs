/**
 * Claude Code sessions the person started themselves, in a terminal or
 * an editor, brought into the inbox through Claude Code's hooks.
 *
 * foolscap does not drive these sessions; it hears about them. Claude
 * Code posts each hook event (SessionStart, UserPromptSubmit,
 * PermissionRequest, Stop, SessionEnd) to the app, and this registry
 * turns them into sessions shaped like the ones foolscap runs, so the
 * panel, the ranking and the notifications treat both alike.
 *
 * Two hooks can answer back:
 * - PermissionRequest is held while the person decides in foolscap.
 *   After `holdMs` without an answer it returns no decision, and Claude
 *   Code asks in the terminal as it always did.
 * - Stop delivers a queued next prompt, but only after the repo's own
 *   tests come back green; anything else holds the queue, with the reason.
 *
 * If foolscap is not running, the hook cannot connect and Claude Code
 * carries on as if foolscap did not exist.
 */
import { EventEmitter } from "node:events";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { titleOf } from "./claude-stream.mjs";
import { verifyRepo } from "./verify.mjs";

const now = () => new Date().toISOString();

/** The assistant's last words in a Claude Code transcript (read from its tail). */
export async function lastAssistantText(file, bytes = 256 * 1024) {
  if (!file) return null;
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split(/\r?\n/).reverse();
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // the first line of a tail is usually cut
      }
      if (entry.type !== "assistant") continue;
      const text = (entry.message?.content ?? [])
        .filter((c) => c.type === "text" && c.text?.trim())
        .map((c) => c.text.trim())
        .join("\n");
      if (text) return text.slice(0, 2000);
    }
  } catch {
    // unreadable transcript: no reply to show
  } finally {
    await handle?.close();
  }
  return null;
}

class ExternalSession {
  constructor(registry, payload) {
    this.registry = registry;
    this.id = `claude:${payload.session_id}`;
    this.sessionId = payload.session_id;
    this.cwd = payload.cwd ?? "";
    this.name = basename(this.cwd) || "terminal";
    this.transcriptPath = payload.transcript_path ?? null;
    this.status = "idle";
    this.startedAt = now();
    this.turnStartedAt = null;
    this.doneAt = null;
    this.blockedSince = null;
    this.turns = 0;
    this.lastPrompt = null;
    this.lastReply = null;
    this.pendingPermission = null;
    this.queue = [];
    this.held = null;
    this.verified = null;
    this.waiter = null; // resolves the held PermissionRequest
  }

  changed() {
    this.registry.emit("change", this);
  }

  answerPermission(optionId) {
    const p = this.pendingPermission;
    if (!p) throw new Error("no permission is pending");
    this.waiter?.(/allow/i.test(optionId) ? "allow" : "deny");
  }

  /** Queue a prompt for the next time this session stops. */
  enqueue(text) {
    const prompt = String(text ?? "").trim();
    if (!prompt) throw new Error("a prompt is required");
    this.queue.push(prompt);
    this.held = null;
    this.changed();
  }

  /** Nothing can be typed into someone else's terminal; it waits for the next stop. */
  prompt(text) {
    this.enqueue(text);
  }

  dequeue(index) {
    if (index < 0 || index >= this.queue.length) throw new Error("no such queued prompt");
    this.queue.splice(index, 1);
    if (!this.queue.length) this.held = null;
    this.changed();
  }

  sendNext() {
    throw new Error("this session runs in your terminal: the next prompt goes out when it next stops");
  }

  cancel() {
    throw new Error("this session runs in your terminal: stop it there");
  }

  close() {
    this.waiter?.("none");
    this.registry.sessions.delete(this.id);
    this.registry.emit("change", null);
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      agent: "claude-terminal",
      agentLabel: "Claude Code · terminal",
      external: true,
      driver: "hooks",
      cwd: this.cwd,
      status: this.status,
      stopReason: null,
      activity: this.status === "working" ? { kind: "tool", text: "working in your terminal" } : null,
      plan: null,
      pendingPermission: this.pendingPermission,
      evidence: { testsPassed: 0, testsFailed: 0, errors: 0, edited: 0 },
      validations: [],
      verified: this.verified,
      queue: [...this.queue],
      held: this.held,
      assistant: false,
      worktree: null,
      changes: null,
      merged: null,
      lastPrompt: this.lastPrompt,
      lastReply: this.lastReply,
      turns: this.turns,
      startedAt: this.startedAt,
      turnStartedAt: this.turnStartedAt,
      doneAt: this.doneAt,
      blockedSince: this.blockedSince,
      endedAt: null,
      lastActivityAt: now(),
      exitCode: null,
      error: null,
    };
  }
}

export class ExternalSessions extends EventEmitter {
  constructor({ holdMs = 45_000, verify = verifyRepo, log = () => {} } = {}) {
    super();
    this.sessions = new Map();
    this.holdMs = holdMs;
    this.verify = verify;
    this.log = log;
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  sessionFor(payload) {
    const id = `claude:${payload.session_id}`;
    let s = this.sessions.get(id);
    if (!s) {
      s = new ExternalSession(this, payload);
      this.sessions.set(id, s);
    }
    if (payload.cwd) s.cwd = payload.cwd;
    if (payload.transcript_path) s.transcriptPath = payload.transcript_path;
    return s;
  }

  /**
   * One hook event in, the JSON to answer Claude Code with out. An empty
   * object means "no opinion": Claude Code carries on as it would have.
   */
  async handle(payload) {
    if (!payload?.session_id || !payload.hook_event_name) return {};
    const event = payload.hook_event_name;
    if (event === "SessionEnd") {
      this.get(`claude:${payload.session_id}`)?.close();
      return {};
    }
    const s = this.sessionFor(payload);

    if (event === "SessionStart") {
      s.changed();
      return {};
    }
    if (event === "UserPromptSubmit") {
      s.status = "working";
      s.turns++;
      s.turnStartedAt = now();
      s.lastPrompt = String(payload.prompt ?? "").slice(0, 2000) || s.lastPrompt;
      s.held = null;
      s.verified = null;
      s.changed();
      return {};
    }
    if (event === "PermissionRequest") return this.permission(s, payload);
    if (event === "Stop" || event === "SubagentStop") {
      if (event === "SubagentStop") return {};
      return this.stop(s, payload);
    }
    return {};
  }

  /** Hold the request while the person decides here, then answer Claude Code. */
  async permission(s, payload) {
    const requestId = payload.tool_use_id ?? `ext-${Date.now()}`;
    s.pendingPermission = {
      requestId,
      toolCall: { title: titleOf(payload.tool_name, payload.tool_input) || payload.tool_name || "tool", kind: "other" },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "reject_once", name: "Deny", kind: "reject_once" },
      ],
    };
    s.status = "blocked";
    s.blockedSince = now();
    s.changed();
    const choice = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("none"), this.holdMs);
      s.waiter = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
    s.waiter = null;
    s.pendingPermission = null;
    s.blockedSince = null;
    if (s.status === "blocked") s.status = "working";
    s.changed();
    if (choice === "none") return {}; // Claude Code asks in the terminal instead
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: choice === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "Denied in foolscap." },
      },
    };
  }

  /** The session finished a turn: deliver the next queued prompt on green. */
  async stop(s, payload) {
    s.lastReply = (await lastAssistantText(s.transcriptPath)) ?? s.lastReply;
    if (!s.queue.length) {
      s.status = "done";
      s.doneAt = now();
      s.changed();
      return {};
    }
    s.status = "checking";
    s.changed();
    s.verified = await this.verify(s.cwd).catch(() => null);
    const v = s.verified;
    if (v?.verdict === "green") {
      const next = s.queue.shift();
      s.status = "working";
      s.turns++;
      s.turnStartedAt = now();
      s.lastPrompt = next;
      s.changed();
      this.log(`terminal session ${s.name}: sent the next prompt (tests green)`);
      return { decision: "block", reason: next };
    }
    s.status = "done";
    s.doneAt = now();
    s.held = { reason: v ? `tests ${v.verdict}: ${v.reason}` : "no test command to check it with" };
    s.changed();
    return {};
  }
}
