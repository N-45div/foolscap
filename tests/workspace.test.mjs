import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorkspaceApi } from "../server/workspace-api.mjs";
import { FakeFleet } from "./fake-fleet.mjs";
import {
  attachTaskAttempt,
  createTask,
  chooseAgent,
  reconcileWorkspace,
  defaultWorkspace,
  indexSource,
  readWorkspace,
  searchWorkspace,
  searchWorkspaceContents,
  updateTask,
  writeWorkspace,
} from "../server/workspace.mjs";

const servers = [];
after(async () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foolscap-workspace-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "src", "alpha.ts"), 'import { beta } from "./beta";\nexport const alpha = beta;\n');
  await writeFile(join(root, "src", "beta.ts"), "export const beta = 2;\n");
  await writeFile(join(root, "README.md"), "# Project\n\nSee [[Guide]].\n");
  await writeFile(join(root, "Guide.md"), "# Guide\n");
  await writeFile(join(root, "node_modules", "ignored", "junk.ts"), "export const junk = true;\n");
  return root;
}

test("repository indexing creates source-backed file nodes and relationships", async () => {
  const root = await fixture();
  const state = await indexSource(defaultWorkspace(root), root);
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0].stats.files, 4);
  assert.equal(state.sources[0].stats.truncated, false);
  assert.ok(state.nodes.some((node) => node.detail === "src/alpha.ts"));
  assert.ok(!state.nodes.some((node) => /junk/.test(node.detail)));

  const byDetail = new Map(state.nodes.map((node) => [node.detail, node.id]));
  assert.ok(state.edges.some((edge) => edge.from === byDetail.get("src/alpha.ts") && edge.to === byDetail.get("src/beta.ts") && edge.label === "imports"));
  assert.ok(state.edges.some((edge) => edge.from === byDetail.get("README.md") && edge.to === byDetail.get("Guide.md") && edge.label === "links to"));
  const contentHits = await searchWorkspaceContents(state, "export const beta");
  assert.ok(contentHits.some((hit) => hit.type === "content" && hit.label === "src/beta.ts"));
});

test("workspace state and task transitions survive a round trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-workspace-state-"));
  const file = join(dir, "state.json");
  let state = createTask(defaultWorkspace(dir), { title: "Ship the graph", budgetUsd: 6 });
  const id = state.tasks[0].id;
  state = updateTask(state, id, { status: "running", progress: 40 });
  await writeWorkspace(state, file);
  const loaded = await readWorkspace(file, dir);
  assert.equal(loaded.tasks[0].status, "running");
  assert.equal(loaded.tasks[0].progress, 40);
  assert.ok(loaded.nodes.some((node) => node.id === id && node.kind === "task"));
  assert.equal(searchWorkspace(loaded, "graph")[0].id, id);
});

test("workspace API persists an indexed source and rejects unmarked writes", async () => {
  const root = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "foolscap-workspace-api-"));
  const file = join(dir, "workspace.json");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!(await handleWorkspaceApi(req, res, url, { file, root }))) {
      res.statusCode = 404;
      res.end();
    }
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const refused = await fetch(`${base}/api/workspace/tasks`, { method: "POST", body: JSON.stringify({ title: "No header" }) });
  assert.equal(refused.status, 403);

  const indexed = await fetch(`${base}/api/workspace/sources`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foolscap": "workspace" },
    body: JSON.stringify({ path: root }),
  });
  assert.equal(indexed.status, 201);
  assert.equal((await indexed.json()).sources[0].stats.files, 4);

  const created = await fetch(`${base}/api/workspace/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foolscap": "workspace" },
    body: JSON.stringify({ title: "Run the index" }),
  });
  assert.equal(created.status, 201);
  const createdState = await created.json();
  assert.equal(createdState.tasks[0].title, "Run the index");

  const voice = await fetch(`${base}/api/workspace/voice/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foolscap": "workspace" },
    body: JSON.stringify({
      id: "live_test",
      startedAt: "2026-09-13T00:00:00.000Z",
      endedAt: "2026-09-13T00:01:00.000Z",
      usage: { audio_seconds: 60 },
    }),
  });
  assert.equal(voice.status, 201);
  assert.equal((await voice.json()).voiceSessions[0].usage.audio_seconds, 60);

  const persisted = await (await fetch(`${base}/api/workspace`)).json();
  assert.equal(persisted.sources.length, 1);
  assert.equal(persisted.tasks.length, 1);
  assert.equal(persisted.voiceSessions[0].id, "live_test");
});

