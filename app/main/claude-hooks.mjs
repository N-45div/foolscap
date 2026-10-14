/**
 * Adding foolscap's hooks to the person's Claude Code settings, and
 * taking them out again.
 *
 * Nothing is written until the person has seen exactly what will be
 * added (plan()) and said yes. Their settings file is backed up first,
 * every other setting and hook is kept as it was, and foolscap's
 * entries are recognised by their URL path, so removing them never
 * touches anything else.
 */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MARK = "/hooks/claude";

/** The events foolscap listens to, and how long Claude Code waits for an answer. */
const EVENTS = {
  SessionStart: { timeout: 5 },
  UserPromptSubmit: { timeout: 5 },
  // A permission is held while the person decides; foolscap answers within 45 s.
  PermissionRequest: { timeout: 60, matcher: "*" },
  // Stop may run the repo's tests before sending a queued prompt.
  Stop: { timeout: 600 },
  SessionEnd: { timeout: 5 },
};

/** Claude Code's user settings file (honours CLAUDE_CONFIG_DIR). */
export function claudeSettingsFile(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

export const hookUrl = (port, token) => `http://127.0.0.1:${port}${MARK}?t=${token}`;

const ours = (hook) => typeof hook?.url === "string" && hook.url.includes(MARK);

/** The hooks block foolscap adds, as Claude Code expects it. */
export function foolscapHooks(url) {
  return Object.fromEntries(
    Object.entries(EVENTS).map(([event, { timeout, matcher }]) => [
      event,
      [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "http", url, timeout }] }],
    ]),
  );
}

/** Settings with foolscap's hooks taken out (and empty leftovers tidied). */
export function withoutOurs(settings) {
  const next = structuredClone(settings ?? {});
  for (const [event, groups] of Object.entries(next.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !ours(h)) }))
      .filter((group) => group.hooks.length);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

/** Settings with foolscap's hooks added (replacing any older foolscap entries). */
export function withOurs(settings, url) {
  const next = withoutOurs(settings);
  next.hooks ??= {};
  for (const [event, groups] of Object.entries(foolscapHooks(url))) {
    next.hooks[event] = [...(next.hooks[event] ?? []), ...groups];
  }
  return next;
}

async function readSettings(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON, so foolscap will not touch it`);
  }
}

/** Are foolscap's hooks in the settings file now? */
export async function installed(file = claudeSettingsFile()) {
  const settings = await readSettings(file).catch(() => ({}));
  return Object.values(settings.hooks ?? {}).some((groups) =>
    Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some(ours)));
}

/** What would be added, for the person to read before saying yes. */
export function plan(url, file = claudeSettingsFile()) {
  return { file, adds: { hooks: foolscapHooks(url) } };
}

async function save(file, settings) {
  await mkdir(dirname(file), { recursive: true });
  try {
    await copyFile(file, `${file}.foolscap-backup`);
  } catch {
    // no file yet: nothing to back up
  }
  const temp = `${file}.foolscap-tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temp, file);
}

export async function install(url, file = claudeSettingsFile()) {
  await save(file, withOurs(await readSettings(file), url));
}

export async function uninstall(file = claudeSettingsFile()) {
  await save(file, withoutOurs(await readSettings(file)));
}
