import type { Cell, SessionDoc, ToolInteraction } from "../model";

/**
 * OpenCode adapter — parses the NDJSON the server expands from
 * OpenCode's SQLite store (see server/opencode.mjs) into the neutral
 * SessionDoc.
 *
 *   {type:"opencode-session", directory, title, model, agent, tokens, time}
 *   {type:"message", id, role:"user"|"assistant", time, tokens?, modelID?}
 *   {type:"part", messageID, type:"text"|"reasoning"|"tool"|"step-start"|"step-finish", …}
 *     tool: {tool, callID, state:{status, input, output, title, error?}}
 *
 * A user message's text parts are its prompt; an assistant message's
 * parts nest inside the cell. OpenCode names tool inputs its own way
 * (`filePath`, `oldString`, `newString`); they're mapped to the names
 * the viewer's diff renderer keys on.
 */

type Line = {
  type?: string;
  id?: string;
  role?: string;
  messageID?: string;
  time_created?: number;
  time?: { created?: number; completed?: number; updated?: number };
  tokens?: { input?: number; output?: number };
  modelID?: string;
  providerID?: string;
  // session header
  directory?: string;
  title?: string;
  version?: string;
  model?: unknown;
  agent?: string;
  // parts
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    error?: string;
  };
};

const iso = (ms?: number): string | undefined =>
  typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : undefined;

/** OpenCode's input names → the neutral ones the viewer understands. */
function normalizeInput(input: Record<string, unknown> | undefined, title?: string) {
  const i: Record<string, unknown> = { ...(input ?? {}) };
  if (title) i.title = title;
  const alias: Array<[string, string]> = [
    ["filePath", "file_path"],
    ["oldString", "old_string"],
    ["newString", "new_string"],
  ];
  for (const [from, to] of alias) {
    if (typeof i[from] === "string" && !(to in i)) i[to] = i[from];
  }
  return i;
}

export function parseOpencodeSession(ndjson: string): SessionDoc {
  const doc: SessionDoc = {
    cells: [],
    meta: { totalOutputTokens: 0, entryCount: 0, skippedLines: 0 },
  };
  let current: Cell | null = null;
  let role: string | undefined;
  let modelLabel: string | undefined;
  let agentLabel: string | undefined;

  const openCell = (prompt: string, at?: string) => {
    current = { prompt, promptAt: at, parts: [], outputTokens: 0 };
    doc.cells.push(current);
  };

  for (const raw of ndjson.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      doc.meta.skippedLines++;
      continue;
    }
    doc.meta.entryCount++;

    if (line.type === "opencode-session") {
      doc.meta.cwd = line.directory;
      doc.meta.version = line.version;
      doc.meta.startedAt = iso(line.time?.created);
      doc.meta.endedAt = iso(line.time?.updated);
      const m = line.model as { modelID?: string } | string | null;
      modelLabel = typeof m === "string" ? m : m?.modelID;
      agentLabel = line.agent;
      continue;
    }

    if (line.type === "message") {
      role = line.role;
      const at = iso(line.time?.created ?? line.time_created);
      if (role === "user") {
        openCell("", at);
      } else if (role === "assistant") {
        if (!current) openCell("(session resumed)", at);
        const out = line.tokens?.output ?? 0;
        (current as unknown as Cell).outputTokens += out;
        doc.meta.totalOutputTokens += out;
        modelLabel ??= line.modelID;
      }
      continue;
    }

    if (line.type !== "part") continue;
    const at = iso(line.time_created ?? line.time?.created);

    if (role === "user") {
      const isText = ((line as Line & { partType?: string }).partType ?? "text") === "text";
      if (isText && typeof line.text === "string" && current) {
        const cell = current as unknown as Cell;
        cell.prompt = [cell.prompt, line.text].filter(Boolean).join("\n");
      }
      continue;
    }

    if (!current) openCell("(session resumed)", at);
    const cell = current as unknown as Cell;
    const p = line as Line & { partType?: string };
    const pt = p.partType ?? inferPartType(p as Record<string, unknown>);

    if (pt === "text" && typeof p.text === "string" && p.text) {
      cell.parts.push({ kind: "text", text: p.text, at });
    } else if (pt === "reasoning" && typeof p.text === "string" && p.text) {
      cell.parts.push({ kind: "thinking", text: p.text, at });
    } else if (pt === "tool") {
      const state = p.state ?? {};
      const id = p.callID ?? `${p.messageID}:${p.id}`;
      const tool: ToolInteraction = {
        id,
        name: p.tool ?? "tool",
        input: normalizeInput(state.input, state.title),
        isError: state.status === "error",
      };
      const body = [state.error, state.output].filter((s) => typeof s === "string" && s).join("\n");
      if (body) tool.result = body.slice(0, 20_000);
      (tool as ToolInteraction & { status?: string }).status = state.status;
      cell.parts.push({ kind: "tool", tool, at });
    }
    // step-start / step-finish / file / snapshot: not rendered
  }

  for (const cell of doc.cells) if (!cell.prompt) cell.prompt = "(empty prompt)";
  doc.meta.agent = ["opencode", modelLabel, agentLabel].filter(Boolean).join(" · ");
  return doc;
}

/** The server carries the part's own type as `partType`; a line without
    it is classified by the fields present. */
function inferPartType(p: Record<string, unknown>): string {
  if (typeof p.tool === "string") return "tool";
  if (typeof p.text === "string") return "text";
  return "other";
}
