/**
 * Fleet driver: Devin, in the cloud.
 *
 * Devin has no process to spawn and no tool stream to read. It has a
 * session API: create a session with a prompt, send follow-up messages,
 * and poll the session for its status and messages. So this driver is
 * an HTTP poller — and the fleet's queue works unchanged, because
 * Devin's `status_enum` already says the one thing we care about:
 * `blocked` means Devin is waiting on you.
 *
 * Devin blocks on *questions*, not allow/deny, so its permission
 * requests carry `answer: "text"` and the queue's card shows a reply
 * box instead of buttons. Your answer goes back as a session message.
 *
 * Auth: DEVIN_API_KEY (apk_user_… or apk_…). FOOLSCAP_DEVIN_URL and
 * FOOLSCAP_DEVIN_POLL_MS exist for tests and self-hosted proxies.
 * There is no cancel in the API; cancelling a turn stops foolscap
 * watching it — the cloud session carries on, and the log says so.
 */

const BASE = () => (process.env.FOOLSCAP_DEVIN_URL ?? "https://api.devin.ai/v1").replace(/\/$/, "");
const POLL_MS = () => Number(process.env.FOOLSCAP_DEVIN_POLL_MS ?? 3000);
const RESUME_GRACE_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDevinDriver({ name, log, onFrame, onPermission }) {
  const key = process.env.DEVIN_API_KEY;
  const driver = { kind: "devin", sessionId: null, url: null };
  let turn = null; // { resolve, reject }
  let polling = false;
  let closed = false;
  let lastStatus = null;
  let resumeDeadline = 0; // after a follow-up, ignore a stale "finished" until this
  const seen = new Set();

  async function api(path, init = {}) {
    const r = await fetch(BASE() + path, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`devin ${init.method ?? "GET"} ${path} → ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    if (r.status === 204) return {};
    return r.json().catch(() => ({}));
  }

  const endTurn = (result) => {
    const t = turn;
    turn = null;
    t?.resolve(result);
  };

  async function observe() {
    const s = await api(`/sessions/${driver.sessionId}`);
    const messages = Array.isArray(s.messages) ? s.messages : [];
    for (const m of messages) {
      const id = m.event_id ?? `${m.timestamp}|${m.message}`;
      if (seen.has(id)) continue;
      seen.add(id);
      onFrame("a2c", {
        type: "devin/message",
        kind: m.type,
        message: m.message,
        at: m.timestamp,
        username: m.username ?? null,
      });
    }

    const st = s.status_enum ?? s.status ?? null;
    const settled = st === "finished" || st === "expired";
    if (settled && Date.now() < resumeDeadline) return; // Devin hasn't picked the follow-up up yet
    if (st === lastStatus) return;
    lastStatus = st;

    const lastDevin = [...messages].reverse().find((m) => /devin/i.test(String(m.type ?? "")));
    onFrame("a2c", {
      type: "devin/status",
      status_enum: st,
      question: st === "blocked" ? (lastDevin?.message ?? null) : undefined,
      pull_request: s.pull_request ?? null,
      structured_output: s.structured_output ?? null,
      title: s.title ?? null,
    });

    if (st === "blocked") {
      const requestId = `q-${Date.now().toString(36)}`;
      onPermission({
        requestId,
        toolCall: {
          toolCallId: requestId,
          title: (lastDevin?.message ?? "Devin has a question").slice(0, 300),
          kind: "question",
        },
        options: [],
        answer: "text",
      });
    } else if (settled) {
      endTurn({ stopReason: st === "finished" ? "end_turn" : "expired" });
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      while (!closed && turn) {
        await observe();
        if (!turn) break;
        await sleep(POLL_MS());
      }
    } catch (err) {
      log(`devin: ${err.message}`);
      const t = turn;
      turn = null;
      t?.reject(err);
    } finally {
      polling = false;
    }
  }

  driver.start = async () => {
    if (!key) {
      throw new Error("DEVIN_API_KEY is not set — the Devin driver needs an API key (apk_user_… or apk_…)");
    }
  };

  driver.prompt = (text) =>
    new Promise((resolve, reject) => {
      turn = { resolve, reject };
      (async () => {
        onFrame("c2a", { type: "devin/prompt", text });
        if (!driver.sessionId) {
          const r = await api("/sessions", {
            method: "POST",
            body: JSON.stringify({ prompt: text, title: name, unlisted: true }),
          });
          driver.sessionId = r.session_id;
          driver.url = r.url ?? null;
          onFrame("a2c", { type: "devin/session", session_id: r.session_id, url: r.url ?? null });
        } else {
          await api(`/sessions/${driver.sessionId}/message`, {
            method: "POST",
            body: JSON.stringify({ message: text }),
          });
          lastStatus = null;
          resumeDeadline = Date.now() + RESUME_GRACE_MS;
        }
        poll();
      })().catch((err) => {
        turn = null;
        reject(err);
      });
    });

  driver.answerPermission = (requestId, optionId, text) => {
    onFrame("c2a", { type: "devin/answer", text });
    lastStatus = null;
    api(`/sessions/${driver.sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ message: text }),
    }).catch((err) => log(`devin: could not send the answer: ${err.message}`));
  };

  driver.cancel = () => {
    if (turn) {
      log("devin: stopped watching this turn — the cloud session keeps running");
      endTurn({ stopReason: "cancelled" });
    }
  };

  driver.close = () => {
    closed = true;
    if (turn) endTurn({ stopReason: "cancelled" });
  };

  return driver;
}
