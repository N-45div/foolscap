import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Licence, TRIAL_DAYS } from "../app/main/licence.mjs";

const DAY = 86_400_000;
const config = {
  mode: "test",
  products: { pdt_app: "app", pdt_voice: "app+voice", pdt_sub: "voice", "[DODO PRODUCT ID OF FOOLSCAP]": "app" },
  links: { app: "https://example.invalid/buy", appVoice: "[DODO PAYMENT LINK FOR FOOLSCAP + VOICE]" },
};

/** A Dodo stand-in with the real response shapes: answers by path, records what it was sent. */
function dodo(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.split("/").pop();
    calls.push({ url, path, body: JSON.parse(init.body), headers: init.headers });
    const route = routes[path];
    if (route === "offline") throw new TypeError("fetch failed");
    const { status = 200, body = {} } = route ?? { status: 404, body: { message: "License key not found" } };
    return { ok: status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

const activated = (productId) => ({
  status: 201,
  body: { id: "lki_1", business_id: "bus_1", name: "pc", license_key_id: "lic_1", created_at: "2026-10-18T00:00:00Z", product: { product_id: productId, name: "foolscap" }, customer: { customer_id: "cus_1", name: "A", email: "a@example.invalid" } },
});

async function licence(opts) {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-licence-"));
  let clock = Date.parse("2026-10-15T00:00:00Z");
  const l = new Licence({ file: join(dir, "licence.json"), config, packaged: true, now: () => clock, ...opts });
  await l.load();
  return { l, advance: (days) => (clock += days * DAY) };
}

test("a build from source, or one without Dodo products set up, is never gated", async () => {
  const fromSource = await licence({ packaged: false });
  assert.equal(fromSource.l.status().plan, "source");
  const unconfigured = await licence({ config: { products: { "[DODO PRODUCT ID OF FOOLSCAP]": "app" } } });
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

test("activating a key unlocks the plan of the product Dodo names, and sends no more than it must", async () => {
  const { fetch, calls } = dodo({ activate: activated("pdt_voice") });
  const { l } = await licence({ fetch });
  const status = await l.activate("  FOOL-ABCD-1234  ");
  assert.equal(status.plan, "app+voice");
  assert.equal(status.voice, true);
  assert.equal(status.key, "…1234");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://test.dodopayments.com/licenses/activate");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["license_key", "name"]);
  assert.equal(calls[0].body.license_key, "FOOL-ABCD-1234");
  assert.equal(calls[0].headers.authorization, undefined, "the public endpoints need no API key");
  assert.deepEqual([l.state.instanceId, l.state.licenseKeyId, l.state.productId], ["lki_1", "lic_1", "pdt_voice"]);
});

test("the voice subscription includes the app while it runs, and live mode uses the live host", async () => {
  const { fetch, calls } = dodo({ activate: activated("pdt_sub") });
  const { l } = await licence({ fetch, config: { ...config, mode: "live" } });
  const status = await l.activate("SUB-KEY");
  assert.equal(status.plan, "voice");
  assert.equal(status.voice, true);
  assert.equal(l.allowed(), true);
  assert.equal(calls[0].url, "https://live.dodopayments.com/licenses/activate");
});

test("the weekly check sends the key and its instance; a key Dodo calls invalid stops unlocking", async () => {
  const routes = { activate: activated("pdt_app"), validate: { body: { valid: true } } };
  const { fetch, calls } = dodo(routes);
  const { l, advance } = await licence({ fetch });
  await l.activate("KEY-1");
  advance(8);
  await l.validate();
  assert.deepEqual(calls.at(-1).body, { license_key: "KEY-1", license_key_instance_id: "lki_1" });
  assert.equal(l.status().plan, "app");
  routes.validate = { body: { valid: false } };
  advance(8);
  await l.validate();
  assert.match(l.status().lastError, /refunded, cancelled or revoked/);
  advance(TRIAL_DAYS);
  assert.equal(l.status().plan, "expired");
});

test("offline, a good key keeps working for the grace period, then lapses", async () => {
  const routes = { activate: activated("pdt_app"), validate: "offline" };
  const { fetch } = dodo(routes);
  const { l, advance } = await licence({ fetch });
  await l.activate("KEY-1");
  advance(10);
  await l.validate();
  assert.equal(l.status().plan, "app");
  assert.equal(l.status().offline, true);
  advance(5);
  assert.equal(l.status().plan, "expired");
});

test("removing the key frees this computer's slot with Dodo and forgets it here", async () => {
  const routes = { activate: activated("pdt_app"), deactivate: { body: {} } };
  const { fetch, calls } = dodo(routes);
  const { l } = await licence({ fetch });
  await l.activate("KEY-1");
  await l.deactivate();
  assert.deepEqual(calls.at(-1).body, { license_key: "KEY-1", license_key_instance_id: "lki_1" });
  assert.equal(l.status().key, null);
  assert.equal(l.status().plan, "trial");
});

test("a key Dodo refuses reads as a sentence and does not unlock", async () => {
  const limit = dodo({ activate: { status: 403, body: { message: "License key activation limit reached" } } });
  const a = await licence({ fetch: limit.fetch });
  await assert.rejects(() => a.l.activate("KEY-1"), /maximum number of computers/);
  assert.equal(a.l.status().plan, "trial");
  const missing = dodo({});
  const b = await licence({ fetch: missing.fetch });
  await assert.rejects(() => b.l.activate("NOPE"), /not found/);
});

test("placeholder products and links are ignored", async () => {
  const { l } = await licence();
  assert.equal(l.status().links.app, "https://example.invalid/buy");
  assert.equal(l.status().links.appVoice, null);
  assert.equal(Object.keys(l.products).includes("[DODO PRODUCT ID OF FOOLSCAP]"), false);
});
