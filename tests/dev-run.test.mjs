import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevRun, localUrlIn, runCommandFor, withPort } from "../server/dev-run.mjs";
import { portBusy } from "../server/ports.mjs";

const fakeFs = (files) => ({
  exists: (p) => Object.keys(files).some((k) => p.endsWith(k)),
  read: async (p) => {
    const hit = Object.keys(files).find((k) => p.endsWith(k));
    if (!hit) throw new Error("ENOENT");
    return files[hit];
  },
});
const until = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the run command comes from .foolscap.json, else the dev or start script", async () => {
  assert.deepEqual(await runCommandFor("/r", fakeFs({ ".foolscap.json": '{"run": "make serve"}', "package.json": '{"scripts":{"dev":"vite"}}' })), { line: "make serve", source: ".foolscap.json" });
  assert.deepEqual(await runCommandFor("/r", fakeFs({ "package.json": '{"scripts":{"dev":"vite","start":"node ."}}', "pnpm-lock.yaml": "" })), { line: "pnpm run dev", source: "package.json" });
  assert.deepEqual(await runCommandFor("/r", fakeFs({ "package.json": '{"scripts":{"start":"node ."}}', "bun.lock": "" })), { line: "bun run start", source: "package.json" });
  assert.equal(await runCommandFor("/r", fakeFs({ "package.json": '{"scripts":{"test":"node --test"}}' })), null);
  assert.equal(await runCommandFor("/r", fakeFs({})), null);
});

test("$PORT, ${PORT} and %PORT% become the task's port", () => {
  assert.equal(withPort("vite --port $PORT", 4110), "vite --port 4110");
  assert.equal(withPort("serve -l ${PORT} && echo %PORT%", 4110), "serve -l 4110 && echo 4110");
  assert.equal(withPort("echo $PORTAL", 4110), "echo $PORTAL");
  assert.equal(withPort("vite", null), "vite");
});

test("the preview link is the first local URL a server prints, colours and all", () => {
  assert.equal(localUrlIn("  VITE v6.3.5  ready\n  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n"), "http://localhost:5173/");
  assert.equal(localUrlIn("   ▲ Next.js 15.5.0\n   - Local:        http://localhost:4110\n   - Network:      http://192.168.1.4:4110"), "http://localhost:4110");
  assert.equal(localUrlIn("Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)"), "http://localhost:8000");
  assert.equal(localUrlIn("listening on 192.168.1.4:3000"), null);
});

test("Run starts the repo's server on the task's port, finds its URL, and Stop ends the whole tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-run-"));
  const port = await freePort();
  // A server that starts a child of its own, as dev servers do.
  await writeFile(join(dir, "server.js"), `
    const { spawn } = require("node:child_process");
    const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    require("node:fs").writeFileSync("kid.pid", String(kid.pid));
    require("node:http").createServer((q, s) => s.end("ok")).listen(Number(process.argv[2]), "127.0.0.1", () => {
      console.log("\\x1b[36mready at http://localhost:" + process.argv[2] + "/\\x1b[39m");
    });
  `);
  await writeFile(join(dir, ".foolscap.json"), JSON.stringify({ run: "node server.js $PORT" }));
  const run = new DevRun({ cwd: dir, port });
  await run.start();
  await until(() => run.status === "running");
  assert.equal(run.snapshot().url, `http://localhost:${port}/`);
  assert.equal(run.snapshot().line, `node server.js ${port}`);
  const kid = Number(await readFile(join(dir, "kid.pid"), "utf8"));
  assert.equal(alive(kid), true);

  await run.stop();
  assert.equal(run.status, "stopped");
  await until(() => !alive(kid), 5_000);
  assert.equal(await portBusy(port), false);
});

test("a server that prints nothing is found by its port answering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-run-"));
  const port = await freePort();
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node quiet.js" } }));
  await writeFile(join(dir, "quiet.js"), `require("node:http").createServer((q, s) => s.end()).listen(Number(process.env.PORT), "127.0.0.1");`);
  const run = new DevRun({ cwd: dir, port, pollMs: 100 });
  await run.start();
  await until(() => run.status === "running");
  assert.equal(run.url, `http://localhost:${port}`);
  await run.stop();
});

test("a server that dies says so, with its exit code; nothing to run is a plain error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-run-"));
  await writeFile(join(dir, ".foolscap.json"), JSON.stringify({ run: "node -e \"process.exit(3)\"" }));
  const run = new DevRun({ cwd: dir, port: await freePort() });
  await run.start();
  await until(() => run.status === "failed");
  assert.equal(run.exitCode, 3);
  assert.match(run.error, /exited with code 3/);

  const empty = new DevRun({ cwd: await mkdtemp(join(tmpdir(), "foolscap-run-")) });
  await assert.rejects(empty.start(), /nothing to run/);
});
