/**
 * The command driver: one process per turn, prompt in, output out. Warp
 * is its first user (`oz agent run`); the tests use a fake in that
 * shape so they cost nothing and need nothing installed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fleet } from "../server/fleet.mjs";
import { attention } from "../server/attention.mjs";
import { CommandBuilder } from "../server/command-doc.mjs";

// The Warp entry's command line, overridden to point at the fake.
process.env.FOOLSCAP_WARP = `node ${join(import.meta.dirname, "fake-command-agent.mjs")} --prompt {prompt} --cwd {cwd} --output-format json`;

const fleets = [];
after(async () => {
  for (const f of fleets) await f.closeAll();
});

const until = (fn, ms = 8000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error("timed out waiting"));
      setTimeout(tick, 20);
    };
    tick();
  });

async function one(name = "warp-run") {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-command-"));
  const fleet = new Fleet({ record: true, recordDir: dir });
  fleets.push(fleet);
  const s = fleet.get(fleet.launch({ agent: "warp", cwd: process.cwd(), name }).id);
  await until(() => s.status === "idle");
  return { fleet, s, dir };
}

test("a turn runs the command with the prompt and cwd filled in, and reads the JSON it printed", async () => {
  const { s } = await one();
  assert.equal(s.snapshot().driver, "command");
  assert.equal(s.snapshot().agentLabel, "warp agent");

  s.prompt("summarize this directory");
  assert.equal(s.status, "working");
  await until(() => s.status === "done");

  assert.equal(s.stopReason, "end_turn");
  const doc = s.doc();
  assert.equal(doc.cells.length, 1);
  assert.equal(doc.cells[0].prompt, "summarize this directory");
  const text = doc.cells[0].parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n");
  assert.match(text, /Summarised .*3 packages, tests green/);
  const run = doc.cells[0].parts.find((p) => p.kind === "tool").tool;
  assert.equal(run.name, "execute");
  assert.match(run.input.command, /--prompt summarize this directory --cwd/);
  assert.equal(run.status, "completed");
  assert.match(doc.meta.agent, /warp agent · command/);
  assert.equal(attention(s.snapshot()).tier, 1);
});

test("plain text output is the answer as-is", async () => {
  const { s } = await one();
  s.prompt("plain please");
  await until(() => s.status === "done");
  const text = s.doc().cells[0].parts.filter((p) => p.kind === "text").map((p) => p.text).join("");
  assert.match(text, /^Plain text answer for: plain please/);
});

test("a non-zero exit is an error turn at the top of the queue, with stderr kept", async () => {
  const { s } = await one();
  s.prompt("this will fail");
  await until(() => s.status === "done");
  assert.equal(s.stopReason, "error");
  assert.equal(s.evidence.errors, 1);
  const run = s.doc().cells[0].parts.find((p) => p.kind === "tool").tool;
  assert.equal(run.isError, true);
  assert.match(run.result, /could not reach the model/);
  assert.equal(attention(s.snapshot()).tier, 1); // finished with errors: review
});

test("a second prompt is a second process, and the recording replays", async () => {
  const { s, dir } = await one();
  s.prompt("first");
  await until(() => s.status === "done");
  s.prompt("second");
  await until(() => s.status === "done" && s.turns === 2);
  await new Promise((r) => setTimeout(r, 250));

  const file = (await readdir(dir)).find((f) => f.endsWith(".jsonl"));
  const lines = (await readFile(join(dir, file), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].driver, "command");
  const b = new CommandBuilder();
  for (const l of lines.slice(1)) b.feed(l.dir, l.msg, l.t);
  assert.deepEqual(b.cells.map((c) => c.prompt), ["first", "second"]);
  assert.equal(b.cells[1].stopReason, "end_turn");
});
