# Contributing to foolscap

Thanks for being here. foolscap is small on purpose — a few files that
matter, plain Node on the server, no build step to run the CLI — so most
contributions are an afternoon, not a week. This page tells you where
things are and what a good change looks like.

## The two things people most want to add

### A harness (so its sessions show up in the archive)

Every harness is one adapter that maps its on-disk log format into the
neutral `SessionDoc`. The renderer, exporter, shelf and outcome judge
never learn which tool wrote a session.

1. **`src/sources/<name>.ts`** — implement `parse(raw: string): SessionDoc`.
   Prompts become cells; tool invocations become `ToolInteraction`s
   (pair calls with results by id); reasoning becomes `thinking` parts.
   If the tool names its edit inputs differently, map them to
   `file_path` / `old_string` / `new_string` so diffs render.
   **Be tolerant**: never throw on a malformed line — count it and move on.
2. **Register it** in `src/sources/index.ts` (id + label + parser) and in
   the `SOURCES` map at the top of `cli.ts`.
3. **Discovery** in `server/core.mjs`: a `scan<Name>(root)` that finds the
   sessions and groups them into projects, a root in `resolveRoots()`
   (respect the tool's own env override if it has one), and the root in
   `allowed()`. If sessions aren't files — OpenCode keeps SQLite — look
   at `server/opencode.mjs` for the reference-and-expand pattern.
4. **The shelf and the judge**: add a segmenter to `server/outcome.mjs`
   so prompts and evidence come out of it too. `dshSegments` is the
   smallest example.
5. **A test** in `tests/<name>.test.mjs` against a **synthetic** fixture.

### A driver (so the fleet can run it)

Drivers own transport and nothing else. One file in `server/drivers/`
implementing `start / prompt / answerPermission / cancel / close`, calling
`onFrame(dir, msg)` for every frame and `onPermission({...})` when the
agent is blocked on a person. `drivers/acp.mjs` is the stdio reference,
`drivers/devin.mjs` the HTTP-polling one. Add a builder if the frames
aren't ACP or Claude Code stream-json (`server/acp-doc.mjs` is the
model), register the agent in `FLEET_AGENTS` in `server/fleet.mjs`, and
teach `src/sources/acp.ts` and `acpSegments` to pick your builder from
the recording header's `driver`.

If your agent already speaks ACP over stdio, you may need no code at
all: launch it with its command as the agent name, or add one entry to
`AGENTS` in `server/acp.mjs`.

## The rules that keep foolscap trustworthy

- **Read-only against session files.** foolscap never writes into
  another tool's directory. Its own state lives under `~/.foolscap`.
- **Synthetic fixtures only.** Transcripts contain private material.
  Tests, screenshots and demos use invented sessions — never real ones,
  not even redacted.
- **Evidence over claims.** The outcome engine credits tests that ran and
  passed, commits that landed, and nothing an agent merely *said*. If you
  touch `server/outcome.mjs`, add a test for the false positive you're
  worried about, not just the true positive.
- **Local by default.** Anything that listens on a port binds to
  127.0.0.1 unless the user explicitly asks otherwise; anything that runs
  code requires the `x-foolscap` header and refuses cross-origin requests.
- **Docs ship with the feature.** README, CHANGELOG and, when it applies,
  the agent skill change in the same PR.

## Running things

```sh
pnpm install
pnpm dev            # viewer at http://localhost:5173
pnpm test           # node --test, ~50 tests, no network, no API keys
pnpm build          # tsc + vite
node cli.ts list    # the CLI needs no build (Node 24+)
```

`FOOLSCAP_ROOT=/path/to/fixtures pnpm dev` points the viewer at a curated
archive (per-source subdirectories: `claude/`, `codex/`, `dsh/`, `acp/`,
`opencode/`). The tests build their own fixtures in temp directories.

## Filing an issue

Use the templates — **bug**, **harness request**, **driver request**. For a
harness or driver, the single most useful thing you can include is a
*synthetic* sample of the log format (a few lines with made-up content)
and where it lives on disk. That turns a request into a PR-sized task.

## Style

Match what's around you: comments explain *why*, names are plain words,
functions are small enough to test. Commits are conventional-ish
(`feat:`, `fix:`, `docs:`) with a body that says what changed and why —
the commit log is the design history.

## License

MIT. By contributing you agree your contribution is licensed the same way.
