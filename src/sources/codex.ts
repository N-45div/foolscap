import type { Cell, SessionDoc, ToolInteraction } from "../model";

/**
 * Codex CLI adapter — parses OpenAI Codex "rollout" JSONL
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) into the neutral
 * SessionDoc. Grounded against real rollout files, tolerant everywhere:
 * unknown payload types are skipped, never fatal.
 *
 * Shape observed in the wild:
 *   {timestamp, type: "session_meta"|"turn_context"|"response_item"|"event_msg", payload}
 *   response_item payloads: message{role, content[{type, text}]},
 *     function_call{name, arguments(JSON string), call_id},
 *     function_call_output{call_id, output}, reasoning{summary[], encrypted_content}
 */

type RawLine = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    // session_meta / turn_context
    cwd?: string;
    cli_version?: string;
    model?: string;
    // message
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    // function_call / output
    id?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string;
    // reasoning
    summary?: Array<{ text?: string } | string>;
  };
};

const IDE_PROMPT_MARKER = "## My request for Codex:";

/** Codex wraps real prompts in IDE context; unwrap or reject. */
function extractPrompt(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith("<")) return null; // permissions, environment_context, …
  if (t.startsWith("# Context from my IDE setup")) {
    const i = t.indexOf(IDE_PROMPT_MARKER);
    if (i === -1) return null;
    const req = t.slice(i + IDE_PROMPT_MARKER.length).trim();
    return req || null;
  }
  return t;
}

function joinText(content?: Array<{ type?: string; text?: string }>): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => b?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

export function parseCodexSession(ndjson: string): SessionDoc {
  const doc: SessionDoc = {
    cells: [],
    meta: { totalOutputTokens: 0, entryCount: 0, skippedLines: 0 },
  };

  const toolsById = new Map<string, ToolInteraction>();
  let current: Cell | null = null;
  let cliVersion: string | undefined;
  let model: string | undefined;

  const openCell = (prompt: string, at?: string) => {
    current = { prompt, promptAt: at, parts: [], outputTokens: 0 };
    doc.cells.push(current);
  };

  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let entry: RawLine;
    try {
      entry = JSON.parse(line) as RawLine;
    } catch {
      doc.meta.skippedLines++;
      continue;
    }

    doc.meta.entryCount++;
    const p = entry.payload;
    if (!p) continue;
    if (entry.timestamp) {
      doc.meta.startedAt ??= entry.timestamp;
      doc.meta.endedAt = entry.timestamp;
    }

    if (entry.type === "session_meta") {
      doc.meta.cwd ??= p.cwd;
      cliVersion ??= p.cli_version;
      continue;
    }
    if (entry.type === "turn_context") {
      doc.meta.cwd ??= p.cwd;
      model ??= p.model;
      continue;
    }
    if (entry.type !== "response_item") continue; // event_msg duplicates response_items

    if (p.type === "message") {
      if (p.role === "user") {
        const prompt = extractPrompt(joinText(p.content));
        if (prompt) openCell(prompt, entry.timestamp);
      } else if (p.role === "assistant") {
        if (!current) openCell("(session resumed)", entry.timestamp);
        const text = joinText(p.content);
        if (text)
          (current as unknown as Cell).parts.push({
            kind: "text",
            text,
            at: entry.timestamp,
          });
      }
      // role "developer" = harness plumbing, skipped
      continue;
    }

    if (p.type === "function_call" && p.call_id) {
      if (!current) openCell("(session resumed)", entry.timestamp);
      let input: Record<string, unknown> = {};
      try {
        input = p.arguments ? JSON.parse(p.arguments) : {};
      } catch {
        input = { arguments: p.arguments };
      }
      const tool: ToolInteraction = {
        id: p.call_id,
        name: p.name ?? "unknown",
        input,
        isError: false,
      };
      toolsById.set(p.call_id, tool);
      (current as unknown as Cell).parts.push({
        kind: "tool",
        tool,
        at: entry.timestamp,
      });
      continue;
    }

    if (p.type === "function_call_output" && p.call_id) {
      const tool = toolsById.get(p.call_id);
      if (tool && typeof p.output === "string") {
        tool.result = p.output.slice(0, 20_000);
        tool.isError = /^Exit code: [1-9]/m.test(p.output);
      }
      continue;
    }

    if (p.type === "reasoning") {
      // Content is encrypted at rest; only summaries are renderable.
      const summary = (p.summary ?? [])
        .map((s) => (typeof s === "string" ? s : (s?.text ?? "")))
        .filter(Boolean)
        .join("\n");
      if (summary && current) {
        (current as unknown as Cell).parts.push({
          kind: "thinking",
          text: summary,
          at: entry.timestamp,
        });
      }
    }
  }

  doc.meta.agent = ["codex", cliVersion, model].filter(Boolean).join(" · ");
  return doc;
}
