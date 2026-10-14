import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookUrl, install, installed, uninstall, withOurs, withoutOurs } from "../app/main/claude-hooks.mjs";

const url = hookUrl(47821, "tok");
const theirs = {
  model: "opus",
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
  },
};

test("adding keeps every existing setting and hook", () => {
  const next = withOurs(theirs, url);
  assert.equal(next.model, "opus");
  assert.equal(next.hooks.Stop.length, 2);
  assert.deepEqual(next.hooks.PreToolUse, theirs.hooks.PreToolUse);
  assert.equal(next.hooks.PermissionRequest[0].matcher, "*");
  assert.equal(next.hooks.PermissionRequest[0].hooks[0].url, url);
});

test("adding twice does not duplicate, and removing restores the original", () => {
  const twice = withOurs(withOurs(theirs, url), hookUrl(47821, "new"));
  assert.equal(twice.hooks.Stop.length, 2);
  assert.deepEqual(withoutOurs(twice), theirs);
});

test("install backs the file up; uninstall takes only foolscap's hooks out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-claude-"));
  const file = join(dir, "settings.json");
  await writeFile(file, JSON.stringify(theirs));
  await install(url, file);
  assert.equal(await installed(file), true);
  assert.deepEqual(JSON.parse(await readFile(`${file}.foolscap-backup`, "utf8")), theirs);
  await uninstall(file);
  assert.equal(await installed(file), false);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), theirs);
});

test("a settings file that is not JSON is never overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-claude-"));
  const file = join(dir, "settings.json");
  await writeFile(file, "{ broken");
  await assert.rejects(() => install(url, file), /not valid JSON/);
  assert.equal(await readFile(file, "utf8"), "{ broken");
});
