/**
 * The coordinator — one conversation that runs your agents.
 *
 * GPT-6 Astra plans; foolscap executes and judges. Astra's two agent
 * primitives map one-to-one onto what a coordinator needs:
 *
 *   dispatch_task   an *async* tool. Astra issues it and keeps going —
 *                   planning, dispatching another task, or answering. The
 *                   result is delivered later, by call id, and that result
 *                   is the evidence engine's verdict: tests red or green,
 *                   files edited, the agent's own last words. Never the
 *                   agent's claim that it succeeded.
 *   ask_user        synchronous. Blocks the run until a person answers
 *                   in the UI, and the run shows "needs you" until then.
 *
 * Nothing here trusts the model about outcomes. The model reads evidence;
 * foolscap produces it, from the same classifier the archive uses.
 *
 * A run is durable: every event lands in ~/.foolscap/workspace.json as it
 * happens, so the UI can replay it and a restart marks it interrupted
 * instead of losing it. The loop itself is in-process; the Responses API
 * is the only thing off-machine, and only the brief and evidence go there.
 */
import { randomUUID } from "node:crypto";
import { classifyRun, commandOf } from "./outcome.mjs";
import { FLEET_AGENTS } from "./fleet.mjs";
import {
  createTask,
  mutateWorkspace,
  readWorkspace,
  searchWorkspaceContents,
} from "./workspace.mjs";
import { launchWorkspaceTask, synchronizedState } from "./workspace-api.mjs";

export const DEFAULT_MODEL = "gpt-6-astra";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** $ per million tokens, from the model pages, September 2026. */
export const PRICES = {
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 }, // promotional rate
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
};

export const DEFAULT_MODELS = ["gpt-6-astra", "gpt-5.6-luna"];

export function configuredModels(primary, value) {
  const listed = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [primary, ...listed, ...DEFAULT_MODELS]
    .map((model) => String(model ?? "").trim())
    .filter((model, index, all) => model && all.indexOf(model) === index);
}

const modelUnavailable = (status, message) =>
  [400, 403, 404].includes(status) && /(model|access|available|permission|exist|found)/i.test(message);

/** Cost of one response, or null when the model's price isn't known. */
export function costOf(model, usage = {}) {
  const price = PRICES[model];
  if (!price) return null;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const input = Math.max(0, (usage.input_tokens ?? 0) - cached);
  const output = usage.output_tokens ?? 0;
  return (input * price.input + cached * price.cachedInput + output * price.output) / 1_000_000;
}

const fn = (name, description, properties, required = Object.keys(properties)) => ({
  type: "function",
  name,
  description,
  strict: true,
  parameters: { type: "object", properties, required, additionalProperties: false },
});

const STATES = ["backlog", "ready", "running", "review", "blocked", "done"];

export const TOOLS = [
  fn("list_tasks", "Every task on the board with its id, state, agent, budget and latest evidence.", {
    status: { type: ["string", "null"], enum: [...STATES, null], description: "Only tasks in this state, or null for all." },
  }),
  fn("search_workspace", "Search the connected folders' file contents and the board. Use it before writing a brief so the task names real files.", {
    query: { type: "string" },
  }),
  fn("create_task", "Add a task to the board. This records the work; dispatch_task starts it.", {
    title: { type: "string", description: "Short and concrete." },
    detail: { type: "string", description: "The brief an agent will work from: what to change, where (file paths from search_workspace), what done looks like, what not to touch." },
    priority: { type: "string", enum: ["P0", "P1", "P2"] },
    budget_usd: { type: "number", minimum: 0.25, maximum: 100 },
  }),
  {
    ...fn("dispatch_task", "Start an agent on a task, on the user's machine. This tool is asynchronous: you may keep working and dispatch other independent tasks; its result arrives later and is foolscap's evidence — test runs, edited files, the agent's last message — not the agent's opinion.", {
      task_id: { type: "string" },
      agent: { type: ["string", "null"], description: "An agent id from the available list, or null for auto (Claude Code first, then by load)." },
      instructions: { type: ["string", "null"], description: "Extra instructions for this attempt only, e.g. the failing test output for a repair, or 'review only: read the diff and report problems, do not fix'." },
    }),
    async: true,
  },
  fn("read_evidence", "What foolscap observed on a task's latest attempt: test runs and their output, edited files, errors, the agent's last message, cost.", {
    task_id: { type: "string" },
  }),
  fn("wait_for_tasks", "Block until at least one dispatched task finishes. Its results are delivered before this call's output.", {}),
  fn("ask_user", "Ask the person one question and wait for the answer. Use it only when the answer changes the work.", {
    question: { type: "string" },
  }),
];

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTIVE = new Set(["starting", "idle", "working", "blocked"]);
const SETTLED = new Set(["done", "error", "exited"]);
const MAX_IMPLEMENTATION_REPAIRS = 2;
const MAX_REVIEW_REPAIRS = 1;
const MAX_REVIEW_ATTEMPTS = 2;

