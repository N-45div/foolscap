/**
 * The next-prompt queue: a queued prompt goes out on its own only after
 * a green turn, and is held, with the reason, otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "../server/fleet.mjs";
import { attention } from "../server/attention.mjs";

/** A session whose driver records prompts and ends each turn at once. */
function sessionWith({ verified = null, stopReason = "end_turn", assistant = false } = {}) {
  const s = new AgentSession({ id: "q1", name: "q", agent: assistant ? "hermes" : "opencode", cwd: ".", record: false, verify: false });
  const sent = [];
  s.driver = {
    sessionId: null,
    start: async () => {},
    prompt: async (text) => {
      sent.push(text);
      return { stopReason };
    },
    cancel: () => {},
    close: () => {},
  };
  s.status = "idle";
  // Stand in for verifyRepo: the verdict this turn would get.
  s.verifyEnabled = verified !== null;
  s.afterTurnVerdict = verified;
  const original = s.afterTurn.bind(s);
  s.afterTurn = async () => {
    if (s.verifyEnabled) {
      s.verifyEnabled = false;
      s.verified = s.afterTurnVerdict;
    }
    await original();
    s.verifyEnabled = verified !== null;
  };
  return { s, sent };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("on green, the next queued prompt goes out by itself", async () => {
  const { s, sent } = sessionWith({ verified: { verdict: "green", reason: "3/3 passed", counts: { total: 3, passed: 3, failed: 0 } } });
  s.queue.push("then add a test");
  s.prompt("fix the bug");
  await settle();
  await settle();
  assert.deepEqual(sent, ["fix the bug", "then add a test"]);
  assert.equal(s.queue.length, 0);
  assert.equal(s.held, null);
});

test("on red, the queue holds and says why", async () => {
  const { s, sent } = sessionWith({ verified: { verdict: "red", reason: "1 of 3 failed", counts: { total: 3, passed: 2, failed: 1 } } });
  s.queue.push("then add a test");
  s.prompt("fix the bug");
  await settle();
  assert.deepEqual(sent, ["fix the bug"]);
  assert.match(s.held.reason, /tests red/);
  assert.equal(attention(s.snapshot()).tier, 0);
});

test("an assistant's queue always waits for the person", async () => {
  const { s, sent } = sessionWith({ assistant: true });
  s.queue.push("and book it");
  s.prompt("find a table for four");
  await settle();
  assert.deepEqual(sent, ["find a table for four"]);
  assert.match(s.held.reason, /read the reply/);
});

test("the person can override a hold", async () => {
  const { s, sent } = sessionWith({ verified: { verdict: "unknown", reason: "no tests ran", counts: null } });
  s.queue.push("ship it anyway");
  s.prompt("try the fix");
  await settle();
  assert.ok(s.held);
  s.sendNext();
  await settle();
  assert.deepEqual(sent, ["try the fix", "ship it anyway"]);
});
