import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoordinator, costOf, reviewVerdict, TOOLS } from "../server/coordinator.mjs";
import { handleCoordinatorApi } from "../server/coordinator-api.mjs";
import { createTask, defaultWorkspace, readWorkspace, writeWorkspace } from "../server/workspace.mjs";
import { FakeFleet } from "./fake-fleet.mjs";
import { call, message, outputsIn, startFakeResponses } from "./fake-responses.mjs";

const cleanups = [];
after(async () => Promise.all(cleanups.map((fn) => fn())));

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-coordinator-"));
  const file = join(dir, "workspace.json");
  await writeWorkspace(defaultWorkspace(dir), file);
  return { dir, file };
}

async function untilStatus(coordinator, id, statuses, timeoutMs = 5000) {
  const wanted = new Set([].concat(statuses));
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = coordinator.get(id);
    if (run && wanted.has(run.status)) return run;
    if (Date.now() > until) throw new Error(`run never reached ${[...wanted]} (is ${run?.status})`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function setup(script, extra = {}) {
  return (async () => {
    const { dir, file } = await workspace();
    const api = await startFakeResponses(script);
    cleanups.push(api.close);
    const fleet = new FakeFleet();
    const coordinator = createCoordinator({ file, root: dir, fleet, apiKey: "test-key", baseUrl: api.url, model: "gpt-6-astra", retryDelayMs: 5, ...extra });
    return { dir, file, api, fleet, coordinator };
  })();
}

test("the tools are strict function tools and dispatch is the async one", () => {
  for (const tool of TOOLS) {
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties));
  }
  assert.deepEqual(TOOLS.filter((t) => t.async).map((t) => t.name), ["dispatch_task"]);
});

test("cost follows the published prices, cached input at its own rate", () => {
  const cost = costOf("gpt-6-astra", { input_tokens: 10_000, input_tokens_details: { cached_tokens: 4_000 }, output_tokens: 1_000 });
  // 6k × $10 + 4k × $1 + 1k × $50, per million
  assert.equal(cost.toFixed(4), ((6000 * 10 + 4000 * 1 + 1000 * 50) / 1e6).toFixed(4));
  assert.equal(costOf("some-unknown-model", { input_tokens: 1 }), null);
});

