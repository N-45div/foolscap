# Changelog

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