test("a workspace task launches through the fleet and records execution evidence", async () => {
  const root = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "foolscap-workspace-run-"));
  const file = join(dir, "workspace.json");
  const fleet = new FakeFleet();
  const initial = createTask(defaultWorkspace(root), {
    title: "Ship the source graph",
    detail: "Implement the graph and prove it with tests.",
    budgetUsd: 4,
  });
  await writeWorkspace(initial, file);
  const taskId = initial.tasks[0].id;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!(await handleWorkspaceApi(req, res, url, { file, root, fleet }))) {
      res.statusCode = 404;
      res.end();
    }
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const launched = await fetch(`${base}/api/workspace/tasks/${encodeURIComponent(taskId)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foolscap": "workspace" },
    body: JSON.stringify({ agent: "codex" }),
  });
  assert.equal(launched.status, 202);
  const running = await launched.json();
  assert.equal(running.tasks[0].status, "running");
  assert.equal(running.tasks[0].attempts[0].sessionId, "fleet-1");
  assert.match(fleet.get("fleet-1").promptText, /Ship the source graph/);
  assert.match(fleet.get("fleet-1").promptText, new RegExp(root.replaceAll("\\", "\\\\")));

  fleet.get("fleet-1").finish();
  const finished = await (await fetch(`${base}/api/workspace`)).json();
  assert.equal(finished.tasks[0].status, "review");
  assert.equal(finished.tasks[0].progress, 85);
  assert.equal(finished.tasks[0].attempts[0].outputTokens, 321);
  assert.equal(finished.tasks[0].attempts[0].evidence.testsPassed, 1);
  // The fake agent never reported cost: unknown stays unknown, never zero.
  assert.equal(finished.tasks[0].attempts[0].costUsd, null);
  assert.equal(finished.tasks[0].spentKnown, false);
  assert.equal(finished.tasks[0].spentUsd, 0);
});

test("reported cost becomes the task's spend; unreported cost marks it unknown", () => {
  const base = createTask(defaultWorkspace(process.cwd()), { title: "Cost", budgetUsd: 5 });
  const id = base.tasks[0].id;
  const snap = (over) => ({ id: "s1", agent: "claude", agentLabel: "claude code", driver: "claude", model: "m", status: "working", startedAt: "t", evidence: { testsPassed: 0, testsFailed: 0, errors: 0, edited: 0 }, outputTokens: 10, ...over });
  const attached = attachTaskAttempt(base, id, snap({ costUsd: null }), null);
  const known = reconcileWorkspace(attached, [snap({ status: "done", costUsd: 0.42, doneAt: "t2" })]).state;
  assert.equal(known.tasks[0].spentUsd, 0.42);
  assert.equal(known.tasks[0].spentKnown, true);
  const unknown = reconcileWorkspace(attached, [snap({ status: "done", costUsd: null, doneAt: "t2" })]).state;
  assert.equal(unknown.tasks[0].spentUsd, 0);
  assert.equal(unknown.tasks[0].spentKnown, false);
});

test("dispatch ready keeps one writer per checkout", async () => {
  const root = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "foolscap-workspace-dispatch-"));
  const file = join(dir, "workspace.json");
  const fleet = new FakeFleet();
  let initial = createTask(defaultWorkspace(root), { title: "First ready task", budgetUsd: 3 });
  initial = createTask(initial, { title: "Second ready task", budgetUsd: 3 });
  initial.tasks = initial.tasks.map((task) => ({ ...task, status: "ready" }));
  await writeWorkspace(initial, file);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await handleWorkspaceApi(req, res, url, { file, root, fleet });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/workspace/coordinator/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foolscap": "workspace" },
    body: JSON.stringify({ limit: 2 }),
  });
  assert.equal(response.status, 202);
  const dispatched = await response.json();
  assert.equal(dispatched.dispatch.launched, 1);
  assert.equal(dispatched.dispatch.errors.length, 1);
  assert.match(dispatched.dispatch.errors[0].error, /workspace is busy/);
  assert.equal(dispatched.decisions.length, 1);
  // claude first, then the least-loaded fallback — never devin or warp on "auto"
  assert.equal(dispatched.decisions[0].agent, "claude");
  assert.equal(dispatched.tasks.filter((task) => task.status === "running").length, 1);
  assert.equal(dispatched.tasks.filter((task) => task.status === "ready").length, 1);
});

test("concurrent starts cannot launch the same task twice", async () => {
  const root = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "foolscap-workspace-race-"));
  const file = join(dir, "workspace.json");
  const fleet = new FakeFleet();
  const initial = createTask(defaultWorkspace(root), { title: "Only once", budgetUsd: 3 });
  await writeWorkspace(initial, file);
  const taskId = initial.tasks[0].id;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await handleWorkspaceApi(req, res, url, { file, root, fleet });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = () => fetch(`${base}/api/workspace/tasks/${encodeURIComponent(taskId)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foolscap": "workspace" },
    body: JSON.stringify({ agent: "auto" }),
  });
  const responses = await Promise.all([start(), start()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 400]);
  assert.equal(fleet.list().length, 1);
  const state = await readWorkspace(file, root);
  assert.equal(state.tasks[0].attempts.length, 1);
});

test("auto never routes to cloud or unverified agents unless named", () => {
  const state = createTask(defaultWorkspace(process.cwd()), { title: "Route", budgetUsd: 3 });
  const task = state.tasks[0];
  assert.equal(chooseAgent(state, task, "auto", [], ["devin", "warp", "codex"]).agent, "codex");
  assert.throws(() => chooseAgent(state, task, "auto", [], ["devin", "warp"]), /per-agent limit/);
  assert.equal(chooseAgent(state, task, "devin", [], ["devin", "warp"]).agent, "devin");
});

test("routing refuses exhausted budgets before launching an agent", () => {
  const state = createTask(defaultWorkspace(process.cwd()), { title: "No budget", budgetUsd: 0 });
  assert.throws(() => chooseAgent(state, state.tasks[0], "auto", [], ["codex"]), /remaining budget/);
});
