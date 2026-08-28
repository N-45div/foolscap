/**
 * ACP over the network — the missing transport.
 *
 * The Agent Client Protocol standardizes the client↔harness boundary
 * (permissions, file edits, terminals, streaming), but every client
 * today spawns its agent as a *local subprocess* over stdio: the
 * HTTP/WebSocket transport is still unspecified. So an agent can only
 * be driven from the machine it runs on.
 *
 * This bridge closes that gap without inventing a dialect:
 *
 *   remote client ──WebSocket(+token)──▶ foolscap ──stdio──▶ acp agent
 *                                            │
 *                                            └──▶ recorded to the archive
 *
 * One WebSocket text frame carries exactly one JSON-RPC message; stdio
 * carries the same messages newline-delimited. The mapping is therefore
 * lossless and *semantically transparent* — we relay frames rather than
 * interpreting them, so new methods and future spec revisions pass
 * through untouched. Whatever ACP adds next, this keeps working.
 *
 * Security posture, because this is an endpoint that runs code:
 *   - a bearer token is REQUIRED, always, and generated per run;
 *   - loopback binding is the default, exposing publicly takes a flag;
 *   - one agent process per connection, killed when the socket closes;
 *   - the token is never written into the recording.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

/** Where recorded remote sessions land — a first-class archive source. */
export const acpArchiveDir = () => join(homedir(), ".foolscap", "acp");

/** Agents that speak ACP over stdio, by short name. */
export const AGENTS = {
  claude: {
    label: "claude code",
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
  },
  codex: {
    label: "codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
  },
  gemini: {
    label: "gemini cli",
    command: "gemini",
    args: ["--experimental-acp"],
  },
};

export const newToken = () => randomBytes(24).toString("base64url");

/** Constant-time compare that tolerates length mismatch. */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Launch an ACP agent as a child process.
 *
 * Windows needs care: the agents ship as `.cmd` shims, which Node
 * refuses to spawn without a shell — but handing a shell a *separate*
 * args array concatenates them unescaped (Node's DEP0190). So on
 * Windows we build one command string and quote every argument
 * ourselves; everywhere else we spawn directly with no shell at all.
 */
function spawnAgent(spec, cwd) {
  const stdio = ["pipe", "pipe", "pipe"];
  if (process.platform !== "win32") {
    return spawn(spec.command, spec.args, { cwd, stdio });
  }
  const quote = (a) => `"${String(a).replaceAll('"', '\\"')}"`;
  const line = [spec.command, ...spec.args.map(quote)].join(" ");
  return spawn(line, { cwd, stdio, shell: true, windowsHide: true });
}

/**
 * A recorder writes one line per JSON-RPC frame, plus a header. It is
 * append-only and never blocks the relay: a failed write loses the
 * recording, never the session.
 */
class Recorder {
  constructor(file, header) {
    this.file = file;
    this.queue = appendFile(file, JSON.stringify(header) + "\n").catch(
      () => {},
    );
  }
  frame(dir, msg) {
    const line =
      JSON.stringify({ t: new Date().toISOString(), dir, msg }) + "\n";
    // Serialize appends so frames keep their order on disk.
    this.queue = this.queue.then(() =>
      appendFile(this.file, line).catch(() => {}),
    );
  }
}

/**
 * Start the bridge.
 *
 * @param {object} opts
 * @param {string} opts.agent        key of AGENTS, or a raw command line
 * @param {number} opts.port
 * @param {string} opts.host         defaults to loopback
 * @param {string} opts.token
 * @param {string} opts.cwd          working directory for the agent
 * @param {boolean} opts.record      write sessions into the archive
 * @param {string} [opts.recordDir]  where transcripts go (default: archive)
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startAcpBridge(opts) {
  const {
    agent = "claude",
    port = 4518,
    host = "127.0.0.1",
    token,
    cwd = process.cwd(),
    record = true,
    recordDir = acpArchiveDir(),
    log = () => {},
  } = opts;

  if (!token) throw new Error("a token is required — refusing to start open");

  const spec = AGENTS[agent] ?? {
    label: agent,
    command: agent.split(" ")[0],
    args: agent.split(" ").slice(1),
  };

  if (record) await mkdir(recordDir, { recursive: true });

  const http = createServer((req, res) => {
    // A tiny health endpoint so a client can check the door before
    // committing to a socket. It never reveals the token.
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: spec.label, protocol: "acp" }));
      return;
    }
    res.writeHead(404).end("foolscap acp bridge — connect over websocket");
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    // Auth happens before the socket is accepted: an unauthenticated
    // peer never reaches the agent, and never causes a spawn.
    const url = new URL(req.url ?? "/", "http://localhost");
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const given = bearer || url.searchParams.get("token");
    if (!tokenMatches(given, token)) {
      log("rejected an unauthenticated connection");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const started = new Date();
    const id = randomBytes(8).toString("hex");
    log(`session ${id} opened — spawning ${spec.label}`);

    const child = spawnAgent(spec, cwd);

    const recorder = record
      ? new Recorder(join(recordDir, `${id}.jsonl`), {
          type: "foolscap-acp",
          version: 1,
          id,
          agent: spec.label,
          command: [spec.command, ...spec.args].join(" "),
          cwd,
          startedAt: started.toISOString(),
        })
      : null;

    // Both directions carry JSON-RPC and nothing else. Parsing is how we
    // know that — never conditional on recording being on, or an agent
    // that prints a banner would have it relayed as protocol.
    const parseFrame = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    // ── client → agent ──────────────────────────────────────────────
    ws.on("message", (data) => {
      const text = data.toString("utf8").trim();
      if (!text) return;
      const msg = parseFrame(text);
      if (!msg) {
        log(`session ${id}: dropped a non-JSON frame from the client`);
        return;
      }
      recorder?.frame("c2a", msg);
      child.stdin.write(text + "\n");
    });

    // ── agent → client ──────────────────────────────────────────────
    // stdio is newline-delimited JSON; a single read can straddle
    // messages, so buffer until a newline lands.
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let nl;
      while ((nl = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        const msg = parseFrame(line);
        if (!msg) {
          // Agents print banners and warnings on stdout; that is noise,
          // not protocol, and must never reach the client.
          log(`session ${id}: dropped non-JSON agent output`);
          continue;
        }
        recorder?.frame("a2c", msg);
        if (ws.readyState === ws.OPEN) ws.send(line);
      }
    });

    // The agent's stderr is diagnostics, not protocol: surface it to the
    // operator, never to the wire.
    child.stderr.on("data", (c) => log(`[${spec.label}] ${c.toString().trim()}`));

    const shutdown = (why) => {
      log(`session ${id} closed (${why})`);
      child.kill();
      if (ws.readyState === ws.OPEN) ws.close();
    };
    child.on("exit", (code) => shutdown(`agent exited ${code}`));
    child.on("error", (err) => {
      log(`could not start ${spec.command}: ${err.message}`);
      shutdown("spawn failed");
    });
    ws.on("close", () => shutdown("client disconnected"));
    ws.on("error", () => shutdown("socket error"));
  });

  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });

  return {
    port: http.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        http.close(() => resolve());
      }),
  };
}
