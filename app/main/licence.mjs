/**
 * Paying for foolscap: a 14-day trial, then a Dodo Payments licence key.
 *
 * The code is open source, and a build you make yourself is never gated.
 * The official installers are what people pay for: $9 for the first 50
 * early buyers, then $19, for the app forever; $99 for the app plus voice
 * forever; or the voice subscription, which includes the app while it runs.
 *
 * Keys are checked with Dodo's public licence endpoints (activate,
 * validate, deactivate), which need no API key, so nothing secret ships in
 * the app. Activating tells us which product the key belongs to, and so
 * the plan. A key is activated once per computer (Dodo enforces the
 * limit), checked again weekly, and keeps working offline for 7 days after
 * the last good check. We send the key, its instance id and the computer's
 * name, nothing else.
 *
 * Until app/main/dodo.json names the products, licensing is off entirely.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

const BASE = { live: "https://live.dodopayments.com", test: "https://test.dodopayments.com" };
const DAY = 86_400_000;
export const TRIAL_DAYS = 14;
const GRACE_DAYS = 7;
const RECHECK_DAYS = 7;
const PLANS = new Set(["app", "app+voice", "voice"]);

const placeholder = (value) => typeof value !== "string" || !value.trim() || value.startsWith("[");

/** Dodo's refusals, in words a buyer can act on. */
function readable(status, body) {
  const detail = typeof body?.message === "string" ? body.message : typeof body?.detail === "string" ? body.detail : "";
  if (status === 404) return "That key was not found. Check it against your email from Dodo Payments.";
  if (status === 403) return /limit|maximum/i.test(detail)
    ? "That key is already active on its maximum number of computers. Remove it from one first."
    : "That key is not active any more: it was refunded, cancelled or revoked.";
  if (status === 422 || status === 400) return "That does not look like a foolscap key.";
  return detail || `Dodo Payments answered ${status}.`;
}

export class Licence {
  constructor({ file, config, packaged, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.file = file;
    this.config = config ?? {};
    this.packaged = packaged;
    this.fetch = fetch;
    this.now = now;
    this.state = {}; // { firstRunAt, key, instanceId, licenseKeyId, productId, status, lastValidatedAt, lastError }
    this.offline = false;
  }

  /** The products dodo.json maps to plans, without the placeholders. */
  get products() {
    return Object.fromEntries(Object.entries(this.config.products ?? {}).filter(([id, plan]) => !placeholder(id) && PLANS.has(plan)));
  }

  /** Licensing applies only to official builds with Dodo products configured. */
  get gated() {
    return Boolean(this.packaged) && Object.keys(this.products).length > 0;
  }

  get base() {
    return BASE[this.config.mode === "test" ? "test" : "live"];
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      this.state = {};
    }
    if (!this.state.firstRunAt) {
      this.state.firstRunAt = new Date(this.now()).toISOString();
      await this.save();
    }
    return this.status();
  }

  async save() {
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2));
    await rename(temp, this.file);
  }

  /** The plan a key's product unlocks; a product we cannot map still unlocks the app. */
  planFor(productId) {
    return this.products[productId] ?? "app";
  }

  /** Does the key still count, given when it was last confirmed? */
  keyHolds() {
    const s = this.state;
    if (!s.key || s.status !== "active" || !s.lastValidatedAt) return false;
    return this.now() - Date.parse(s.lastValidatedAt) < (RECHECK_DAYS + GRACE_DAYS) * DAY;
  }

  status() {
    const links = Object.fromEntries(
      Object.entries(this.config.links ?? {}).map(([k, v]) => [k, placeholder(v) ? null : v]),
    );
    const trialEnds = Date.parse(this.state.firstRunAt ?? new Date(this.now()).toISOString()) + TRIAL_DAYS * DAY;
    const trialDaysLeft = Math.max(0, Math.ceil((trialEnds - this.now()) / DAY));
    const key = this.state.key ? `…${this.state.key.slice(-4)}` : null;
    const base = { gated: this.gated, key, links, lastError: this.state.lastError ?? null, offline: this.offline };
    if (!this.gated) return { ...base, plan: "source", voice: false, trialDaysLeft: null };
    if (this.keyHolds()) {
      const plan = this.planFor(this.state.productId);
      return { ...base, plan, voice: plan !== "app", trialDaysLeft: null, lastValidatedAt: this.state.lastValidatedAt };
    }
    if (trialDaysLeft > 0) return { ...base, plan: "trial", voice: false, trialDaysLeft };
    return { ...base, plan: "expired", voice: false, trialDaysLeft: 0 };
  }

  /** May the person start new tasks? */
  allowed() {
    return this.status().plan !== "expired";
  }

  async call(path, body) {
    const res = await this.fetch(`${this.base}/licenses/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // an empty or non-JSON answer
    }
    if (!res.ok) throw Object.assign(new Error(readable(res.status, data)), { status: res.status });
    return data ?? {};
  }

  /** Activate a key on this computer. Dodo answers with the key's product. */
  async activate(rawKey) {
    const key = String(rawKey ?? "").trim();
    if (!key) throw new Error("Paste the key from your email from Dodo Payments.");
    if (!this.gated) throw new Error("This build is not gated: building foolscap yourself needs no key.");
    const instance = await this.call("activate", { license_key: key, name: hostname().slice(0, 100) || "computer" });
    this.state = {
      ...this.state,
      key,
      instanceId: instance.id ?? null,
      licenseKeyId: instance.license_key_id ?? null,
      productId: instance.product?.product_id ?? null,
      status: "active",
      lastValidatedAt: new Date(this.now()).toISOString(),
      lastError: null,
    };
    this.offline = false;
    await this.save();
    return this.status();
  }

  /** Re-check the key with Dodo, at most weekly unless forced. */
  async validate({ force = false } = {}) {
    const s = this.state;
    if (!this.gated || !s.key) return this.status();
    if (!force && s.lastValidatedAt && this.now() - Date.parse(s.lastValidatedAt) < RECHECK_DAYS * DAY) return this.status();
    try {
      const data = await this.call("validate", { license_key: s.key, ...(s.instanceId ? { license_key_instance_id: s.instanceId } : {}) });
      this.offline = false;
      if (data.valid === true) {
        s.status = "active";
        s.lastValidatedAt = new Date(this.now()).toISOString();
        s.lastError = null;
      } else {
        s.status = "disabled";
        s.lastError = "This key is not active any more: it was refunded, cancelled or revoked.";
      }
    } catch (err) {
      if (err.status) {
        // Dodo answered: the key is not good any more.
        s.status = "disabled";
        s.lastError = err.message;
      } else {
        // No answer: keep the last good check until the grace period runs out.
        this.offline = true;
      }
    }
    await this.save();
    return this.status();
  }

  /** Free this computer's slot and forget the key here. */
  async deactivate() {
    const s = this.state;
    if (s.key && s.instanceId && this.gated) {
      await this.call("deactivate", { license_key: s.key, license_key_instance_id: s.instanceId }).catch(() => {});
    }
    this.state = { firstRunAt: s.firstRunAt };
    await this.save();
    return this.status();
  }
}
