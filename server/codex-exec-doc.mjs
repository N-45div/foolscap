/**
 * From `codex exec --json` events to a document.
 *
 *   c2a  {type:"prompt", text}                       (drivers/codex-exec.mjs)
 *   a2c  {type:"thread.started", thread_id}
 *        {type:"turn.started"} / {type:"turn.completed", usage}
 *        {type:"turn.failed", error} / {type:"error", message}
 *        {type:"item.started"|"item.updated"|"item.completed", item}
 *
 * Items become parts: an agent_message is text, a command_execution is
 * an `execute` tool row with its real exit code (what the evidence gate
 * reads), and a file_change is one edit row per file so the edited count
 * and the "later edit makes earlier tests stale" rule both work.
 */

export class CodexExecBuilder {
  constructor() {
    this.cells = [];
    this.current = null;
    this.entryCount = 0;
    this.plan = null;
    this.activity = null;
    this.model = null;
    this.totalOutputTokens = 0;
    this.costUsd = null; // a subscription run has no per-call price
  }

  openCell(prompt, at) {
    this.current = { prompt, promptAt: at, parts: [], outputTokens: 0 };
    this.cells.push(this.current);
    return this.current;
  }

  cell(at) {
    return this.current ?? this.openCell("(session resumed)", at);
  }

  /** The tool row for an item id, created on first sight. */
  tool(cell, id, at, init) {
    let part = cell.parts.find((p) => p.kind === "tool" && p.tool.id === id);
    if (!part) {
      part = { kind: "tool", at, tool: { id, isError: false, status: "in_progress", ...init } };
      cell.parts.push(part);
    }
    return part.tool;
  }

  feed(dir, msg, at) {
    if (!msg || typeof msg !== "object") return;
    this.entryCount++;

    if (dir === "c2a") {
      if (msg.type === "prompt") {
        this.openCell(String(msg.text ?? "").trim() || "(empty prompt)", at);
        this.activity = { kind: "thinking", text: "thinking" };
      }
      return;
    }

    const cell = this.cell(at);
    if (msg.type === "turn.completed") {
      const out = Number(msg.usage?.output_tokens ?? 0);
      cell.outputTokens += out;
      this.totalOutputTokens += out;
      cell.stopReason = "end_turn";
      this.activity = null;
      return;
    }
    if (msg.type === "turn.failed" || msg.type === "error") {
      const text = msg.error?.message ?? msg.message ?? "Codex reported an error";
      cell.parts.push({ kind: "text", text: `Error: ${text}`, at });
      cell.stopReason = "error";
      this.activity = null;
      return;
    }
    if (!msg.type?.startsWith("item.") || !msg.item) return;

    const item = msg.item;
    const done = msg.type === "item.completed";
    if (item.type === "agent_message" && done) {
      if (item.text) cell.parts.push({ kind: "text", text: item.text, at });
      this.activity = { kind: "message", text: "replying" };
    } else if (item.type === "reasoning") {
      this.activity = { kind: "thinking", text: "thinking" };
    } else if (item.type === "command_execution") {
      const tool = this.tool(cell, item.id, at, {
        name: "execute",
        input: { command: item.command, title: item.command },
      });
      tool.result = String(item.aggregated_output ?? "").slice(0, 20_000);
      if (typeof item.exit_code === "number") tool.exitCode = item.exit_code;
      tool.status = item.status ?? (done ? "completed" : "in_progress");
      tool.isError = done && (item.status === "failed" || (item.exit_code ?? 0) !== 0);
      this.activity = done ? null : { kind: "tool", text: `running ${shortCommand(item.command)}` };
    } else if (item.type === "file_change" && done) {
      for (const change of item.changes ?? []) {
        this.tool(cell, `${item.id}:${change.path}`, at, {
          name: "Edit",
          input: { file_path: change.path, kind: change.kind },
          status: "completed",
        });
      }
      this.activity = { kind: "tool", text: `edited ${item.changes?.length ?? 0} file(s)` };
    } else if (item.type === "todo_list") {
      this.plan = (item.items ?? []).map((t) => ({ content: t.text, status: t.completed ? "completed" : "pending" }));
    } else if (item.type === "mcp_tool_call" || item.type === "web_search") {
      const tool = this.tool(cell, item.id, at, {
        name: item.type === "web_search" ? "WebSearch" : `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
        input: item.arguments ?? { query: item.query },
      });
      tool.status = item.status ?? (done ? "completed" : "in_progress");
      tool.isError = item.status === "failed";
    }
  }
}

/** The command itself, without the shell Codex wraps it in. */
function shortCommand(command) {
  const text = String(command ?? "");
  const inner = text.match(/-Command\s+'(.*)'$|-l?c\s+'(.*)'$/s);
  return (inner?.[1] ?? inner?.[2] ?? text).slice(0, 60);
}
