/**
 * A scripted stand-in for the OpenAI Responses API, for the coordinator
 * tests. `script(body, index)` returns what the "model" says for each
 * request in order: `{ output, usage }`, or `{ status, message,
 * retryAfter }` to fail that request. Every request body is recorded.
 */
import { createServer } from "node:http";

export async function startFakeResponses(script) {
  const requests = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const body = JSON.parse(raw || "{}");
      const index = requests.length;
      requests.push({ body, headers: req.headers });
      let step;
      try {
        step = await script(body, index);
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: `script threw: ${err.message}` } }));
        return;
      }
      res.setHeader("content-type", "application/json");
      if (step?.status) {
        res.statusCode = step.status;
        if (step.retryAfter) res.setHeader("retry-after", String(step.retryAfter));
        res.end(JSON.stringify({ error: { message: step.message ?? "fake error" } }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({
        id: `resp_${++n}`,
        object: "response",
        status: "completed",
        model: body.model,
        output: step?.output ?? [],
        usage: step?.usage ?? { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 50 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let calls = 0;

/** A function_call output item; `async: true` marks an async tool call. */
export function call(name, args, { async: isAsync = false, id } = {}) {
  const callId = id ?? `call_${name}_${++calls}`;
  return {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
    ...(isAsync ? { async: true } : {}),
  };
}

export function message(text) {
  return { type: "message", id: `msg_${++calls}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

/** The function_call_output items in a request's input, parsed. */
export function outputsIn(body) {
  return (Array.isArray(body.input) ? body.input : [])
    .filter((item) => item?.type === "function_call_output")
    .map((item) => ({ call_id: item.call_id, output: JSON.parse(item.output) }));
}
