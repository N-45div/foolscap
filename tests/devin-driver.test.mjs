/**
 * The Devin driver against a stand-in of Devin's session API. Pins the
 * things the queue depends on: a blocked session surfaces as a question
 * that needs you, your text answer goes back as a message, and the turn
 * ends when Devin finishes — with the pull request in the document.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fleet } from "../server/fleet.mjs";
import { attention } from "../server/attention.mjs";
import { DevinBuilder } from "../server/devin-doc.mjs";

/** A scripted Devin: working → blocked (question) → working → finished. */
function fakeDevin() {
  const calls = [];
  let polls = 0;
  let phase = "working";
  const messages = [{ type: "user_message", event_id: "e0", message: "(prompt)", timestamp: "t0" }];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/v1/sessions") {
        res.end(JSON.stringify({ session_id: "devin-1", url: "https://app.devin.ai/sessions/devin-1", is_new_session: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/sessions/devin-1/message") {
        messages.push({ type: "user_message", event_id: `u${messages.length}`, message: body.message, timestamp: "t9" });
        phase = "working-after-answer";
        res.end("{}");
        return;
      }
      if (req.method === "GET" && req.url === "/v1/sessions/devin-1") {
        polls++;
        if (phase === "working" && polls === 1) {
          messages.push({ type: "devin_message", event_id: "e1", message: "Looking at the repo and the migrations.", timestamp: "t1" });
        }
        if (phase === "working" && polls >= 3) {
          phase = "blocked";
          messages.push({ type: "devin_message", event_id: "e2", message: "Which database should the migration target, postgres or sqlite?", timestamp: "t2" });
        }
        if (phase === "working-after-answer" && polls >= 6) {
          phase = "finished";
          messages.push({ type: "devin_message", event_id: "e3", message: "Migration written for postgres; PR opened.", timestamp: "t3" });
        }
        const status_enum = phase === "blocked" ? "blocked" : phase === "finished" ? "finished" : "working";
        res.end(JSON.stringify({
          session_id: "devin-1",
          status: status_enum,
          status_enum,
          title: "migration",
          created_at: "t0",
          updated_at: "t9",
          messages,
          pull_request: status_enum === "finished" ? { url: "https://github.com/demo/copperline/pull/42" } : null,
          structured_output: null,
        }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, calls })),
  );
}

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

const fleets = [];
const servers = [];
after(async () => {
  for (const f of fleets) await f.closeAll();
  for (const s of servers) s.close();
});

test("without an API key the session fails to start with a clear message", async () => {
  delete process.env.DEVIN_API_KEY;
  const fleet = new Fleet({ record: false });
  fleets.push(fleet);
  const s = fleet.get(fleet.launch({ agent: "devin", name: "nokey" }).id);
  await until(() => s.status === "error");
  assert.match(s.error, /DEVIN_API_KEY/);
});

test("a Devin session runs as a turn: question blocks, a text answer unblocks, the PR lands in the document", async () => {
  const { server, port, calls } = await fakeDevin();
  servers.push(server);
  process.env.DEVIN_API_KEY = "apk_test";
  process.env.FOOLSCAP_DEVIN_URL = `http://127.0.0.1:${port}/v1`;
  process.env.FOOLSCAP_DEVIN_POLL_MS = "30";

  const dir = await mkdtemp(join(tmpdir(), "foolscap-devin-"));
  const fleet = new Fleet({ record: true, recordDir: dir });
  fleets.push(fleet);
  const s = fleet.get(fleet.launch({ agent: "devin", name: "migration" }).id);
  await until(() => s.status === "idle");
  assert.equal(s.snapshot().driver, "devin");
  assert.equal(s.snapshot().agentLabel, "devin");

  s.prompt("write the users migration");
  assert.equal(s.status, "working");
  await until(() => s.status === "blocked");

  const create = calls.find((c) => c.method === "POST" && c.url === "/v1/sessions");
  assert.equal(create.body.prompt, "write the users migration");
  assert.equal(create.auth, "Bearer apk_test");
  assert.equal(s.snapshot().url, "https://app.devin.ai/sessions/devin-1");

  const p = s.pendingPermission;
  assert.equal(p.answer, "text");
  assert.equal(p.toolCall.kind, "question");
  assert.match(p.toolCall.title, /postgres or sqlite/);
  assert.equal(attention(s.snapshot()).tier, 0);

  assert.throws(() => s.answerPermission("answer", "   "), /answer is required/);
  s.answerPermission("answer", "postgres");
  assert.equal(s.status, "working");
  await until(() => calls.some((c) => c.url === "/v1/sessions/devin-1/message"));
  const sent = calls.find((c) => c.url === "/v1/sessions/devin-1/message");
  assert.equal(sent.body.message, "postgres");

  await until(() => s.status === "done");
  assert.equal(s.stopReason, "end_turn");
  const doc = s.doc();
  assert.equal(doc.cells.length, 1);
  const texts = doc.cells[0].parts.filter((x) => x.kind === "text").map((x) => x.text);
  assert.ok(texts.some((t) => /Looking at the repo/.test(t)), "devin messages become text parts");
  assert.ok(texts.some((t) => /\*\*you:\*\* postgres/.test(t)), "your answer is in the document");
  assert.ok(texts.some((t) => /pull\/42/.test(t)), "the pull request is in the document");
  assert.ok(!texts.some((t) => /\(prompt\)/.test(t)), "user_message echoes are skipped");
  assert.match(doc.meta.agent, /devin · cloud/);

  // The recording replays through the Devin builder into the same document.
  await new Promise((r) => setTimeout(r, 250));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  const lines = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].driver, "devin");
  const b = new DevinBuilder();
  for (const l of lines.slice(1)) b.feed(l.dir, l.msg, l.t);
  assert.equal(b.cells.length, 1);
  assert.equal(b.cells[0].parts.length, doc.cells[0].parts.length);
  assert.equal(b.cells[0].stopReason, "end_turn");
  assert.equal(b.pullRequest, "https://github.com/demo/copperline/pull/42");
});
