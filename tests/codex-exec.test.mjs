import { test } from "node:test";
import assert from "node:assert/strict";
import { codexTurnArgs, readableError } from "../server/drivers/codex-exec.mjs";

test("the first turn starts a thread in the task folder; later turns resume it", () => {
  assert.deepEqual(codexTurnArgs({ cwd: "C:\\work\\repo" }), [
    "exec", "--json", "-c", 'sandbox_mode="workspace-write"', "-C", "C:\\work\\repo", "-",
  ]);
  assert.deepEqual(codexTurnArgs({ threadId: "01a1", cwd: "C:\\work\\repo", model: "gpt-5.5" }), [
    "exec", "resume", "01a1", "--json", "-c", 'sandbox_mode="workspace-write"', "-m", "gpt-5.5", "-",
  ]);
});

test("the prompt never goes in argv", () => {
  const args = codexTurnArgs({ cwd: "/repo" });
  assert.equal(args.at(-1), "-");
});

// The real turn.failed message Codex 0.141.0 printed when ~/.codex/config.toml
// named a model the ChatGPT plan cannot use (14 Oct 2026).
test("a plan-limited model error reads as its sentence", () => {
  const raw =
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}';
  assert.equal(readableError(raw), "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.");
  assert.equal(readableError("plain words"), "plain words");
});
