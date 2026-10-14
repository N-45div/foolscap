import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Licence, TRIAL_DAYS } from "../app/main/licence.mjs";

const DAY = 86_400_000;
const config = {
  organizationId: "org_123",
  benefits: { ben_app: "app", ben_voice: "app+voice" },
  links: { app: "https://example.invalid/buy", appVoice: "[POLAR CHECKOUT LINK FOR FOOLSCAP + VOICE]" },
};

/** A Polar stand-in: answers by path, records what it was sent. */
function polar(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.split("/").pop();
    calls.push({ path, body: JSON.parse(init.body) });
    const route = routes[path];
    if (route === "offline") throw new TypeError("fetch failed");
    const { status = 200, body = {} } = route ?? { status: 404, body: { detail: "Not found" } };
    return { ok: status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

async function licence(opts) {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-licence-"));
  let clock = Date.parse("2026-10-15T00:00:00Z");
  const l = new Licence({ file: join(dir, "licence.json"), config, packaged: true, now: () => clock, ...opts });
  await l.load();
  return { l, advance: (days) => (clock += days * DAY) };
}

test("a build from source, or one without Polar set up, is never gated", async () => {
  const fromSource = await licence({ packaged: false });
  assert.equal(fromSource.l.status().plan, "source");
  const unconfigured = await licence({ config: { organizationId: "[YOUR POLAR ORGANIZATION ID]" } });
  assert.equal(unconfigured.l.status().plan, "source");
  assert.equal(unconfigured.l.allowed(), true);
});

test("the trial runs 14 days, then new tasks need a key", async () => {
  const { l, advance } = await licence();
  assert.deepEqual([l.status().plan, l.status().trialDaysLeft], ["trial", TRIAL_DAYS]);
  advance(TRIAL_DAYS);
  assert.equal(l.status().plan, "expired");
  assert.equal(l.allowed(), false);
});

test("an activated key unlocks the plan its product grants, and sends no more than it must", async () => {
  const { fetch, calls } = polar({
    activate: { body: { id: "act_1" } },
    validate: { body: { status: "granted", benefit_id: "ben_voice" } },
  });
  const { l } = await licence({ fetch });
  const status = await l.activate("  FOOL-ABCD-1234  ");
  assert.equal(status.plan, "app+voice");
  assert.equal(status.voice, true);
  assert.equal(status.key, "…1234");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["key", "label", "organization_id"]);
  assert.deepEqual(calls[1].body, { organization_id: "org_123", key: "FOOL-ABCD-1234", activation_id: "act_1" });
});

test("offline, a good key keeps working for the grace period, then lapses", async () => {
  const routes = { activate: { body: { id: "act_1" } }, validate: { body: { status: "granted", benefit_id: "ben_app" } } };
  const { fetch } = polar(routes);
  const { l, advance } = await licence({ fetch });
  await l.activate("KEY-1");
  routes.validate = "offline";
  advance(10);
  await l.validate();
  assert.equal(l.status().plan, "app");
  assert.equal(l.status().offline, true);
  advance(5);
  assert.equal(l.status().plan, "expired");
});

test("a key Polar refuses reads as a sentence and does not unlock", async () => {
  const { fetch } = polar({ activate: { status: 403, body: { detail: "License key activation limit reached" } } });
  const { l } = await licence({ fetch });
  await assert.rejects(() => l.activate("KEY-1"), /maximum number of computers/);
  assert.equal(l.status().plan, "trial");
});

test("placeholder links are not offered", async () => {
  const { l } = await licence();
  assert.equal(l.status().links.app, "https://example.invalid/buy");
  assert.equal(l.status().links.appVoice, null);
});
