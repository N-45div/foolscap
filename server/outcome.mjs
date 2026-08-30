/**
 * Outcome evidence — did a prompt actually work?
 *
 * The moat: every harness's log already records what happened after a
 * prompt. Tests ran and passed. A commit landed. Or the very next thing
 * the user typed was "no, that's wrong". That is *evidence*, readable
 * deterministically, with no model call and no guessing — which is why
 * this stays free and honest where a mining-based approach needs an LLM
 * and a human review queue.
 *
 * Two stages:
 *   segmentsFor(source, lines) — split a session into prompt → work →
 *     next-prompt segments, per harness.
 *   judge(segment) — read the evidence in one segment.
 *
 * Deliberately conservative: unclear evidence returns "unknown", never a
 * flattering guess. Every verdict shown must be one the user can confirm
 * by opening the cell.
 */

import { TranscriptBuilder } from "./acp-doc.mjs";
import { ClaudeStreamBuilder } from "./claude-stream.mjs";
import { DevinBuilder } from "./devin-doc.mjs";
import { CommandBuilder } from "./command-doc.mjs";

// ── Evidence patterns ────────────────────────────────────────────────

const TEST_CMD =
  /\b(pytest|vitest|jest|mocha|rspec|phpunit|go test|cargo test|dotnet test|mvn (test|verify)|gradle test|tox|unittest|npm (run )?test|pnpm (run )?(test|vitest)|yarn test|make (test|check)|ctest)\b/i;

const BUILD_CMD =
  /\b(tsc\b|next build|vite build|webpack|cargo build|go build|mvn package|gradle build|npm run build|pnpm (run )?build|yarn build|dotnet build)\b/i;

const PASS_SIGNAL = [
  /\b(\d+)\s+pass(ed|ing)\b/i,
  /\btests?\s+passed\b/i,
  /Test Files\s+\d+\s+passed/i,
  /\b0\s+fail(ed|ing|ures)?\b/i,
  /\bbuild (succeeded|successful|complete)\b/i,
  /\bcompiled successfully\b/i,
  /^\s*✓/m,
];

const FAIL_SIGNAL = [
  /\b([1-9]\d*)\s+fail(ed|ing|ures)?\b/i,
  /\bFAILED\b/,
  /^\s*FAIL\b/m,
  /\berror TS\d+/,
  /\bnpm ERR!/,
  /Traceback \(most recent call last\)/,
  /\bExit code: [1-9]/,
  /^\s*✗/m,
  /\bAssertionError\b/,
];

const COMMIT_CMD = /\bgit\s+commit\b/;
const COMMIT_OK = [/\[[\w./+-]+\s+[0-9a-f]{7,}\]/, /\b\d+ files? changed\b/];

/**
 * The next prompt taking the work back — the clearest negative signal.
 * Lead-ins are stripped first so "that didn't work" reads the same as
 * "didn't work", while staying tight enough that ordinary follow-ups
 * ("now add a test", "notify me when…", "revertible migrations…") never
 * register as corrections. The tests pin both directions.
 */
const CORRECTION_LEAD = /^\s*(?:(?:that|this|it|hmm|ok|okay|but)[,\s]+)*/i;
const CORRECTION =
  /^(?:no[,.\s!]|nope\b|nah\b|wrong\b|that.s (?:wrong|not right)|it.s still\b|is (?:wrong|broken)\b|not (?:quite|right|working)\b|still (?:fail|broken|not|does|no)|does ?n.?t work|did ?n.?t work|revert\b|undo\b|you broke\b|broke the\b|fix (?:that|it)\b)/i;

const isCorrection = (text) =>
  CORRECTION.test(String(text).replace(CORRECTION_LEAD, ""));

const any = (patterns, text) => patterns.some((re) => re.test(text));

/** Shell-ish tool inputs put the command in different shapes. */
export function commandOf(tool) {
  const i = tool.input ?? {};
  const c = i.command ?? i.cmd ?? i.script;
  if (typeof c === "string") return c;
  // Codex sends argv arrays: ["bash", "-lc", "pnpm test"]
  if (Array.isArray(c)) return c.filter((p) => typeof p === "string").join(" ");
  // ACP tool calls carry the command as their title.
  if (tool.name === "execute" && typeof i.title === "string") return i.title;
  return "";
}

/**
 * Read one command's output as evidence. Shared by the archive judge
 * (past tense) and the fleet (present tense) so both agree on what a
 * green or red run looks like.
 */