test("a run plans, dispatches asynchronously, reads evidence, repairs, and finishes on evidence", async () => {
  // The scripted "model": create → dispatch (async) → on red tests read
  // evidence → dispatch a repair → on green tests, report.
  let taskId = null;
  const script = (body, index) => {
    const outputs = outputsIn(body);
    switch (index) {
      case 0:
        assert.equal(body.model, "gpt-6-astra");
        assert.match(body.instructions, /never edit code yourself/);
        assert.equal(body.input[0].content, "make the replay tests pass");
        assert.ok(body.tools.some((t) => t.name === "dispatch_task" && t.async === true));
        return { output: [message("Searching, then briefing an agent."), call("create_task", { title: "Fix replay tests", detail: "Make src/replay.test.ts pass; touch only src/replay.ts.", priority: "P1", budget_usd: 3 })] };
      case 1:
        taskId = outputs[0].output.task_id;
        assert.match(taskId, /^task-/);
        return { output: [call("dispatch_task", { task_id: taskId, agent: null, instructions: null }, { async: true, id: "call_d1" })] };
      case 2: {
        // No sync calls were pending, so the coordinator waited for the
        // dispatch and delivered its evidence on the original call id.
        assert.equal(body.previous_response_id, "resp_2");
        assert.equal(outputs.length, 1);
        assert.equal(outputs[0].call_id, "call_d1");
        const ev = outputs[0].output;
        assert.equal(ev.evidence.testsFailed, 1);
        assert.equal(ev.test_runs.at(-1).failed, true);
        assert.match(ev.test_runs.at(-1).output_tail, /1 failed/);
        assert.deepEqual(ev.edited_files, ["src/a.ts"]);
        return { output: [call("read_evidence", { task_id: taskId })] };
      }
      case 3:
        assert.equal(outputs[0].output.attempt_state, "done");
        return { output: [message("Tests are red; dispatching a repair with the failure."), call("dispatch_task", { task_id: taskId, agent: "codex", instructions: "Fix: 1 failed — see output" }, { async: true, id: "call_d2" })] };
      case 4:
        assert.equal(outputs[0].call_id, "call_d2");
        assert.equal(outputs[0].output.evidence.testsPassed, 1);
        assert.equal(outputs[0].output.evidence.testsFailed, 0);
        assert.equal(outputs[0].output.policy.phase, "needs-review");
        return { output: [call("dispatch_task", { task_id: taskId, agent: null, instructions: null }, { async: true, id: "call_d3" })] };
      case 5:
        assert.equal(outputs[0].call_id, "call_d3");
        assert.equal(outputs[0].output.policy.phase, "complete");
        return { output: [message("Fix replay tests: repaired by codex, validated, and independently reviewed. Nothing needs you.")], usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 80 } };
      default:
        throw new Error(`unexpected request ${index}`);
    }
  };
  const { file, dir, api, fleet, coordinator } = await setup(script);
  const run = await coordinator.start({ goal: "make the replay tests pass", fleetUrl: "http://127.0.0.1:1" });
  assert.equal(run.status, "planning");

  // First dispatch: the agent gets the brief plus nothing else, and fails its tests.
  const first = await fleet.session(1);
  assert.match(first.promptText, /Fix replay tests/);
  assert.match(first.promptText, /src\/replay\.ts/);
  assert.equal(first.agent, "claude"); // auto → Claude Code first
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(coordinator.get(run.id).status, "working");
  first.finish({ testsFailed: 1, testsPassed: 0 });

  // The repair carries the coordinator's instructions and goes where it said.
  const second = await fleet.session(2);
  assert.equal(second.agent, "codex");
  assert.match(second.promptText, /This is a bounded repair/);
  assert.match(second.promptText, /Fix: 1 failed/);
  second.finish({ testsPassed: 1, costUsd: 0.4 });

  const review = await fleet.session(3);
  assert.notEqual(review.agent, second.agent);
  assert.match(review.promptText, /Read-only review/);
  review.finish({
    testsPassed: 0,
    edited: 0,
    parts: [{ kind: "text", text: "The change is bounded and the recorded tests are green.\nFOOLSCAP_REVIEW: PASS" }],
  });

  await coordinator.settled(run.id);
  const done = (await readWorkspace(file, dir)).runs.find((r) => r.id === run.id);
  assert.equal(done.status, "done");
  assert.equal(api.requests.length, 6);
  assert.match(done.summary, /independently reviewed/);
  assert.deepEqual(done.taskIds, [taskId]);
  assert.equal(done.turns, 6);
  assert.equal(done.usage.cached, 1500);
  assert.ok(done.costUsd > 0);
  const kinds = done.events.map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k === "dispatch").length, 3);
  assert.deepEqual(kinds.filter((k) => k === "evidence").length, 3);
  assert.ok(kinds.includes("policy"));
  assert.equal(kinds.at(-1), "done");
  // The board caught up: one task, two attempts, in review with a known cost on the last one.
  const task = (await readWorkspace(file, dir)).tasks.find((t) => t.id === taskId);
  assert.equal(task.attempts.length, 3);
  assert.equal(task.status, "done");
  assert.equal(task.attempts[1].costUsd, 0.4);
});

