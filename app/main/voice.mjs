/**
 * Voice: the main process's side of a dictation.
 *
 * The page records and cuts the audio; this sends it to foolscap Cloud,
 * which checks the licence and the word allowance, has the speech
 * transcribed and written up as a clean prompt, and counts the words.
 * The app speaks only to foolscap Cloud. Requests carry the licence key
 * and this computer's activation id, nothing else; audio is sent once
 * and never stored on this computer.
 */

const placeholder = (value) => typeof value !== "string" || !value.trim() || value.startsWith("[");

/** Cloud refusals, in words the person can act on. */
function readable(status, body) {
  const message = typeof body?.error === "string" ? body.error : "";
  if (status === 402) return message || "You've used this period's voice words. foolscap + Voice gives you more.";
  if (status === 401 || status === 403) return message || "Voice needs an active foolscap licence key.";
  if (status === 429) return "Too many dictations at once. Try again in a moment.";
  return message || `foolscap Cloud answered ${status}.`;
}

export class VoiceClient {
  constructor({ config, licence, fetch = globalThis.fetch }) {
    this.url = placeholder(config?.voiceUrl) ? null : config.voiceUrl.replace(/\/$/, "");
    this.licence = licence;
    this.fetch = fetch;
  }

  /** Can this computer dictate, and if not, why not? */
  status() {
    if (!this.url) return { available: false, reason: "Voice isn't set up in this build yet." };
    const key = this.licence.state?.key;
    if (!key) return { available: false, reason: "Voice comes with a foolscap licence: 2,000 free words a week." };
    return { available: true, reason: null };
  }

  headers(extra = {}) {
    const { key, instanceId, licenseKeyId } = this.licence.state ?? {};
    return {
      "x-foolscap-key": key,
      ...(instanceId ? { "x-foolscap-activation": instanceId } : {}),
      ...(licenseKeyId ? { "x-foolscap-license": licenseKeyId } : {}),
      ...extra,
    };
  }

  async call(path, init) {
    const { available, reason } = this.status();
    if (!available) throw new Error(reason);
    let res;
    try {
      res = await this.fetch(`${this.url}${path}`, init);
    } catch {
      throw new Error("Could not reach foolscap Cloud. Check your connection.");
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // no JSON
    }
    if (!res.ok) throw new Error(readable(res.status, body));
    return body ?? {};
  }

  start() {
    return this.call("/v1/voice/sessions", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ language: "auto", app: { name: "foolscap", category: "agent" } }),
    });
  }

  part(id, index, wav) {
    return this.call(`/v1/voice/sessions/${encodeURIComponent(id)}/parts/${Number(index)}`, {
      method: "POST",
      headers: this.headers({ "content-type": "audio/wav" }),
      body: Buffer.from(wav),
    });
  }

  finish(id, body) {
    return this.call(`/v1/voice/sessions/${encodeURIComponent(id)}/finish`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ ...body, style: "prompt", app: { name: "foolscap", category: "agent" } }),
    });
  }
}
