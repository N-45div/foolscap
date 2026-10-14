/**
 * Paying for foolscap: a 14-day trial, then a Polar licence key.
 *
 * The code is open source, and a build you make yourself is never gated.
 * The official builds (signed installer, auto-updates, the Store) are
 * what people pay for: $9 for the first 50 early buyers, then $19, for
 * the app forever; $99 for the app plus voice forever.
 *
 * A key is checked against Polar's customer-portal licence endpoints,
 * which take the organisation id and the key and need no secret, so
 * nothing private ships in the app. A key is activated once per computer
 * (Polar enforces the limit), checked again weekly, and keeps working
 * offline for 7 days after the last good check. We send the key, the
 * activation id and the computer's name, nothing else.
 *
 * Until app/main/polar.json is filled in, licensing is off entirely.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

const API = "https://api.polar.sh/v1/customer-portal/license-keys";
const DAY = 86_400_000;
export const TRIAL_DAYS = 14;
const GRACE_DAYS = 7;
const RECHECK_DAYS = 7;

const placeholder = (value) => typeof value !== "string" || !value.trim() || value.startsWith("[");

/** Polar's refusals, in words a buyer can act on. */
function readable(status, body) {
  const detail = typeof body?.detail === "string" ? body.detail : "";
  if (status === 404) return "That key was not found. Check it against your Polar receipt.";
  if (status === 403 && /limit/i.test(detail)) return "That key is already active on its maximum number of computers. Free one in your Polar customer portal.";
  if (status === 422) return "That does not look like a foolscap key.";
  return detail || `Polar answered ${status}.`;
}

export class Licence {
  constructor({ file, config, packaged, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.file = file;
    this.config = config ?? {};
    this.packaged = packaged;
    this.fetch = fetch;
    this.now = now;
    this.state = {}; // { firstRunAt, key, activationId, benefitId, status, lastValidatedAt, lastError }
    this.offline = false;
  }

  /** Licensing applies only to official builds with Polar configured. */
  get gated() {
    return Boolean(this.packaged) && !placeholder(this.config.organizationId);
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

  /** The plan a granted key unlocks; a key we cannot map still unlocks the app. */
  planFor(benefitId) {
    const plan = this.config.benefits?.[benefitId];
    return plan === "app+voice" ? "app+voice" : "app";
  }

  /** Does the key still count, given when it was last confirmed? */
  keyHolds() {
    const s = this.state;
    if (!s.key || s.status !== "granted" || !s.lastValidatedAt) return false;
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
      const plan = this.planFor(this.state.benefitId);
      return { ...base, plan, voice: plan === "app+voice", trialDaysLeft: null, lastValidatedAt: this.state.lastValidatedAt };
    }
    if (trialDaysLeft > 0) return { ...base, plan: "trial", voice: false, trialDaysLeft };
    return { ...base, plan: "expired", voice: false, trialDaysLeft: 0 };
  }

  /** May the person start new tasks? */
  allowed() {
    return this.status().plan !== "expired";
  }

  async call(path, body) {
    const res = await this.fetch(`${API}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization_id: this.config.organizationId, ...body }),
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

  /** Activate a key on this computer, then confirm it. */
  async activate(rawKey) {
    const key = String(rawKey ?? "").trim();
    if (!key) throw new Error("Paste the key from your Polar receipt.");
    if (!this.gated) throw new Error("This build is not gated: building foolscap yourself needs no key.");
    const activation = await this.call("activate", { key, label: hostname().slice(0, 100) });
    this.state = { ...this.state, key, activationId: activation.id ?? null, lastError: null };
    await this.validate({ force: true });
    if (this.state.status !== "granted") throw new Error(this.state.lastError ?? "That key is not active.");
    return this.status();
  }

  /** Re-check the key with Polar, at most weekly unless forced. */
  async validate({ force = false } = {}) {
    const s = this.state;
    if (!this.gated || !s.key) return this.status();
    if (!force && s.lastValidatedAt && this.now() - Date.parse(s.lastValidatedAt) < RECHECK_DAYS * DAY) return this.status();
    try {
      const data = await this.call("validate", { key: s.key, ...(s.activationId ? { activation_id: s.activationId } : {}) });
      this.offline = false;
      s.status = data.status ?? "granted";
      s.benefitId = data.benefit_id ?? data.license_key?.benefit_id ?? s.benefitId ?? null;
      s.lastValidatedAt = new Date(this.now()).toISOString();
      s.lastError = s.status === "granted" ? null : `This key is ${s.status}.`;
    } catch (err) {
      if (err.status) {
        // Polar answered: the key is not good any more.
        s.status = "revoked";
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
    if (s.key && s.activationId && this.gated) {
      await this.call("deactivate", { key: s.key, activation_id: s.activationId }).catch(() => {});
    }
    this.state = { firstRunAt: s.firstRunAt };
    await this.save();
    return this.status();
  }
}
