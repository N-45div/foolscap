import type { Cell, SessionDoc, ToolInteraction } from "../model";

/**
 * DeepSeek Harness (dsh) adapter — parses the append-only session log
 * (~/.dsh/…/<sessionId>/session.jsonl[.zstd]) into the neutral SessionDoc.
 *
 * Format, grounded in deepseek-harness source
 * (packages/session/session-persistence-jsonl, packages/core/session):
 *   line 1  header  {type:'session', version, id, createdAt, cwd?,
 *                    agentPreset?, origin?:'subagent', parentSession?}
 *   after   events  {type, seq, time, data}
 *     user/message       {message}                       → opens a cell
 *     assistant/message  {turn, step, message, usage?}   → text + thinking
 *     tool/call          {turn, step, callId, name, arguments} → ledger row
 *     tool/result        {callId, message, error?}       → pairs by callId
 *   assistant/chunk is the streaming increment of assistant/message and is
 *   skipped; compaction/approval/plan/hook events are counted, not drawn.
 *
 * .jsonl.zstd files are decompressed by the server before the raw text
 * reaches this parser — adapters always receive plain NDJSON.
 */

type RawEvent = {
  type?: string;
  seq?: number;
  time?: number;
  data?: {
    message?: unknown;
    usage?: Record<string, unknown>;
    callId?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    error?: { name?: string; code?: string };
  };
  // header fields (line 1 shares the JSON.parse path)
  version?: number;
  id?: string;
  createdAt?: number;
  cwd?: string;
  agentPreset?: string;
  origin?: string;
  parentSession?: string;
};

/** Message payload shapes are model-adapter-defined; read them loosely. */
function msgText(m: unknown): string {
  if (typeof m === "string") return m;
  if (!m || typeof m !== "object") return "";
  const o = m as Record<string, unknown>;
  if (typeof o.text === "string") return o.text;
  const c = o.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        typeof b === "string"
          ? b
          : ((b as Record<string, unknown>)?.text as string) ?? "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** DeepSeek models surface reasoning under a few names; try them all. */
function msgReasoning(m: unknown): string {
  if (!m || typeof m !== "object") return "";
  const o = m as Record<string, unknown>;
  const r = o.reasoning ?? o.reasoning_content ?? o.reasoningContent;
  return typeof r === "string" ? r : "";
}

function usageOut(u?: Record<string, unknown>): number {
  if (!u) return 0;
  const n =
    u.outputTokens ??
    u.output_tokens ??
    u.completionTokens ??
    u.completion_tokens;
  return typeof n === "number" ? n : 0;
}

const iso = (ms?: number): string | undefined =>
  typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : undefined;

export function parseDshSession(ndjson: string): SessionDoc {
  const doc: SessionDoc = {
    cells: [],
    meta: { totalOutputTokens: 0, entryCount: 0, skippedLines: 0 },
  };

  const toolsById = new Map<string, ToolInteraction>();
  let current: Cell | null = null;
  let preset: string | undefined;

  const openCell = (prompt: string, at?: string) => {
    current = { prompt, promptAt: at, parts: [], outputTokens: 0 };
    doc.cells.push(current);
  };

  let sawHeader = false;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let e: RawEvent;
    try {
      e = JSON.parse(line) as RawEvent;
    } catch {
      doc.meta.skippedLines++;
      continue;
    }
    doc.meta.entryCount++;

    if (!sawHeader && e.type === "session") {
      sawHeader = true;
      doc.meta.cwd = e.cwd;
      doc.meta.startedAt = iso(e.createdAt);
      if (typeof e.version === "number") doc.meta.version = `v${e.version}`;
      preset = e.agentPreset;
      continue;
    }

    const at = iso(e.time);
    if (at) doc.meta.endedAt = at;
    const d = e.data;
    if (!d) continue;

    if (e.type === "user/message") {
      const prompt = msgText(d.message).trim();
      // Context injections are separate events, but stay defensive.
      if (prompt && !prompt.startsWith("<")) openCell(prompt, at);
      continue;
    }

    if (e.type === "assistant/message") {
      if (!current) openCell("(session resumed)", at);
      const cell = current as unknown as Cell;
      const thinking = msgReasoning(d.message);
      if (thinking) cell.parts.push({ kind: "thinking", text: thinking, at });
      const text = msgText(d.message);
      if (text) cell.parts.push({ kind: "text", text, at });
      const out = usageOut(d.usage);
      cell.outputTokens += out;
      doc.meta.totalOutputTokens += out;
      continue;
    }

    if (e.type === "tool/call") {
      if (!current) openCell("(session resumed)", at);
      const id = d.callId ?? d.call_id;
      if (!id) continue;
      let input: Record<string, unknown> = {};
      try {
        input = d.arguments ? JSON.parse(d.arguments) : {};
      } catch {
        input = { arguments: d.arguments };
      }
      const tool: ToolInteraction = {
        id,
        name: d.name ?? "unknown",
        input,
        isError: false,
      };
      toolsById.set(id, tool);
      (current as unknown as Cell).parts.push({ kind: "tool", tool, at });
      continue;
    }

    if (e.type === "tool/result") {
      const id = d.callId ?? d.call_id;
      const tool = id ? toolsById.get(id) : undefined;
      if (!tool) continue;
      const body = msgText(d.message);
      if (d.error) {
        tool.isError = true;
        tool.result = [
          [d.error.name, d.error.code].filter(Boolean).join(" · "),
          body,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 20_000);
      } else if (body) {
        tool.result = body.slice(0, 20_000);
      }
    }
    // turn/*, step/*, assistant/chunk, compaction/*, approval/*, hook/*,
    // todo/*, subagent/descriptor …: counted via entryCount, not rendered.
  }

  doc.meta.agent = ["deepseek dsh", preset].filter(Boolean).join(" · ");
  return doc;
}
