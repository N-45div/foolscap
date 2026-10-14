import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { testCommandFor } from "../server/verify.mjs";

const repo = (files) => ({
  exists: (p) => Object.keys(files).some((f) => join("/repo", f) === p),
  read: async (p) => {
    const hit = Object.keys(files).find((f) => join("/repo", f) === p);
    if (hit === undefined) throw new Error("ENOENT");
    return files[hit];
  },
});

test("a package.json test script runs through the lockfile's package manager", async () => {
  const pkg = JSON.stringify({ scripts: { test: "vitest run" } });
  assert.deepEqual(await testCommandFor("/repo", repo({ "package.json": pkg })), { line: "npm test", source: "package.json" });
  assert.equal((await testCommandFor("/repo", repo({ "package.json": pkg, "pnpm-lock.yaml": "" }))).line, "pnpm test");
  assert.equal((await testCommandFor("/repo", repo({ "package.json": pkg, "yarn.lock": "" }))).line, "yarn test");
  assert.equal((await testCommandFor("/repo", repo({ "package.json": pkg, "bun.lock": "" }))).line, "bun run test");
});

test("npm's placeholder test script is not a test command", async () => {
  const pkg = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
  assert.equal(await testCommandFor("/repo", repo({ "package.json": pkg })), null);
});

test(".foolscap.json wins over detection", async () => {
  const found = await testCommandFor("/repo", repo({ ".foolscap.json": '{"test":"make check"}', "Cargo.toml": "" }));
  assert.deepEqual(found, { line: "make check", source: ".foolscap.json" });
});

test("cargo, go and python projects are recognised; an empty folder has none", async () => {
  assert.equal((await testCommandFor("/repo", repo({ "Cargo.toml": "" }))).line, "cargo test");
  assert.equal((await testCommandFor("/repo", repo({ "go.mod": "" }))).line, "go test ./...");
  assert.equal((await testCommandFor("/repo", repo({ "pyproject.toml": "" }))).line, "python -m pytest -q");
  assert.equal(await testCommandFor("/repo", repo({})), null);
});