test("the server blocks completion until a different agent returns a review verdict", async () => {
  let taskId;
  const script = (body, index) => {
    const outputs = outputsIn(body);
    if (index === 0) return { output: [call("create_task", { title: "Guarded change", detail: "Edit src/a.ts and run tests.", priority: "P1", budget_usd: 3 })] };
    if (index === 1) {
      taskId = outputs[0].output.task_id;
      return { output: [call("dispatch_task", { task_id: taskId, agent: null, instructions: null }, { async: true, id: "impl" })] };
    }
    if (index === 2) {
      assert.equal(outputs[0].output.policy.phase, "needs-review");
      return { output: [message("Implementation is done.")] };
    }
    if (index === 3) {
      assert.match(body.input[0].content, /needs-review/);
      return { output: [call("dispatch_task", { task_id: taskId, agent: "claude-acp", instructions: null }, { async: true, id: "bad-review" })] };
    }
    if (index === 4) {
      assert.match(outputs[0].output.error, /different agent/);
      return { output: [call("dispatch_task", { task_id: taskId, agent: "codex", instructions: null }, { async: true, id: "good-review" })] };
    }
    if (index === 5) {
      assert.equal(outputs[0].output.policy.phase, "complete");
      return { output: [message("Implemented, validated, and reviewed.")] };
    }
    throw new Error(`unexpected request ${index}`);
  };
  const { coordinator, fleet, file, dir } = await setup(script);
  const run = await coordinator.start({ goal: "make a guarded change" });
  const implementation = await fleet.session(1);
  implementation.finish({ testsPassed: 1 });
  const review = await fleet.session(2);
  assert.equal(review.agent, "codex");
  review.finish({ testsPassed: 0, edited: 0, parts: [{ kind: "text", text: "Looks correct.\nFOOLSCAP_REVIEW: PASS" }] });
  await coordinator.settled(run.id);
  const saved = (await readWorkspace(file, dir)).runs.find((item) => item.id === run.id);
  assert.equal(saved.status, "done");
  assert.equal(saved.policyNudges, 1);
  assert.equal(saved.workflow[taskId].phase, "complete");
});

test("review verdicts come from the final standalone, non-contradictory marker", () => {
  assert.equal(
    reviewVerdict("The requested marker was FOOLSCAP_REVIEW: PASS. I found a regression.\nFOOLSCAP_REVIEW: CHANGES_REQUESTED"),
    "CHANGES_REQUESTED",
  );
  assert.equal(reviewVerdict("FOOLSCAP_REVIEW: PASS\nFOOLSCAP_REVIEW: CHANGES_REQUESTED"), null);
  assert.equal(reviewVerdict("Looks bounded.\nFOOLSCAP_REVIEW: PASS"), "PASS");
});

test("a validation-only repair can carry earlier implementation edits into review", async () => {
  const taskId = "validation-only";
  const script = (body, index) => {
    const outputs = outputsIn(body);
    if (index === 0) return { output: [call("dispatch_task", { task_id: taskId, agent: null, instructions: null }, { async: true })] };
    if (index === 1) {
      assert.equal(outputs[0].output.policy.phase, "needs-repair");
      return { output: [call("dispatch_task", { task_id: taskId, agent: null, instructions: null }, { async: true })] };
    }
    if (index === 2) {
      assert.equal(outputs[0].output.policy.phase, "needs-review");
      return { output: [call("dispatch_task", { task_id: taskId, agent: null, instructions: null }, { async: true })] };
    }
    if (index === 3) {
      assert.equal(outputs[0].output.policy.phase, "complete");
      return { output: [message("Validated and reviewed.")] };
    }
    throw new Error(`unexpected request ${index}`);
  };
  const { coordinator, fleet, file, dir } = await setup(script);
  let state = createTask(await readWorkspace(file, dir), { title: "Validate existing edit", budgetUsd: 3 });
  state.tasks[0].id = taskId;
  await writeWorkspace(state, file);

  const run = await coordinator.start({ goal: "validate the implementation" });
  const implementation = await fleet.session(1);
  implementation.finish({
    testsPassed: 0,
    edited: 1,
    parts: [{ kind: "tool", tool: { name: "Edit", input: { file_path: "src/a.ts" }, result: "ok", isError: false } }],
  });
  const validation = await fleet.session(2);
  validation.finish({
    testsPassed: 1,
    edited: 0,
    parts: [{ kind: "tool", tool: { name: "Bash", input: { command: "npm test" }, result: "5 passed", isError: false } }],
  });
  const review = await fleet.session(3);
  assert.equal(review.agent, "codex");
  review.finish({ testsPassed: 0, edited: 0, parts: [{ kind: "text", text: "FOOLSCAP_REVIEW: PASS" }] });
  await coordinator.settled(run.id);

  const saved = (await readWorkspace(file, dir)).runs.find((item) => item.id === run.id);
  assert.equal(saved.status, "done");
  assert.equal(saved.workflow[taskId].lastWriterAgent, implementation.agent);
});

