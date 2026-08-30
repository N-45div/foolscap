/**
 * From Devin's session API to a document.
 *
 * Devin is a cloud agent: no process, no stdio, no tool stream. What we
 * get is a session record — a status, a growing list of messages, an
 * optional pull request and structured output — polled over HTTP. The
 * driver turns each observation into a frame; this builder turns frames
 * into cells with the same shape as every other harness, live and from
 * a recording alike.
 *
 *   c2a  {type:"devin/prompt", text}      our prompt or follow-up
 *        {type:"devin/answer", text}      our reply to a question
 *   a2c  {type:"devin/session", session_id, url}
 *        {type:"devin/message", kind:"devin_message"|"user_message", message, at}
 *        {type:"devin/status", status_enum, question?, pull_request?, structured_output?}
 */

export class DevinBuilder {
  constructor() {
    this.cells = [];
    this.current = null;
    this.entryCount = 0;
    this.plan = null;
    this.activity = null;
    this.url = null;
    this.pullRequest = null;
    this.totalOutputTokens = 0;
    this.lastStatus = null;
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
      if (msg.type === "devin/prompt") {
        this.openCell(String(msg.text ?? "").trim() || "(empty prompt)", at);
        this.activity = { kind: "thinking", text: "sending to devin" };
      } else if (msg.type === "devin/answer") {
        this.cell(at).parts.push({
          kind: "text",
          text: `> **you:** ${msg.text ?? ""}`,
          at,
        });
        this.activity = { kind: "thinking", text: "answered" };
      }
      return;
    }

    switch (msg.type) {
      case "devin/session":
        this.url = msg.url ?? this.url;
        return;

      case "devin/message": {
        // Our own messages come back as user_message echoes; skip them.
        if (!/devin/i.test(String(msg.kind ?? ""))) return;
        const text = String(msg.message ?? "").trim();
        if (!text) return;
        this.cell(at).parts.push({ kind: "text", text, at: msg.at ?? at });
        this.activity = { kind: "message", text: "replying" };
        return;
      }

      case "devin/status": {
        const st = msg.status_enum;
        this.lastStatus = st;
        const cell = this.cell(at);
        if (st === "blocked") {
          this.activity = { kind: "blocked", text: msg.question ?? "waiting for your answer" };
        } else if (st === "finished" || st === "expired") {
          if (msg.pull_request?.url) {
            this.pullRequest = msg.pull_request.url;
            cell.parts.push({ kind: "text", text: `**Pull request:** ${msg.pull_request.url}`, at });
          }
          if (msg.structured_output && Object.keys(msg.structured_output).length) {
            cell.parts.push({
              kind: "text",
              text: "```json\n" + JSON.stringify(msg.structured_output, null, 2) + "\n```",
              at,
            });
          }
          cell.stopReason = st === "finished" ? "end_turn" : "expired";
          this.activity = null;
        } else {
          this.activity = { kind: "tool", text: st ?? "working" };
        }
        return;
      }

      default:
        return;
    }
  }
}
