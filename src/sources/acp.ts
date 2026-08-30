import type { SessionDoc } from "../model";
import { TranscriptBuilder } from "../../server/acp-doc.mjs";
import { ClaudeStreamBuilder } from "../../server/claude-stream.mjs";

/**
 * ACP recording adapter — sessions that ran through foolscap's own
 * bridge or fleet (~/.foolscap/acp/<id>.jsonl).
 *
 * This is the adapter that covers every ACP harness at once: the
 * recording is the protocol itself, one JSON-RPC frame per line with a
 * direction and a timestamp, and the same TranscriptBuilder that drew
 * the session live redraws it here. Whatever agent sat behind the
 * bridge — Claude Code, Codex, Gemini, one that doesn't exist yet — its
 * session reads the same.
 *
 *   line 1  {type:"foolscap-acp", version, id, name, agent, command,
 *            cwd, startedAt}
 *   after   {t, dir:"c2a"|"a2c", msg}
 */

type Header = {
  type?: string;
  version?: number;
  /** "acp" (the protocol itself) or "claude" (Claude Code's stream-json). */
  driver?: string;
  id?: string;
  name?: string;
  agent?: string;
  cwd?: string;
  startedAt?: string;
};

type Frame = { t?: string; dir?: "c2a" | "a2c"; msg?: unknown };

export function parseAcpSession(ndjson: string): SessionDoc {
  // The header names the driver; until it's read, assume the protocol.
  let builder: TranscriptBuilder | ClaudeStreamBuilder = new TranscriptBuilder();
  const meta: SessionDoc["meta"] = {
    totalOutputTokens: 0,
    entryCount: 0,
    skippedLines: 0,
  };
  let header: Header | null = null;

  for (const line of ndjson.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      meta.skippedLines++;
      continue;
    }
    meta.entryCount++;

    if (!header && (parsed as Header)?.type === "foolscap-acp") {
      header = parsed as Header;
      meta.cwd = header.cwd;
      meta.startedAt = header.startedAt;
      if (header.driver === "claude") builder = new ClaudeStreamBuilder();
      continue;
    }
    const f = parsed as Frame;
    if (f?.dir !== "c2a" && f?.dir !== "a2c") continue;
    if (f.t) meta.endedAt = f.t;
    builder.feed(f.dir, f.msg, f.t);
  }

  if ("totalOutputTokens" in builder) meta.totalOutputTokens = builder.totalOutputTokens;
  const transport = header?.driver === "claude" ? "native" : "acp";
  meta.agent = [header?.agent, transport, header?.name].filter(Boolean).join(" · ");
  return { cells: builder.cells as SessionDoc["cells"], meta };
}
