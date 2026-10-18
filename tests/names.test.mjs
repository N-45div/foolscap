/**
 * What the person reads about a task: its name, the files a permission
 * names, and the merge commit's subject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeIn, titleOf } from "../server/claude-stream.mjs";
import { clip, nameFromPrompt } from "../server/fleet.mjs";

const win = process.platform === "win32";

test("a permission names a file from the task's folder, and anything outside it in full", () => {
  const cwd = win ? "C:\\Users\\x\\wt\\abc" : "/home/x/wt/abc";
  const inside = win ? "C:\\Users\\x\\wt\\abc\\src\\math.mjs" : "/home/x/wt/abc/src/math.mjs";
  const outside = win ? "D:\\other\\notes.txt" : "/etc/hosts";
  assert.equal(titleOf("Edit", { file_path: inside }, cwd), "Edit src/math.mjs");
  assert.equal(titleOf("Write", { file_path: outside }, cwd), `Write ${outside}`);
  assert.equal(relativeIn(null, inside), inside);
  assert.equal(titleOf("Edit", { file_path: inside }), `Edit ${inside}`, "no folder, no change");
});

test("a task is named from its first sentence, on a whole word", () => {
  assert.equal(nameFromPrompt("Fix add() in src/math.mjs so npm test passes. Work only inside this folder."), "Fix add() in src/math.mjs so…");
  assert.equal(nameFromPrompt("\n  Refactor the queue\nand more"), "Refactor the queue");
  assert.equal(nameFromPrompt("   "), null);
  assert.equal(nameFromPrompt(undefined), null);
});

test("a merge subject stays within 72 characters and never ends mid-word", () => {
  const long = "Claude Code: Fix add() in src/math.mjs so npm test passes. Work only inside this folder.";
  const subject = clip(long, 72);
  assert.ok(subject.length <= 72);
  assert.equal(subject, "Claude Code: Fix add() in src/math.mjs so npm test passes. Work only…");
  assert.equal(clip("short", 72), "short");
});
