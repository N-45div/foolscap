/**
 * The notebook model, and the parser that builds it from Claude Code's
 * session JSONL.
 *
 * Design rule: the on-disk schema is undocumented and drifts across
 * versions, so parsing is tolerant everywhere — unknown entry types are
 * skipped, missing fields default, and nothing here ever throws on a
 * malformed line. A session that half-parses renders half a notebook,
 * never a blank screen.
 */

// ── Raw wire shapes (loose on purpose) ────────────────────────────────

type RawContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type RawEntry = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  summary?: string;
  message?: {
    role?: string;
    content?: string | RawContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
};

// ── Notebook model ────────────────────────────────────────────────────

export type ToolInteraction = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError: boolean;
};

export type Cell = {
  /** The user's prompt that opened this cell. */
  prompt: string;
  promptAt?: string;
  /** Interleaved assistant output, in order. */
  parts: Array<
    | { kind: "text"; text: string; at?: string }
    | { kind: "thinking"; text: string; at?: string }
    | { kind: "tool"; tool: ToolInteraction; at?: string }
  >;
  outputTokens: number;
};

export type SessionDoc = {
  cells: Cell[];
  meta: {
    cwd?: string;
    gitBranch?: string;
    version?: string;
    /** Display label for the harness that produced this session,
        e.g. "claude code 2.1.223" or "codex · 0.142.2 · gpt-5.5". */
    agent?: string;
    startedAt?: string;
    endedAt?: string;
    totalOutputTokens: number;
    entryCount: number;
    skippedLines: number;
  };
};

// ── Helpers ───────────────────────────────────────────────────────────

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string" ? b : ((b as RawContentBlock)?.text ?? ""),
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** System-generated user entries that aren't real prompts. */
function isSyntheticPrompt(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<") || // command wrappers, system reminders, caveats
    t.startsWith("[Request interrupted") ||
    t.startsWith("[SYSTEM NOTIFICATION")
  );
}

// ── Parser ────────────────────────────────────────────────────────────

export function parseSession(ndjson: string): SessionDoc {
  const doc: SessionDoc = {
    cells: [],
    meta: { totalOutputTokens: 0, entryCount: 0, skippedLines: 0 },
  };

  const toolsById = new Map<string, ToolInteraction>();
  let current: Cell | null = null;

  const openCell = (prompt: string, at?: string) => {
    current = { prompt, promptAt: at, parts: [], outputTokens: 0 };
    doc.cells.push(current);
  };

  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;

    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      doc.meta.skippedLines++;
      continue;
    }

    doc.meta.entryCount++;
    if (entry.isSidechain) continue; // subagent traffic — v0.2
    if (entry.timestamp) {
      doc.meta.startedAt ??= entry.timestamp;
      doc.meta.endedAt = entry.timestamp;
    }
    doc.meta.cwd ??= entry.cwd;
    doc.meta.gitBranch ??= entry.gitBranch;
    doc.meta.version ??= entry.version;

    if (entry.type === "user" && entry.message) {
      const content = entry.message.content;

      // Tool results arrive as user-role entries; attach them to their call.
      if (Array.isArray(content)) {
        let sawToolResult = false;
        for (const block of content) {
          if (block?.type === "tool_result" && block.tool_use_id) {
            sawToolResult = true;
            const tool = toolsById.get(block.tool_use_id);
            if (tool) {
              tool.result = blockText(block.content).slice(0, 20_000);
              tool.isError = block.is_error === true;
            }
          }
        }
        if (sawToolResult) continue;
      }

      const text = blockText(content);
      if (text && !isSyntheticPrompt(text)) {
        openCell(text, entry.timestamp);
      }
      continue;
    }

    if (entry.type === "assistant" && entry.message) {
      // Assistant output before any real prompt (hooks, resumes): show it
      // under an implicit cell rather than dropping it.
      if (!current) openCell("(session resumed)", entry.timestamp);
      const cell = current as unknown as Cell;

      const usage = entry.message.usage;
      if (usage?.output_tokens) {
        cell.outputTokens += usage.output_tokens;
        doc.meta.totalOutputTokens += usage.output_tokens;
      }

      const content = entry.message.content;
      if (typeof content === "string") {
        if (content) {
          cell.parts.push({ kind: "text", text: content, at: entry.timestamp });
        }
        continue;
      }
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block?.type === "text" && block.text) {
          cell.parts.push({
            kind: "text",
            text: block.text,
            at: entry.timestamp,
          });
        } else if (block?.type === "thinking" && block.thinking) {
          cell.parts.push({
            kind: "thinking",
            text: block.thinking,
            at: entry.timestamp,
          });
        } else if (block?.type === "tool_use" && block.id) {
          const tool: ToolInteraction = {
            id: block.id,
            name: block.name ?? "unknown",
            input: block.input ?? {},
            isError: false,
          };
          toolsById.set(block.id, tool);
          cell.parts.push({ kind: "tool", tool, at: entry.timestamp });
        }
      }
      continue;
    }

    // summary / attachment / system / future types: counted, not rendered.
  }

  if (doc.meta.version) doc.meta.agent = `claude code ${doc.meta.version}`;
  return doc;
}

// ── Session listing (adapter types) ───────────────────────────────────

export type SessionRef = {
  id: string;
  file: string;
  bytes: number;
  modified: number;
};

export type ProjectRef = { dir: string; sessions: SessionRef[] };

/** `c--Users-DivijN-Spatialize` → best-effort `C:\Users\DivijN\Spatialize` */
export function prettyProjectName(dir: string): string {
  const m = /^([a-z])--(.+)$/i.exec(dir);
  if (!m) return dir;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/-/g, "\\")}`;
}
