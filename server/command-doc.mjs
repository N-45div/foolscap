/**
 * From a headless command's frames to a document.
 *
 *   c2a  {type:"command/prompt", text, argv}
 *        {type:"command/cancel"}
 *   a2c  {type:"command/output", json, text, stderr}
 *        {type:"command/exit", code, error?}
 *
 * The agent's answer is whatever it printed: a JSON document's obvious
 * text field when it printed one (output / result / message / text /
 * content), otherwise stdout as-is. The full JSON, when present, is
 * kept as a collapsed tool row so nothing is lost.
 */

const pickText = (json) => {
  if (!json || typeof json !== "object") return null;
  for (const k of ["output", "result", "response", "message", "text", "content", "summary"]) {
    const v = json[k];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v)) {
      const t = v.map((x) => (typeof x === "string" ? x : x?.text ?? "")).filter(Boolean).join("\n");
      if (t.trim()) return t;
    }
  }
  return null;
};

export class CommandBuilder {
  constructor() {
    this.cells = [];
    this.current = null;
    this.entryCount = 0;
    this.plan = null;
    this.activity = null;
    this.totalOutputTokens = 0;
  }

  openCell(prompt, at) {
    this.current = { prompt, promptAt: at, parts: [], outputTokens: 0 };
    this.cells.push(this.current);
    return this.current;
  }

  cell(at) {
    return this.current ?? this.openCell("(session resumed)", at);
  }

  feed(dir, msg, at) {
    if (!msg || typeof msg !== "object") return;
    this.entryCount++;

    if (dir === "c2a") {
      if (msg.type === "command/prompt") {
        const cell = this.openCell(String(msg.text ?? "").trim() || "(empty prompt)", at);
        if (Array.isArray(msg.argv)) {
          cell.parts.push({
            kind: "tool",
            at,
            tool: {
              id: `run-${this.cells.length}`,
              name: "execute",
              input: { title: msg.argv.join(" "), command: msg.argv.join(" ") },
              isError: false,
              status: "in_progress",
            },
          });
        }
        this.activity = { kind: "tool", text: "running" };
      } else if (msg.type === "command/cancel" && this.current) {
        this.current.stopReason = "cancelled";
        this.activity = null;
      }
      return;
    }

    const cell = this.cell(at);
    const run = cell.parts.find((p) => p.kind === "tool" && p.tool.name === "execute")?.tool;

    if (msg.type === "command/output") {
      const text = pickText(msg.json) ?? String(msg.text ?? "").trim();
      if (text) cell.parts.push({ kind: "text", text, at });
      if (run) {
        run.result = [msg.text, msg.stderr ? `--- stderr ---\n${msg.stderr}` : ""]
          .filter(Boolean)
          .join("\n")
          .slice(0, 20_000);
      }
      this.activity = { kind: "message", text: "replying" };
      return;
    }

    if (msg.type === "command/exit") {
      const failed = msg.code !== 0;
      if (run) {
        run.status = failed ? "failed" : "completed";
        run.isError = failed;
        if (msg.error) run.result = [run.result, msg.error].filter(Boolean).join("\n");
      }
      cell.stopReason = failed ? "error" : "end_turn";
      this.activity = null;
    }
  }
}
