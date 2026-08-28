# Changelog

## Unreleased

### Added

- **`foolscap acp` — ACP over the network.** The Agent Client Protocol
  standardizes the client↔harness boundary, but every client today
  spawns its agent as a local subprocess: the remote transport is still
  unspecified, so an agent can only be driven from the machine it runs
  on. `foolscap acp` serves any stdio ACP agent (Claude Code, Codex,
  Gemini CLI) over an authenticated WebSocket, so you can hand the
  endpoint to a client anywhere. Frames are relayed verbatim rather than
  interpreted, so future protocol revisions pass through untouched, and
  every frame is recorded into the archive. Verified against the real
  `@zed-industries/claude-code-acp`.

  Security: a bearer token is required and generated per run (there is
  no open mode), loopback is the default and `--expose` warns loudly,
  one agent process per connection dies with its socket, non-JSON agent
  output never reaches the wire, and the token is never written to a
  recording.
- **Outcome evidence — which prompts actually worked.** Every occurrence
  of a prompt is judged against what the log records happened next:
  tests or a build that passed, a commit that landed, or a next prompt
  that took the work back ("no, that's wrong"). Read deterministically
  from the archive — no model call, no API key, no review queue. The
  shelf shows `✓ worked 2/3` or `↺ corrected`, proven prompts sort
  first, `foolscap prompts --worked` filters to them, and generated
  skills cite their evidence. Deliberately conservative: a claim in
  prose is not evidence, and a suite that printed failures is never a
  pass. 14 tests pin both directions, including the false positives
  ("revertible migrations…" is not a correction).
- **Recurring prompts become skills** — a prompt reused 2+ times gets a
  "write as skill" action on the shelf that drafts a ready-to-edit
  `SKILL.md` (frontmatter, the request, provenance). A prompt you keep
  retyping is a workflow that hasn't been written down yet.
- **The CLI is multi-source** — `list`, `export` and `path` now cover
  Claude Code, Codex and dsh (including zstd-compressed sessions), with
  `--source` to narrow. New `prompts` command puts the shelf in the
  terminal: `--filter`, `--starred`, reuse counts.
- **The agent skill knows all three harnesses** — plus prompt recall, so
  an agent can answer "what do I keep asking for?" and hand back the
  exact prompt text.
- **Trusted publishing** — releases publish from GitHub Actions via npm
  OIDC on a `v*` tag: no token in the repo, in CI secrets, or on a
  laptop, and the tarball gets a provenance attestation. The workflow
  refuses to publish when the tag and `package.json` disagree.

## 0.2.0 — 2026-08-24

The shelf and the third harness.

### Added

- **The prompt shelf** — your prompt library, derived from the archive:
  every prompt you've ever sent, across all harnesses, deduplicated with
  reuse counts. Filter, one-click copy, star (persisted in
  `~/.foolscap/starred.json` — never near session files), and jump back
  to the session where a prompt was used. `☆ prompt shelf` in the
  sidebar footer.
- **DeepSeek Harness (dsh) support** — a third adapter, days after dsh's
  open-source release. Reads `~/.dsh` (honoring `DSH_HOME`), decompresses
  the default zstd persistence with Node's built-in zstd (22.15+), maps
  the event log (`user/message`, `assistant/message` incl. reasoning and
  token usage, `tool/call`/`tool/result` paired by callId) into session
  documents, and renders `str_replace_editor` edits as red/green diffs.
  Search and the prompt shelf reach inside compressed sessions.
- **Cell permalinks** — every cell's `[n]` marker is an anchor: click to
  set `#cell-N` and copy a deep link; fresh loads honor the hash. Exports
  get the same anchors with a `:target` highlight.
- **j/k keyboard navigation** — walk cells notebook-style with an active
  mark; typing in inputs never triggers it.
- Boot banner counts sessions per harness, dsh included.

### Fixed

- `bin` entry survives npm publish (npm silently strips `./`-prefixed
  bin paths).
- Long tool names no longer overflow the ledger column.

## 0.1.0 — 2026-08-18

First release on npm: `npx foolscap`.

- Sessions as documents: prompts as numbered cells; tool calls as
  expandable ledger rows; edits as red/green diffs; thinking collapsed;
  markdown rendered and sanitized.
- Claude Code and Codex CLI adapters over a neutral `SessionDoc` model.
- Subagent fan-outs as nested documents, lazy-loaded per Agent call.
- Archive-wide search with match counts and snippets.
- One-file self-contained HTML export (no JS, dark/light).
- Agent skill (`npx foolscap skill`) for session recall from Claude Code.
- Local-first: serves on 127.0.0.1 only; read-only against session files.
