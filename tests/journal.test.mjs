import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, digest, today } from "../server/journal.mjs";

test("the digest counts only what the log shows", () => {
  const d = digest([
    { type: "turn", name: "api", verdict: "green", ms: 60_000 },
    { type: "turn", name: "web", verdict: "red", ms: 30_000 },
    { type: "turn", name: "web", verdict: "red", ms: 30_000 },
    { type: "turn", name: "cli", verdict: null, stopReason: "error", ms: 1_000 },
    { type: "queue-sent" },
    { type: "held" },
    { type: "merged" },
    { type: "answered", from: "notification" },
    { type: "answered", from: "panel" },
  ]);
  assert.deepEqual(d, {
    green: 1,
    red: 2,
    redNames: ["web"],
    errors: 1,
    queueSent: 1,
    held: 1,
    merged: 1,
    answeredFromNotifications: 1,
    agentMs: 121_000,
  });
});

test("events survive a restart, and old ones are dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-journal-"));
  let clock = Date.parse("2026-10-15T10:00:00Z");
  const j = new Journal(join(dir, "journal.jsonl"), { now: () => clock });
  j.add({ type: "turn", verdict: "green" });
  clock += 40 * 86_400_000;
  j.add({ type: "merged" });
  await j.writing;
  const again = await new Journal(j.file, { now: () => clock }).load();
  assert.deepEqual(again.events.map((e) => e.type), ["merged"]);
});

test("today means since local midnight", () => {
  const now = new Date(2026, 9, 15, 14, 0).getTime();
  const events = [
    { at: new Date(2026, 9, 14, 23, 0).toISOString(), type: "merged" },
    { at: new Date(2026, 9, 15, 9, 0).toISOString(), type: "merged" },
  ];
  assert.equal(today(events, now).length, 1);
});
