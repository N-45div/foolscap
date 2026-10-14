/**
 * What happened, kept as an append-only log on this computer.
 *
 * Each line is one event: a task started, a turn ended (with foolscap's
 * own test verdict and how long it took), a queued prompt went out or
 * was held, a task was merged, a permission was answered. The digest
 * and the "today" line are computed from it, so every number shown can
 * be traced back to lines in a file. No prompts or code are stored,
 * only task names, outcomes and times.
 */
import { appendFile, readFile } from "node:fs/promises";

const KEEP_DAYS = 30;

export class Journal {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.events = [];
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const cutoff = this.now() - KEEP_DAYS * 86_400_000;
      this.events = (await readFile(this.file, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((e) => e && Date.parse(e.at) >= cutoff);
    } catch {
      this.events = [];
    }
    return this;
  }

  add(event) {
    const entry = { at: new Date(this.now()).toISOString(), ...event };
    this.events.push(entry);
    const line = `${JSON.stringify(entry)}\n`;
    // One bad write must never poison the ones after it.
    this.writing = this.writing.then(() => appendFile(this.file, line)).catch(() => {});
    return entry;
  }

  since(iso) {
    const from = Date.parse(iso);
    return this.events.filter((e) => Date.parse(e.at) >= from);
  }
}

/** Summarise a stretch of events. Counts only what the log shows. */
export function digest(events) {
  const turns = events.filter((e) => e.type === "turn");
  const red = turns.filter((e) => e.verdict === "red");
  return {
    green: turns.filter((e) => e.verdict === "green").length,
    red: red.length,
    redNames: [...new Set(red.map((e) => e.name))].slice(0, 3),
    errors: turns.filter((e) => e.stopReason === "error").length,
    queueSent: events.filter((e) => e.type === "queue-sent").length,
    held: events.filter((e) => e.type === "held").length,
    merged: events.filter((e) => e.type === "merged").length,
    answeredFromNotifications: events.filter((e) => e.type === "answered" && e.from === "notification").length,
    agentMs: turns.reduce((sum, e) => sum + (Number(e.ms) || 0), 0),
  };
}

/** The events of the local calendar day. */
export function today(events, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return events.filter((e) => Date.parse(e.at) >= start.getTime());
}