export function classifyRun(cmd, output, isError = false) {
  const testish = TEST_CMD.test(cmd) || BUILD_CMD.test(cmd);
  if (!testish) return { tested: false, passed: false, failed: false };
  const text = output ?? "";
  if (any(FAIL_SIGNAL, text)) return { tested: true, passed: false, failed: true };
  if (any(PASS_SIGNAL, text) && !isError) return { tested: true, passed: true, failed: false };
  return { tested: true, passed: false, failed: false };
}

/**
 * Read the evidence in one prompt's segment.
 * @returns {{verdict: "verified"|"corrected"|"rocky"|"unknown",
 *            tested: boolean, passed: boolean, committed: boolean,
 *            corrected: boolean, errors: number}}
 */
export function judge(segment) {
  let tested = false;
  let passed = false;
  let failed = false;
  let committed = false;
  let errors = 0;

  for (const tool of segment.tools) {
    if (tool.isError) errors++;
    const cmd = commandOf(tool);
    const result = tool.result ?? "";

    // A run that prints failures is a failure even when it also prints
    // a passing count for other files — classifyRun checks red first.
    const run = classifyRun(cmd, result, tool.isError);
    if (run.tested) tested = true;
    if (run.failed) failed = true;
    if (run.passed) passed = true;

    if (COMMIT_CMD.test(cmd) && !tool.isError && any(COMMIT_OK, result)) {
      committed = true;
    }
  }

  const corrected = Boolean(segment.next && isCorrection(segment.next));

  let verdict = "unknown";
  if (corrected) verdict = "corrected";
  else if ((passed && !failed) || committed) verdict = "verified";
  else if (failed || errors > 0) verdict = "rocky";

  return { verdict, tested, passed, committed, corrected, errors };
}

// ── Segmentation, per harness ────────────────────────────────────────

const SYNTHETIC = (t) =>
  t.startsWith("<") ||
  t.startsWith("[Request interrupted") ||
  t.startsWith("[SYSTEM");

/** Collects prompt → tools → next-prompt segments as lines are fed in. */
class Segmenter {
  constructor() {
    this.segments = [];
    this.current = null;
    this.byId = new Map();
  }
  prompt(text, at) {
    if (this.current) this.current.next = text;
    this.current = { text, at, tools: [], next: null };
    this.segments.push(this.current);
    this.byId.clear();
  }
  tool(id, name, input) {
    if (!this.current) return;
    const t = { name, input, result: "", isError: false };
    this.current.tools.push(t);
    if (id) this.byId.set(id, t);
  }
  result(id, text, isError) {
    const t = this.byId.get(id);
    if (!t) return;
    t.result = String(text ?? "").slice(0, 20000);
    t.isError = Boolean(isError);
  }
}

function claudeSegments(lines, seg) {
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.isSidechain) continue; // subagent traffic is not the user's prompt
    const msg = e?.message;
    if (!msg) continue;

    if (e.type === "user") {
      const c = msg.content;
      if (Array.isArray(c)) {
        let sawResult = false;
        for (const b of c) {
          if (b?.type === "tool_result" && b.tool_use_id) {
            sawResult = true;
            let body = "";
            if (typeof b.content === "string") body = b.content;
            else if (Array.isArray(b.content))
              body = b.content.map((x) => x?.text ?? "").join("\n");
            seg.result(b.tool_use_id, body, b.is_error === true);
          }
        }
        if (sawResult) continue;
      }
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c))
        text = c
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("\n");
      text = text.trim();
      if (text && !SYNTHETIC(text)) seg.prompt(text, e.timestamp);
    } else if (e.type === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === "tool_use" && b.id)
          seg.tool(b.id, b.name ?? "", b.input ?? {});
      }
    }
  }
}

const IDE_MARKER = "## My request for Codex:";

function codexSegments(lines, seg) {
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== "response_item") continue;
    const p = e.payload;
    if (!p) continue;

    if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      let t = p.content
        .map((b) => b?.text ?? "")
        .filter(Boolean)
        .join("\n")
        .trim();
      if (t.startsWith("# Context from my IDE setup")) {
        const i = t.indexOf(IDE_MARKER);
        t = i === -1 ? "" : t.slice(i + IDE_MARKER.length).trim();
      }
      if (t && !t.startsWith("<")) seg.prompt(t, e.timestamp);
    } else if (p.type === "function_call" && p.call_id) {
      let input = {};
      try {
        input = p.arguments ? JSON.parse(p.arguments) : {};
      } catch {
        input = { command: p.arguments };
      }
      seg.tool(p.call_id, p.name ?? "", input);
    } else if (p.type === "function_call_output" && p.call_id) {
      const out = typeof p.output === "string" ? p.output : "";
      seg.result(p.call_id, out, /^Exit code: [1-9]/m.test(out));
    }
  }
}