test("passing validation does not hide an unrelated tool error", async () => {
  const taskId = "tool-error";
  const script = (body, index) => {
    const outputs = outputsIn(body);
    if (index === 0) return { output: [call("dispatch_task", { task_id: taskId, agent: null, instructions: null }, { async: true })] };
    if (index === 1) {
      assert.equal(outputs[0].output.evidence.errors, 1);
      assert.equal(outputs[0].output.policy.phase, "needs-repair");
      return { output: [call("dispatch_task", { task_id: taskId, agent: null, instructions: null }, { async: true })] };
    }
    if (index === 2) return { output: [call("dispatch_task", { task_id: taskId, agent: null, instructions: null }, { async: true })] };
    if (index === 3) return { output: [message("Repaired and reviewed.")] };
    throw new Error(`unexpected request ${index}`);
  };
  const { coordinator, fleet, file, dir } = await setup(script);
  let state = createTask(await readWorkspace(file, dir), { title: "Handle a tool error", budgetUsd: 3 });
  state.tasks[0].id = taskId;
  await writeWorkspace(state, file);

  const run = await coordinator.start({ goal: "handle the failed generator" });
  const implementation = await fleet.session(1);
  implementation.finish({
    testsPassed: 1,
    errors: 1,
    edited: 1,
    parts: [
      { kind: "tool", tool: { name: "Edit", input: { file_path: "src/a.ts" }, result: "ok", isError: false } },
      { kind: "tool", tool: { name: "Bash", input: { command: "generate-schema" }, result: "permission denied", isError: true } },
      { kind: "tool", tool: { name: "Bash", input: { command: "npm test" }, result: "5 passed", isError: false } },
    ],
  });
  const repair = await fleet.session(2);
  repair.finish({ testsPassed: 1, errors: 0, edited: 1 });
  const review = await fleet.session(3);
  review.finish({ testsPassed: 0, edited: 0, parts: [{ kind: "text", text: "FOOLSCAP_REVIEW: PASS" }] });
  await coordinator.settled(run.id);
  assert.equal((await readWorkspace(file, dir)).runs.find((item) => item.id === run.id).status, "done");
});

test("ask_user parks the run as needs-you until a person answers", async () => {
  const script = (body, index) => {
    if (index === 0) return { output: [call("ask_user", { question: "Keep the public API unchanged?" })] };
    const answer = outputsIn(body)[0].output.answer;
    assert.equal(answer, "yes, keep it");
    return { output: [message("Understood: API stays. Nothing to dispatch.")] };
  };
  const { coordinator } = await setup(script);
  const run = await coordinator.start({ goal: "tidy the API" });
  const parked = await untilStatus(coordinator, run.id, "needs-you");
  assert.equal(parked.question.text, "Keep the public API unchanged?");
  assert.throws(() => coordinator.answer("run-nope", "x"), /not active/);
  coordinator.answer(run.id, "yes, keep it");
  await coordinator.settled(run.id);
  assert.equal(coordinator.get(run.id), null);
});

test("a 429 is retried with the server's delay; a 400 fails the run with the message", async () => {
  const script = (body, index) => {
    if (index === 0) return { status: 429, message: "slow down", retryAfter: 0 };
    if (index === 1) return { output: [message("ok")] };
    return { status: 400, message: "bad request from test" };
  };
  const { api, coordinator, file, dir } = await setup(script);
  const run = await coordinator.start({ goal: "first" });
  await coordinator.settled(run.id);
  assert.equal(api.requests.length, 2);
  let saved = (await readWorkspace(file, dir)).runs.find((r) => r.id === run.id);
  assert.equal(saved.status, "done");
  assert.ok(saved.events.some((e) => e.kind === "retry" && e.status === 429));

  const second = await coordinator.start({ goal: "second" });
  await coordinator.settled(second.id);
  saved = (await readWorkspace(file, dir)).runs.find((r) => r.id === second.id);
  assert.equal(saved.status, "failed");
  assert.match(saved.error, /HTTP 400 — bad request from test/);
});

