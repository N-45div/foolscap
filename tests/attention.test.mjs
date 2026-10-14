/**
 * The attention policy decides which agent you look at next. Getting it
 * wrong is the whole "I get lost with >4 sessions" problem, so the
 * ordering is pinned here rather than left to the UI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attention, rank } from "../server/attention.mjs";

const snap = (over) => ({
  id: "s",
  turns: 1,
  status: "idle",
  evidence: { testsPassed: 0, testsFailed: 0, errors: 0, edited: 0 },
  startedAt: "2026-08-30T10:00:00Z",
  ...over,
});

test("blocked on permission is the top of the queue", () => {
  const a = attention(snap({ status: "blocked", blockedSince: "2026-08-30T10:05:00Z" }));
  assert.equal(a.tier, 0);
  assert.match(a.reason, /permission/);
});

test("a turn that ended with red tests needs you", () => {
  const a = attention(
    snap({ status: "done", doneAt: "t", evidence: { testsFailed: 2, testsPassed: 0, errors: 0, edited: 1 } }),
  );
  assert.equal(a.tier, 0);
  assert.match(a.reason, /tests failing \(2\)/);
});

test("a finished turn waits for review, then fades once seen", () => {
  const s = snap({ status: "done", doneAt: "t", evidence: { testsPassed: 1, testsFailed: 0, errors: 0, edited: 3 } });
  assert.equal(attention(s, false).tier, 1);
  assert.match(attention(s, false).reason, /tests passed · edited 3 files/);
  assert.equal(attention(s, true).tier, 3);
});

test("working agents are left alone", () => {
  const a = attention(snap({ status: "working", activity: { kind: "tool", text: "pnpm test" } }));
  assert.equal(a.tier, 2);
  assert.equal(a.reason, "pnpm test");
});

test("crashes need you", () => {
  assert.equal(attention(snap({ status: "exited", endedAt: "t" })).tier, 0);
  assert.equal(attention(snap({ status: "error", endedAt: "t" })).tier, 0);
});

test("rank orders by tier, then by who has waited longest", () => {
  const list = [
    snap({ id: "working", status: "working", turnStartedAt: "2026-08-30T10:01:00Z" }),
    snap({ id: "done-late", status: "done", doneAt: "2026-08-30T10:09:00Z" }),
    snap({ id: "blocked", status: "blocked", blockedSince: "2026-08-30T10:08:00Z" }),
    snap({ id: "done-early", status: "done", doneAt: "2026-08-30T10:03:00Z" }),
    snap({ id: "idle" }),
  ];
  const order = rank(list).map((s) => s.id);
  assert.deepEqual(order, ["blocked", "done-early", "done-late", "working", "idle"]);
});

test("seen is keyed by turn, so a new turn asks for attention again", () => {
  const s = snap({ id: "x", turns: 2, status: "done", doneAt: "t" });
  const seenTurn1 = new Set(["x:1"]);
  const seenTurn2 = new Set(["x:2"]);
  assert.equal(rank([s], seenTurn1)[0].attention.tier, 1);
  assert.equal(rank([s], seenTurn2)[0].attention.tier, 3);
});
