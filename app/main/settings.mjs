/**
 * The person's settings, one JSON file in the app's data folder.
 *
 * Writes go through a temp file and a rename so a crash mid-write never
 * leaves half a file, and are queued so two saves never interleave. A
 * file that will not parse is set aside rather than overwritten, so a
 * hand edit gone wrong is never silently lost.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename } from "node:path";

export const DEFAULTS = {
  repos: [], // [{ path, name }]
  defaultAgent: "claude",
  // Start Claude Code with the person's own settings and CLAUDE.md. Off
  // runs it with --setting-sources project,local.
  useMySettings: true,
  codexModel: null, // null: whatever ~/.codex/config.toml says
  openAtLogin: true,
  notify: true,
  theme: "system", // system | dark | light
  shortcut: "CommandOrControl+Shift+Space",
  // Claude Code sessions started in a terminal show up too (hooks).
  terminalSessions: false,
  hookPort: 47821,
  hookToken: null,
  // The pill: a small live capsule above the taskbar, and where it was dragged to.
  pill: true,
  pillPosition: null,
};

export class Settings {
  constructor(file) {
    this.file = file;
    this.value = { ...DEFAULTS };
    this.writing = Promise.resolve();
  }

  async load() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return this.value; // first run
    }
    try {
      this.value = { ...DEFAULTS, ...JSON.parse(text) };
    } catch {
      await rename(this.file, `${this.file}.broken-${Date.now()}`).catch(() => {});
    }
    return this.value;
  }

  get() {
    return this.value;
  }

  /** Merge a patch and save. Unknown keys are ignored. */
  set(patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULTS) this.value[key] = value;
    }
    return this.save();
  }

  /** Remember a repo folder, most recent first, without duplicates. */
  addRepo(path) {
    const repos = this.value.repos.filter((r) => r.path.toLowerCase() !== path.toLowerCase());
    this.value.repos = [{ path, name: basename(path) || path }, ...repos].slice(0, 30);
    return this.save();
  }

  save() {
    const text = JSON.stringify(this.value, null, 2);
    const temp = `${this.file}.tmp`;
    this.writing = this.writing
      .then(() => writeFile(temp, text))
      .then(() => rename(temp, this.file))
      .catch(() => {});
    return this.writing.then(() => this.value);
  }
}