test("model choice is bounded and the first request falls back when access is unavailable", async () => {
  const script = (body, index) => {
    assert.equal(body.max_output_tokens, 1200);
    if (index === 0) {
      assert.equal(body.model, "gpt-6-astra");
      return { status: 404, message: "model is not available to this project" };
    }
    assert.equal(body.model, "gpt-5.6-luna");
    return { output: [message("Fallback completed the planning request.")] };
  };
  const { coordinator, file, dir, api } = await setup(script);
  await assert.rejects(() => coordinator.start({ goal: "x", model: "not-configured" }), /not configured/);
  const run = await coordinator.start({ goal: "use an available model" });
  await coordinator.settled(run.id);
  const saved = (await readWorkspace(file, dir)).runs.find((item) => item.id === run.id);
  assert.equal(saved.status, "done");
  assert.equal(saved.model, "gpt-5.6-luna");
  assert.equal(api.requests.length, 2);
  assert.ok(saved.events.some((event) => event.kind === "model-fallback" && event.from === "gpt-6-astra"));
});

test("the run stops when its own budget is spent", async () => {
  const script = () => ({ output: [call("list_tasks", { status: null })], usage: { input_tokens: 100_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10_000 } });
  const { coordinator, file, dir } = await setup(script);
  const run = await coordinator.start({ goal: "spend", budgetUsd: 0.5 });
  await coordinator.settled(run.id);
  const saved = (await readWorkspace(file, dir)).runs.find((r) => r.id === run.id);
  assert.equal(saved.status, "failed");
  assert.match(saved.error, /run budget of \$0\.50 reached/);
});

test("cancel stops the loop and the agents it started", async () => {
  const script = (body, index) => {
    if (index === 0) return { output: [call("dispatch_task", { task_id: "pre", agent: null, instructions: null }, { async: true, id: "call_c1" })] };
    throw new Error("the model should not be asked again after cancel");
  };
  const { file, dir, fleet, coordinator } = await setup(script);
  // A task that already exists on the board.
  let state = await readWorkspace(file, dir);
  state = createTask(state, { title: "Long job", budgetUsd: 3 });
  state.tasks[0].id = "pre";
  state.nodes = state.nodes.map((n) => (n.kind === "task" ? { ...n, id: "pre" } : n));
  await writeWorkspace(state, file);

  const run = await coordinator.start({ goal: "run the long job" });
  const session = await fleet.session(1);
  await untilStatus(coordinator, run.id, "working");
  coordinator.cancel(run.id);
  await coordinator.settled(run.id);
  assert.equal(session.stopReason, "cancelled");
  const saved = (await readWorkspace(file, dir)).runs.find((r) => r.id === run.id);
  assert.equal(saved.status, "cancelled");
});

test("the API refuses unmarked posts, reports readiness, and serves runs from the file", async () => {
  const { dir, file, fleet, api } = await setup(() => ({ output: [message("hi")] }));
  const coordinator = createCoordinator({ file, root: dir, fleet, apiKey: "", baseUrl: api.url });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!(await handleCoordinatorApi(req, res, url, { coordinator }))) {
      res.statusCode = 404;
      res.end();
    }
  });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const unmarked = await fetch(`${base}/api/coordinator/runs`, { method: "POST", body: "{}" });
  assert.equal(unmarked.status, 403);
  const noKey = await fetch(`${base}/api/coordinator/runs`, { method: "POST", headers: { "x-foolscap": "coordinator", "content-type": "application/json" }, body: JSON.stringify({ goal: "x" }) });
  assert.equal(noKey.status, 503);
  const list = await (await fetch(`${base}/api/coordinator/runs`)).json();
  assert.equal(list.ready, false);
  assert.deepEqual(list.models, ["gpt-6-astra", "gpt-5.6-luna"]);
  assert.deepEqual(list.budget, { enforcement: "observed", hardCap: false, maxOutputTokens: 1200 });
  assert.deepEqual(list.runs, []);

  // A run left "working" by a previous process is marked interrupted on the next listing.
  let state = await readWorkspace(file, dir);
  state.runs = [{ id: "run-old", goal: "g", status: "working", events: [], createdAt: "t", updatedAt: "t" }];
  await writeWorkspace(state, file);
  const reaped = await (await fetch(`${base}/api/coordinator/runs`)).json();
  assert.equal(reaped.runs[0].status, "interrupted");
  const one = await (await fetch(`${base}/api/coordinator/runs/run-old`)).json();
  assert.equal(one.error, "the server restarted while this run was in flight");
});
