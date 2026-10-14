/**
 * A fake `claude -p --input-format stream-json --output-format stream-json`
 * for testing the native driver without spending tokens. Emits the real
 * message shapes: system/init, assistant (text + tool_use), user
 * (tool_result), result. The prompt text picks the scenario:
 *
 *   "fail"  the test run comes back red
 *   "slow"  the turn takes a while (for cancel tests)
 *   "edit"  an Edit tool call with old_string/new_string (a diff)
 */
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = "fake-claude-session";
let cancelled = false;

send({ type: "system", subtype: "init", session_id: SID, model: "claude-fake-1", cwd: process.cwd(), tools: ["Bash", "Edit"] });

async function turn(text) {
  cancelled = false;
  send({ type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "text", text: "On it." }], usage: { output_tokens: 12 } } });
  await sleep(text.includes("slow") ? 1500 : 30);
  if (cancelled) return;

  if (text.includes("edit")) {
    send({ type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_e1", name: "Edit", input: { file_path: "src/queue.ts", old_string: "ack(job)", new_string: "await ack(job)" } }] } });
    await sleep(20);
    send({ type: "user", session_id: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e1", content: "Edited src/queue.ts" }] } });
  }

  const red = text.includes("fail");
  send({ type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_t1", name: "Bash", input: { command: "pnpm test" } }] } });
  await sleep(20);
  if (cancelled) return;
  send({ type: "user", session_id: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1", is_error: red, content: red ? "Tests  2 failed, 9 passed\nFAIL tests/a.ts" : "Tests  11 passed (11)" }] } });
  send({ type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "text", text: red ? "Two tests are red." : "All green." }], usage: { output_tokens: 8 } } });
  send({ type: "result", subtype: "success", is_error: false, session_id: SID, num_turns: 1, total_cost_usd: 0.0042, usage: { output_tokens: 20 } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "user") {
    const text = (msg.message?.content ?? []).map((b) => b.text ?? "").join(" ");
    turn(text);
  }
});

process.on("SIGTERM", () => process.exit(0));