function textOf(item) {
  return (item.content ?? [])
    .filter((c) => c?.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

function parseArgs(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function isEdit(tool) {
  return (
    /^(edit|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool.name) ||
    typeof tool.input?.old_string === "string" ||
    typeof tool.input?.new_string === "string"
  );
}

/** What the model is told, every request (instructions don't carry over). */
export function instructionsFor(state, run, agents) {
  const sources = state.sources.map((s) => `${s.label} (${s.path})`).join(", ") || "none";
  const agentList = agents.map((a) => `${a.id} — ${a.label}`).join("; ");
  return [
    "You are foolscap's coordinator. You run coding agents on the user's machine; you never edit code yourself.",
    `Workspace: ${state.name || "unnamed"} at ${state.root}. Connected folders: ${sources}.`,
    `Agents: ${agentList}. "auto" picks Claude Code first, then by load.`,
    "",
    "How you work:",
    "1. Understand the goal. If it is ambiguous in a way that changes the work, ask_user once, briefly. Otherwise do not ask.",
    "2. search_workspace before writing a brief; the task detail must name real files and say what done looks like.",
    "3. create_task, then dispatch_task. Dispatch is asynchronous: independent tasks can run at once; call wait_for_tasks when you have nothing else to do.",
    "4. Foolscap enforces the workflow after every dispatch: failed or missing validation requires a bounded repair; passing changes require a read-only review by a different agent; review findings allow one repair and another review. Follow the `policy.next_action` returned by dispatch_task.",
    "5. If the result says the agent needs the user (a permission), say so and wait; the person answers in the Agents view.",
    "6. Never report success without evidence. Finish with a short report: each task, which agent, what the evidence shows, and anything that still needs the person.",
    `Your own budget for this run is $${run.budgetUsd.toFixed(2)}; keep messages short.`,
  ].join("\n");
}

class CoordinatorRun {
  constructor(run, ctx) {
    this.run = run;
    this.ctx = ctx;
    this.pending = new Map(); // call_id → promise
    this.ready = []; // completed async outputs not yet delivered
    this.sessionIds = new Set(); // every agent this run launched
    this.answerResolver = null;
    this.aborted = false;
    this.done = null; // promise of the loop
  }

  event(kind, data = {}) {
    this.run.events.push({ t: now(), kind, ...data });
    this.run.updatedAt = now();
  }

  async save() {
    const { file, root } = this.ctx;
    const run = this.run;
    await mutateWorkspace(file, root, (state) => ({
      ...state,
      runs: [run, ...(state.runs ?? []).filter((r) => r.id !== run.id)],
    }));
  }

  fail(message) {
    this.run.status = "failed";
    this.run.error = message;
    this.event("error", { text: message });
  }

  policy(taskId) {
    this.run.workflow ??= {};
    this.run.workflow[taskId] ??= {
      phase: "new",
      implementationRepairs: 0,
      reviewRepairs: 0,
      reviews: 0,
      lastWriterAgent: null,
      lastEvidence: null,
    };
    return this.run.workflow[taskId];
  }

  workflowGate() {
    const incomplete = [];
    for (const taskId of this.run.taskIds) {
      const policy = this.policy(taskId);
      if (policy.phase === "complete") continue;
      if (policy.phase === "failed") {
        return { ok: false, terminal: true, message: `${taskId}: ${policy.error || "workflow policy failed"}` };
      }
      incomplete.push(`${taskId}: ${policy.phase}`);
    }
    return incomplete.length
      ? { ok: false, terminal: false, message: `unfinished task workflow (${incomplete.join(", ")})` }
      : { ok: true };
  }

  updatePolicy(taskId, role, agent, evidence) {
    const policy = this.policy(taskId);
    const observed = evidence.evidence ?? {};
    const finalTest = evidence.test_runs?.at(-1) ?? null;
    const failed = evidence.attempt_state === "error" || evidence.attempt_state === "exited" ||
      Boolean(evidence.error) || (finalTest ? finalTest.failed : (observed.testsFailed ?? 0) > 0 || (observed.errors ?? 0) > 0);
    const validated = finalTest ? finalTest.passed : (observed.testsPassed ?? 0) > 0;
    const edited = evidence.edited_files?.length ?? observed.edited ?? 0;

    if (role === "review") {
      policy.reviews += 1;
      const verdict = /FOOLSCAP_REVIEW:\s*(PASS|CHANGES_REQUESTED)/i.exec(evidence.last_message ?? "")?.[1]?.toUpperCase() ?? null;
      if (failed || edited > 0 || verdict === "CHANGES_REQUESTED") {
        if (policy.reviewRepairs >= MAX_REVIEW_REPAIRS) {
          policy.phase = "failed";
          policy.error = "review still found problems after the allowed review repair";
        } else {
          policy.phase = "needs-review-repair";
        }
      } else if (verdict === "PASS") {
        policy.phase = "complete";
      } else if (policy.reviews >= MAX_REVIEW_ATTEMPTS) {
        policy.phase = "failed";
        policy.error = "review agents did not return a machine-readable verdict";
      } else {
        policy.phase = "needs-review";
      }
    } else {
      const reviewRepair = role === "review-repair";
      if (role === "repair") policy.implementationRepairs += 1;
      if (reviewRepair) policy.reviewRepairs += 1;
      policy.lastWriterAgent = agent;
      if (failed || !validated || edited === 0) {
        const exhausted = reviewRepair
          ? policy.reviewRepairs >= MAX_REVIEW_REPAIRS
          : policy.implementationRepairs >= MAX_IMPLEMENTATION_REPAIRS;
        if (exhausted) {
          policy.phase = "failed";
          policy.error = failed ? "validation still fails after the allowed repairs" : "the agent did not produce edited files with passing validation";
        } else {
          policy.phase = reviewRepair ? "needs-review-repair" : "needs-repair";
        }
      } else {
        policy.phase = "needs-review";
      }
    }
    policy.lastEvidence = {
      agent,
      role,
      testsPassed: observed.testsPassed ?? 0,
      testsFailed: observed.testsFailed ?? 0,
      errors: observed.errors ?? 0,
      edited,
    };
    const nextAction = {
      new: "dispatch implementation",
      "needs-repair": "dispatch repair with the failing or missing validation evidence",
      "needs-review": "dispatch read-only review on a different agent",
      "needs-review-repair": "dispatch one repair for the review findings",
      complete: "workflow complete",
      failed: policy.error,
    }[policy.phase];
    this.event("policy", { taskId, phase: policy.phase, role, agent, text: nextAction });
    return { ...policy, next_action: nextAction };
  }

  // ── The model ───────────────────────────────────────────────────────

  async request(input, previous) {
    const { apiKey, baseUrl, fetchImpl, retryDelayMs, effort, agents } = this.ctx;
    let model = this.run.model;
    const state = await readWorkspace(this.ctx.file, this.ctx.root);
    const body = {
      model,
      instructions: instructionsFor(state, this.run, agents),
      input,
      tools: TOOLS,
      tool_choice: "auto",
      store: true,
      reasoning: { effort },
      max_output_tokens: this.ctx.maxOutputTokens,
      ...(previous ? { previous_response_id: previous } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      let message = "";
      try {
        message = JSON.parse(text)?.error?.message ?? "";
      } catch {
        message = text.slice(0, 200);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const after = Number(res.headers.get("retry-after"));
        this.event("retry", { status: res.status, attempt: attempt + 1 });
        await sleep(after > 0 ? after * 1000 : retryDelayMs * (attempt + 1));
        continue;
      }
      if (!previous && this.run.turns === 0 && modelUnavailable(res.status, message)) {
        const fallback = this.ctx.models[this.ctx.models.indexOf(model) + 1];
        if (fallback) {
          const from = model;
          model = fallback;
          this.run.model = fallback;
          this.run.costUsd = PRICES[fallback] ? 0 : null;
          body.model = fallback;
          this.event("model-fallback", { from, model: fallback, status: res.status, text: message });
          attempt = -1;
          continue;
        }
      }
      throw new Error(`${model}: HTTP ${res.status}${message ? ` — ${message}` : ""}`);
    }
  }

  // ── Tools ───────────────────────────────────────────────────────────

  async execute(name, args) {
    const { file, root, fleet } = this.ctx;
    switch (name) {
      case "list_tasks": {
        const state = await synchronizedState(file, root, fleet);
        return {
          tasks: state.tasks
            .filter((task) => !args.status || task.status === args.status)
            .slice(0, 40)
            .map((task) => {
              const attempt = task.attempts?.at(-1);
              return {
                id: task.id,
                title: task.title,
                state: task.status,
                priority: task.priority,
                agent: task.agent,
                budget_usd: task.budgetUsd,
                spent_usd: task.spentUsd,
                spend_known: task.spentKnown !== false,
                attempt_state: attempt?.status ?? null,
                evidence: attempt?.evidence ?? null,
                detail: task.detail.slice(0, 300),
              };
            }),
        };
      }
      case "search_workspace": {
        const state = await readWorkspace(file, root);
        const hits = await searchWorkspaceContents(state, args.query);
        return { hits: hits.slice(0, 20).map((hit) => ({ type: hit.type, path: hit.label, snippet: hit.detail.slice(0, 300), kind: hit.kind })) };
      }
      case "create_task": {
        let created;
        await mutateWorkspace(file, root, (state) => {
          const next = createTask(state, { title: args.title, detail: args.detail, priority: args.priority, budgetUsd: args.budget_usd });
          created = next.tasks[0];
          return next;
        });
        this.run.taskIds.push(created.id);
        this.event("task", { taskId: created.id, title: created.title });
        return { task_id: created.id, title: created.title, state: created.status };
      }
      case "read_evidence": {
        const state = await synchronizedState(file, root, fleet);
        return this.evidence(state, args.task_id);
      }
      case "wait_for_tasks": {
        if (!this.pending.size) return { pending: 0, completed: [] };
        const before = new Set(this.ready.map((r) => r.call_id));
        await Promise.race([...this.pending.values()]);
        return {
          completed: this.ready.filter((r) => !before.has(r.call_id)).map((r) => r.call_id),
          still_pending: [...this.pending.keys()],
        };
      }
      case "ask_user": {
        // The resolver exists before the run is visibly waiting, so an
        // answer that arrives the moment the UI shows the question lands.
        const answered = new Promise((resolve) => {
          this.answerResolver = resolve;
        });
        this.run.status = "needs-you";
        this.run.question = { text: String(args.question ?? ""), askedAt: now() };
        this.event("question", { text: this.run.question.text });
        await this.save();
        const answer = await answered;
        this.answerResolver = null;
        this.run.question = null;
        if (answer === null) return { answer: null, cancelled: true };
        this.run.status = "working";
        this.event("answer", { text: answer });
        return { answer };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  /** The dispatch: launch, wait for the agent to settle, return evidence. */
  async dispatch(args) {
    const { file, root, fleet } = this.ctx;
    const taskId = String(args.task_id ?? "");
    if (this.aborted) return { status: "cancelled", task_id: taskId };
    // launchWorkspaceTask performs the atomic live-state reconciliation and
    // duplicate check. This read is only for workflow validation.
    const before = await readWorkspace(file, root);
    const taskBefore = before.tasks.find((item) => item.id === taskId);
    if (!taskBefore) throw new Error("task not found");
    const policy = this.policy(taskId);
    const role = {
      new: "implement",
      "needs-repair": "repair",
      "needs-review": "review",
      "needs-review-repair": "review-repair",
    }[policy.phase];
    if (!role) throw new Error(policy.phase === "complete" ? "task workflow is already complete" : policy.error || "task workflow cannot continue");
    if (role === "repair" && policy.implementationRepairs >= MAX_IMPLEMENTATION_REPAIRS) throw new Error("implementation repair limit reached");
    if (role === "review-repair" && policy.reviewRepairs >= MAX_REVIEW_REPAIRS) throw new Error("review repair limit reached");
    if (role === "review" && policy.reviews >= MAX_REVIEW_ATTEMPTS) throw new Error("review attempt limit reached");

    const requested = args.agent ?? "auto";
    if (role === "review" && requested !== "auto" && requested !== null && requested === policy.lastWriterAgent) {
      throw new Error("review must run on a different agent from the writer");
    }
    const policyInstruction = role === "review"
      ? "Read-only review. Inspect the completed diff and relevant tests. Do not edit files. End your final response with exactly one line: FOOLSCAP_REVIEW: PASS or FOOLSCAP_REVIEW: CHANGES_REQUESTED. If changes are requested, state concrete findings before the marker."
      : role === "repair" || role === "review-repair"
        ? `This is a bounded ${role === "review-repair" ? "review repair" : "repair"}. Fix the observed problem and run relevant validation. Observed evidence: ${JSON.stringify(policy.lastEvidence)}`
        : "This is the implementation attempt. Produce the requested change and run relevant validation.";
    const extraInstruction = typeof args.instructions === "string" && args.instructions.trim() ? args.instructions.trim() : null;
    const instructions = [policyInstruction, extraInstruction].filter(Boolean).join("\n\n");
    const { state, sessionId, decision } = await launchWorkspaceTask({
      taskId,
      requestedAgent: requested,
      instructions,
      fleet,
      file,
      root,
      fleetUrl: this.run.fleetUrl,
      excludedAgents: role === "review" && policy.lastWriterAgent ? [policy.lastWriterAgent] : [],
      purpose: role,
      coordinatorRunId: this.run.id,
      onLaunch: (id) => {
        this.sessionIds.add(id);
        if (this.aborted) fleet.get(id)?.cancel();
      },
    });
    const task = state.tasks.find((item) => item.id === taskId);
    if (!this.run.taskIds.includes(taskId)) this.run.taskIds.push(taskId);
    this.event("dispatch", { taskId, title: task?.title ?? taskId, agent: decision.agent, sessionId, reason: decision.reason });
    await this.save();

    const session = fleet.get(sessionId);
    if (session) await this.settled(session, taskId);
    const final = await synchronizedState(file, root, fleet);
    const evidence = this.evidence(final, taskId);
    this.event("evidence", {
      taskId,
      title: task?.title ?? taskId,
      agent: decision.agent,
      testsPassed: evidence.evidence?.testsPassed ?? 0,
      testsFailed: evidence.evidence?.testsFailed ?? 0,
      errors: evidence.evidence?.errors ?? 0,
      edited: evidence.edited_files.length,
      attemptState: evidence.attempt_state,
    });
    const nextPolicy = this.updatePolicy(taskId, role, decision.agent, evidence);
    if (nextPolicy.phase === "complete" || nextPolicy.phase === "failed") {
      await mutateWorkspace(file, root, (current) => ({
        ...current,
        tasks: current.tasks.map((item) => item.id === taskId
          ? { ...item, status: nextPolicy.phase === "complete" ? "done" : "blocked", progress: nextPolicy.phase === "complete" ? 100 : item.progress, updatedAt: now() }
          : item),
      }));
    }
    await this.save();
    return { ...evidence, policy: nextPolicy };
  }

  /** Resolve when the session's turn ends; note a permission wait once. */
  settled(session, taskId) {
    return new Promise((resolve) => {
      let notedBlock = false;
      const check = () => {
        if (this.aborted) return finish();
        if (session.status === "blocked" && !notedBlock) {
          notedBlock = true;
          this.event("blocked", { taskId, text: "the agent is waiting for a permission answer in Agents" });
          this.save().catch(() => {});
        }
        if (SETTLED.has(session.status) || (session.status === "idle" && session.turns > 0 && session.doneAt)) finish();
      };
      const finish = () => {
        session.off("change", check);
        resolve();
      };
      session.on("change", check);
      check();
    });
  }

  evidence(state, taskId) {
    const { fleet } = this.ctx;
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return { error: "task not found", task_id: taskId };
    const attempt = task.attempts?.at(-1) ?? null;
    const session = attempt ? fleet.get(attempt.sessionId) : null;
    const cell = session?.doc?.().cells?.at(-1) ?? null;
    const testRuns = [];
    const edited = new Set();
    let lastMessage = "";
    for (const part of cell?.parts ?? []) {
      if (part.kind === "text" && part.text) lastMessage = part.text;
      if (part.kind !== "tool") continue;
      const tool = part.tool;
      const command = commandOf(tool);
      const run = classifyRun(command, tool.result ?? "", tool.isError);
      if (run.tested) {
        testRuns.push({ command: command.slice(0, 200), passed: run.passed, failed: run.failed, output_tail: (tool.result ?? "").slice(-1200) });
      }
      if (isEdit(tool) && tool.input?.file_path) edited.add(String(tool.input.file_path));
    }
    return {
      task_id: task.id,
      title: task.title,
      task_state: task.status,
      agent: attempt?.agentLabel ?? attempt?.agent ?? task.agent,
      model: attempt?.model ?? null,
      attempt_state: attempt?.status ?? null,
      stop_reason: attempt?.stopReason ?? null,
      evidence: attempt?.evidence ?? null,
      test_runs: testRuns.slice(-5),
      edited_files: [...edited].slice(0, 40),
      last_message: lastMessage.slice(-1500),
      cost_usd: typeof attempt?.costUsd === "number" ? attempt.costUsd : null,
      output_tokens: attempt?.outputTokens ?? 0,
      error: attempt?.error ?? null,
      needs_you: attempt?.status === "blocked" ? "the agent is waiting for a permission answer in the Agents view" : null,
    };
  }

  startAsync(call) {
    const args = parseArgs(call.arguments);
    const promise = (async () => {
      let result;
      try {
        result = await this.dispatch(args);
      } catch (err) {
        this.event("error", { text: `dispatch failed: ${err.message}` });
        result = { status: "error", error: err.message, task_id: args.task_id ?? null };
      }
      this.ready.push({ call_id: call.call_id, result });
      this.event("result", { name: call.name, callId: call.call_id, summary: JSON.stringify(result).slice(0, 400) });
      await this.save();
      return result;
    })();
    this.pending.set(call.call_id, promise);
    promise.finally(() => this.pending.delete(call.call_id));
  }

  drainReady() {
    const out = this.ready.map((r) => ({ type: "function_call_output", call_id: r.call_id, output: JSON.stringify(r.result) }));
    this.ready = [];
    return out;
  }

  // ── The loop ────────────────────────────────────────────────────────

  async loop() {
    const run = this.run;
    let input = [{ role: "user", content: run.goal }];
    let previous = null;
    run.status = "planning";
    await this.save();
    try {
      for (;;) {
        if (this.aborted) break;
        const response = await this.request(input, previous);
        previous = response.id;
        run.lastResponseId = previous;
        run.turns += 1;
        const usage = response.usage ?? {};
        run.usage.input += usage.input_tokens ?? 0;
        run.usage.cached += usage.input_tokens_details?.cached_tokens ?? 0;
        run.usage.output += usage.output_tokens ?? 0;
        const cost = costOf(run.model, usage);
        if (cost !== null) run.costUsd = (run.costUsd ?? 0) + cost;

        for (const item of response.output ?? []) {
          if (item.type === "message") {
            const text = textOf(item);
            if (text) {
              run.summary = text;
              this.event("message", { text });
            }
          }
        }
        if (run.costUsd !== null && run.costUsd > run.budgetUsd) {
          this.fail(`run budget of $${run.budgetUsd.toFixed(2)} reached ($${run.costUsd.toFixed(2)} spent on the coordinator)`);
          break;
        }

        const calls = (response.output ?? []).filter((item) => item.type === "function_call");
        const outputs = [];
        for (const call of calls) {
          const args = parseArgs(call.arguments);
          this.event("call", { name: call.name, args, callId: call.call_id, async: call.async === true });
          if (call.async === true) {
            this.startAsync(call);
            continue;
          }
          const result = await this.execute(call.name, args);
          if (this.aborted) break;
          this.event("result", { name: call.name, callId: call.call_id, summary: JSON.stringify(result).slice(0, 400) });
          outputs.push(...this.drainReady());
          outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
        }
        if (this.aborted) break;
        if (!outputs.length) {
          outputs.push(...this.drainReady());
          if (!outputs.length && this.pending.size) {
            run.status = "working";
            await this.save();
            await Promise.race([...this.pending.values()]);
            outputs.push(...this.drainReady());
          }
          // An async dispatch can settle between the first drain and the
          // pending-size check. Drain once more before deciding the model
          // has finished the workflow.
          if (!outputs.length) outputs.push(...this.drainReady());
        }
        if (this.aborted) break;
        if (!outputs.length) {
          const gate = this.workflowGate();
          if (!gate.ok) {
            if (gate.terminal || run.policyNudges >= 3) {
              this.fail(gate.terminal ? gate.message : `workflow policy was not completed after 3 reminders: ${gate.message}`);
              break;
            }
            run.policyNudges += 1;
            this.event("policy", { phase: "reminder", text: gate.message });
            run.status = "working";
            await this.save();
            input = [{ role: "user", content: `Foolscap execution policy: ${gate.message}. Continue the workflow using dispatch_task and its returned policy.next_action.` }];
            continue;
          }
          run.status = "done";
          this.event("done", { summary: run.summary });
          break;
        }
        run.status = "working";
        await this.save();
        input = outputs;
      }
    } catch (err) {
      this.fail(err?.message ?? String(err));
    }
    if (this.aborted && run.status !== "failed") {
      run.status = "cancelled";
      this.event("cancelled");
    }
    run.endedAt = now();
    await this.save();
  }

  answer(text) {
    if (!this.answerResolver) throw new Error("this run is not waiting for an answer");
    this.answerResolver(String(text));
  }

  cancel() {
    this.aborted = true;
    this.answerResolver?.(null);
    const { fleet } = this.ctx;
    for (const id of this.sessionIds) {
      const session = fleet.get(id);
      if (session && ACTIVE.has(session.status)) session.cancel();
    }
  }
}

/** One coordinator per process: holds the live runs; the file holds all of them. */
export function createCoordinator(options = {}) {
  const primaryModel = options.model ?? process.env.FOOLSCAP_COORDINATOR_MODEL ?? DEFAULT_MODEL;
  const ctx = {
    file: options.file,
    root: options.root ?? process.cwd(),
    fleet: options.fleet,
    apiKey: options.apiKey,
    baseUrl: (options.baseUrl ?? process.env.FOOLSCAP_OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    model: primaryModel,
    models: configuredModels(primaryModel, options.models ?? process.env.FOOLSCAP_COORDINATOR_MODELS),
    fetchImpl: options.fetchImpl ?? fetch,
    retryDelayMs: options.retryDelayMs ?? 1500,
    effort: options.effort ?? "medium",
    maxOutputTokens: Number.isFinite(options.maxOutputTokens) ? Math.max(256, Math.min(8_000, options.maxOutputTokens)) : 1_200,
    agents: Object.entries(FLEET_AGENTS).map(([id, entry]) => ({ id, label: entry.label })),
  };
  const active = new Map();

  return {
    ctx,
    async start({ goal, budgetUsd, fleetUrl, model }) {
      const text = String(goal ?? "").trim();
      if (!text) throw new Error("say what needs doing");
      if (!ctx.apiKey) throw new Error("Set OPENAI_API_KEY to use the coordinator");
      const selectedModel = model ? String(model) : ctx.model;
      if (!ctx.models.includes(selectedModel)) throw new Error("selected coordinator model is not configured");
      const run = {
        id: `run-${randomUUID()}`,
        goal: text,
        status: "planning",
        model: selectedModel,
        budgetUsd: Number.isFinite(budgetUsd) ? Math.min(50, Math.max(0.25, budgetUsd)) : 2,
        costUsd: PRICES[selectedModel] ? 0 : null,
        usage: { input: 0, cached: 0, output: 0 },
        turns: 0,
        lastResponseId: null,
        taskIds: [],
        workflow: {},
        policyNudges: 0,
        question: null,
        summary: null,
        error: null,
        fleetUrl: fleetUrl ?? null,
        events: [],
        createdAt: now(),
        updatedAt: now(),
        endedAt: null,
      };
      const controller = new CoordinatorRun(run, ctx);
      active.set(run.id, controller);
      controller.done = controller.loop().finally(() => active.delete(run.id));
      await controller.save();
      return structuredClone(run);
    },
    get(id) {
      return active.get(id)?.run ?? null;
    },
    answer(id, text) {
      const controller = active.get(id);
      if (!controller) throw new Error("run is not active");
      controller.answer(text);
    },
    cancel(id) {
      const controller = active.get(id);
      if (!controller) throw new Error("run is not active");
      controller.cancel();
    },
    /** Runs left mid-flight by a previous process are marked, not lost. */
    async reap() {
      return mutateWorkspace(ctx.file, ctx.root, (state) => {
        let changed = false;
        const runs = (state.runs ?? []).map((run) => {
          if (active.has(run.id) || !["planning", "working", "needs-you"].includes(run.status)) return run;
          changed = true;
          return { ...run, status: "interrupted", error: "the server restarted while this run was in flight", endedAt: run.endedAt ?? now(), question: null };
        });
        return changed ? { ...state, runs } : state;
      });
    },
    /** For tests: resolves when the run's loop has finished. */
    settled(id) {
      return active.get(id)?.done ?? Promise.resolve();
    },
  };
}
