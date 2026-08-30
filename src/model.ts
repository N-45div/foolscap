/**
 * The notebook model, and the parser that builds it from Claude Code's
 * session JSONL.
 *
 * Design rule: the on-disk schema is undocumented and drifts across
 * versions, so parsing is tolerant everywhere — unknown entry types are
 * skipped, missing fields default, and nothing here ever throws on a
 * malformed line. A session that half-parses renders half a notebook,
 * never a blank screen.
 *
 * Subagents: modern Claude Code stores each subagent's transcript as its
 * own file (<session-dir>/<session-id>/subagents/agent-<id>.jsonl) whose
 * entries carry isSidechain + agentId; older sessions interleaved those
 * entries in the main file. Both shapes parse here: entries are routed
 * into per-agent threads, and a file that is *entirely* one sidechain
 * becomes its own document.
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
  agentId?: string;
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
  /** For Agent tools: the spawned subagent's id, parsed from the result.
      The viewer uses it to lazy-load the subagent's own transcript. */
  subagentId?: string;
  /** Populated directly when the sidechain was stored in-file. */
  subagent?: SessionDoc;
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
    /** Display label for the harness that produced this session. */
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

// ── A single conversation thread (main, or one subagent) ──────────────

class Thread {
  cells: Cell[] = [];
  outputTokens = 0;
  private toolsById = new Map<string, ToolInteraction>();
  private current: Cell | null = null;

  private openCell(prompt: string, at?: string): void {
    this.current = { prompt, promptAt: at, parts: [], outputTokens: 0 };
    this.cells.push(this.current);
  }

  feedUser(entry: RawEntry): void {
    const content = entry.message?.content;

    // Tool results arrive as user-role entries; attach them to their call.
    if (Array.isArray(content)) {
      let sawToolResult = false;
      for (const block of content) {
        if (block?.type === "tool_result" && block.tool_use_id) {
          sawToolResult = true;
          const tool = this.toolsById.get(block.tool_use_id);
          if (tool) {
            tool.result = blockText(block.content).slice(0, 20_000);
            tool.isError = block.is_error === true;
          }
        }
      }
      if (sawToolResult) return;
    }

    const text = blockText(content);
    if (text && !isSyntheticPrompt(text)) {
      this.openCell(text, entry.timestamp);
    }
  }

  feedAssistant(entry: RawEntry): void {
    // Assistant output before any real prompt (hooks, resumes): show it
    // under an implicit cell rather than dropping it.
    if (!this.current) this.openCell("(session resumed)", entry.timestamp);
    const cell = this.current as Cell;

    const usage = entry.message?.usage;
    if (usage?.output_tokens) {
      cell.outputTokens += usage.output_tokens;
      this.outputTokens += usage.output_tokens;
    }

    const content = entry.message?.content;
    if (typeof content === "string") {
      if (content) {
        cell.parts.push({ kind: "text", text: content, at: entry.timestamp });
      }
      return;
    }
    if (!Array.isArray(content)) return;

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
        this.toolsById.set(block.id, tool);
        cell.parts.push({ kind: "tool", tool, at: entry.timestamp });
      }
    }
  }
}

// ── Parser ────────────────────────────────────────────────────────────

const AGENT_ID_IN_RESULT = /agentId:\s*([a-z0-9]{6,})/i;

function threadToDoc(thread: Thread, base: SessionDoc["meta"]): SessionDoc {
  return {
    cells: thread.cells,
    meta: { ...base, totalOutputTokens: thread.outputTokens },
  };
}

/** Walk a thread's Agent tool calls and link them to their subagents. */
function linkSubagents(
  cells: Cell[],
  inFileDocs: Map<string, SessionDoc>,
): void {
  for (const cell of cells) {
    for (const part of cell.parts) {
      if (part.kind !== "tool" || part.tool.name !== "Agent") continue;
      const id = AGENT_ID_IN_RESULT.exec(part.tool.result ?? "")?.[1];
      if (!id) continue;
      part.tool.subagentId = id;
      part.tool.subagent = inFileDocs.get(id);
    }
  }
}

export function parseSession(ndjson: string): SessionDoc {
  const meta: SessionDoc["meta"] = {
    totalOutputTokens: 0,
    entryCount: 0,
    skippedLines: 0,
  };

  const main = new Thread();
  const agents = new Map<string, Thread>();
  const threadFor = (entry: RawEntry): Thread => {
    if (!entry.isSidechain || !entry.agentId) return main;
    let t = agents.get(entry.agentId);
    if (!t) {
      t = new Thread();
      agents.set(entry.agentId, t);
    }
    return t;
  };

  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;

    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      meta.skippedLines++;
      continue;
    }

    meta.entryCount++;
    if (entry.timestamp) {
      meta.startedAt ??= entry.timestamp;
      meta.endedAt = entry.timestamp;
    }
    meta.cwd ??= entry.cwd;
    meta.gitBranch ??= entry.gitBranch;
    meta.version ??= entry.version;

    if (entry.type === "user" && entry.message) {
      threadFor(entry).feedUser(entry);
    } else if (entry.type === "assistant" && entry.message) {
      threadFor(entry).feedAssistant(entry);
    }
    // summary / attachment / system / future types: counted, not rendered.
  }

  // A file that is entirely one sidechain (a subagent's own transcript)
  // IS the document.
  let thread = main;
  if (main.cells.length === 0 && agents.size === 1) {
    thread = [...agents.values()][0];
    agents.clear();
  }

  if (meta.version) meta.agent = `claude code ${meta.version}`;

  // In-file sidechains (older sessions) become directly-attached docs.
  const inFileDocs = new Map<string, SessionDoc>();
  for (const [id, t] of agents) {
    if (t.cells.length > 0) {
      inFileDocs.set(id, threadToDoc(t, { ...meta }));
      linkSubagents(t.cells, inFileDocs);
    }
  }
  linkSubagents(thread.cells, inFileDocs);

  return threadToDoc(thread, meta);
}

// ── Session listing (adapter types) ───────────────────────────────────

export type SessionRef = {
  id: string;
  /** The first real prompt, as a one-line title (or the tool's own). */
  title?: string;
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
