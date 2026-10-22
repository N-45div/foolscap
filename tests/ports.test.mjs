import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { PortBlocks, portBusy, portEnv } from "../server/ports.mjs";

const listen = (host) =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, host, () => resolve(server));
  });
const close = (server) => new Promise((resolve) => server.close(resolve));

test("blocks step by ten from 4100 and come back when released", async () => {
  const blocks = new PortBlocks({ busy: async () => false });
  const a = await blocks.take();
  const b = await blocks.take();
  assert.deepEqual(a, { base: 4100, last: 4109 });
  assert.deepEqual(b, { base: 4110, last: 4119 });
  blocks.release(a);
  assert.deepEqual(await blocks.take(), { base: 4100, last: 4109 });
});

test("a block whose first port is in use is skipped", async () => {
  const blocks = new PortBlocks({ busy: async (port) => port === 4100 || port === 4110 });
  assert.deepEqual(await blocks.take(), { base: 4120, last: 4129 });
});

test("two tasks starting at once never get the same block", async () => {
  const blocks = new PortBlocks({ busy: () => new Promise((r) => setTimeout(() => r(false), 20)) });
  const [a, b, c] = await Promise.all([blocks.take(), blocks.take(), blocks.take()]);
  assert.deepEqual([a.base, b.base, c.base].sort(), [4100, 4110, 4120]);
});

test("portBusy sees a real listener on 127.0.0.1 and on ::1, and a free port as free", async () => {
  const v4 = await listen("127.0.0.1");
  const port4 = v4.address().port;
  assert.equal(await portBusy(port4), true);
  await close(v4);
  assert.equal(await portBusy(port4), false);

  let v6;
  try {
    v6 = await listen("::1");
  } catch {
    return; // no IPv6 loopback on this machine
  }
  assert.equal(await portBusy(v6.address().port), true);
  await close(v6);
});

test("portEnv gives the agent PORT and the whole block", () => {
  assert.deepEqual(portEnv({ base: 4110, last: 4119 }), { PORT: "4110", FOOLSCAP_PORTS: "4110-4119" });
  assert.deepEqual(portEnv(null), {});
});