function dshSegments(lines, seg) {
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const d = e?.data;
    const at =
      typeof e?.time === "number" ? new Date(e.time).toISOString() : undefined;

    if (e?.type === "user/message" && d) {
      const m = d.message;
      let text = "";
      if (typeof m === "string") text = m;
      else if (typeof m?.text === "string") text = m.text;
      else if (typeof m?.content === "string") text = m.content;
      else if (Array.isArray(m?.content))
        text = m.content
          .map((b) => (typeof b === "string" ? b : (b?.text ?? "")))
          .join("\n");
      text = text.trim();
      if (text && !text.startsWith("<")) seg.prompt(text, at);
    } else if (e?.type === "tool/call" && d) {
      let input = {};
      try {
        input = d.arguments ? JSON.parse(d.arguments) : {};
      } catch {
        input = { command: d.arguments };
      }
      seg.tool(d.callId ?? d.call_id, d.name ?? "", input);
    } else if (e?.type === "tool/result" && d) {
      const m = d.message;
      let body = "";
      if (typeof m === "string") body = m;
      else if (typeof m?.content === "string") body = m.content;
      seg.result(d.callId ?? d.call_id, body, Boolean(d.error));
    }
  }
}

/** Fleet/bridge recordings: replay the protocol into cells, then read
    those cells as segments. One path for every ACP harness. */
function acpSegments(lines, seg) {
  let builder = new TranscriptBuilder();
  for (const line of lines) {
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      continue;
    }
    // The header names the driver that produced the recording.
    if (f?.type === "foolscap-acp") {
      if (f.driver === "claude") builder = new ClaudeStreamBuilder();
      if (f.driver === "devin") builder = new DevinBuilder();
      if (f.driver === "command") builder = new CommandBuilder();
      continue;
    }
    if (f?.dir !== "c2a" && f?.dir !== "a2c") continue;
    builder.feed(f.dir, f.msg, f.t);
  }
  for (const cell of builder.cells) {
    if (cell.prompt === "(session resumed)") continue;
    seg.prompt(cell.prompt, cell.promptAt);
    for (const part of cell.parts) {
      if (part.kind !== "tool") continue;
      seg.tool(part.tool.id, part.tool.name, part.tool.input);
      seg.result(part.tool.id, part.tool.result, part.tool.isError);
    }
  }
}

/** OpenCode: the NDJSON the server expands from SQLite — a user
    message's text parts are the prompt, an assistant's tool parts carry
    state.{input,output,status}. */
function opencodeSegments(lines, seg) {
  let role = null;
  let pending = null; // a user prompt being assembled from its parts
  const flush = () => {
    if (pending) seg.prompt(pending.text || "(empty prompt)", pending.at);
    pending = null;
  };
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type === "message") {
      if (e.role === "user") {
        flush();
        role = "user";
        const ms = e.time?.created ?? e.time_created;
        pending = { text: "", at: typeof ms === "number" ? new Date(ms).toISOString() : undefined };
      } else {
        flush();
        role = e.role;
      }
      continue;
    }
    if (e?.type !== "part") continue;
    const pt = e.partType ?? (typeof e.tool === "string" ? "tool" : "text");
    if (role === "user") {
      if (pt === "text" && typeof e.text === "string" && pending) {
        pending.text = [pending.text, e.text].filter(Boolean).join("\n");
      }
      continue;
    }
    if (pt !== "tool") continue;
    const st = e.state ?? {};
    const input = { ...(st.input ?? {}) };
    if (typeof input.filePath === "string") input.file_path = input.filePath;
    if (typeof input.oldString === "string") input.old_string = input.oldString;
    if (typeof input.newString === "string") input.new_string = input.newString;
    const id = e.callID ?? `${e.messageID}:${e.id}`;
    seg.tool(id, e.tool ?? "tool", input);
    seg.result(id, [st.error, st.output].filter((s) => typeof s === "string" && s).join("\n"), st.status === "error");
  }
  flush();
}

const SEGMENTERS = {
  claude: claudeSegments,
  codex: codexSegments,
  dsh: dshSegments,
  acp: acpSegments,
  opencode: opencodeSegments,
};

/** Split one session's lines into prompt segments. Unknown source → []. */
export function segmentsFor(source, lines) {
  const fn = SEGMENTERS[source];
  if (!fn) return [];
  const seg = new Segmenter();
  fn(lines, seg);
  return seg.segments;
}
