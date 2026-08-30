# Changelog

## 0.4.0 — 2026-08-30

Drivers.

### Added

- **Claude Code, natively, in the fleet.** A second driver: `claude -p`
  with `stream-json` in and out — Claude Code's own multi-turn protocol,
  no adapter to download. Permission prompts still reach the queue:
  Claude Code's `--permission-prompt-tool` calls a tiny MCP server
  foolscap registers per session, which posts the question to the
  fleet (top of the queue), polls until you answer with `a`/`d`, and
  returns the verdict. Verified against the real binary. It is the
  default agent; `FOOLSCAP_CLAUDE` overrides the binary.
- **OpenCode in the fleet** — `opencode acp` speaks ACP over stdio, so it
  is one registry entry: pick it in the launch form or `--agent opencode`.
- **A driver layer.** Transport lives in `server/drivers/*` (`acp`,
  `claude`); the session core, the document builders, the recorder and
  the evidence engine are shared. Recordings carry the driver in their
  header, so the archive adapter replays each with the right builder.

### Changed

- Agents launched by the fleet get `$PWD` set to their launch directory
  (some tools read it in preference to the process cwd). Verified: the
  real Claude Code reports the fleet's launch directory as its cwd.

## 0.3.0 — 2026-08-30

Many agents, one queue.

### Added

- **The fleet — many agents, one queue.** foolscap is now the ACP
  client for each agent it runs: it sends prompts, receives the stream
  and answers permission requests, so it knows live which agent is
  blocked on you, whose tests just went red, which turn finished and
  is waiting, and which is fine. The queue is ranked by that (blocked →
  red → review → working → idle, longest-waiting first); `n` jumps to
  the next thing that needs you, `a`/`d` answer a permission, and the
  tab title carries the count. Each agent opens as a document with the
  archive's renderer — same document, present tense — and every session
  is recorded, so it's in the archive the moment it ends. Works with
  any stdio ACP agent (Claude Code, Codex, Gemini CLI, or a command you
  name). The fleet API is loopback-only, refuses cross-origin requests,
  and requires a header simple cross-origin requests cannot carry.
- **One adapter for every ACP harness.** Sessions run through the fleet
  or the bridge are recorded as the protocol itself and replayed by the
  same TranscriptBuilder that drew them live, so a new harness needs no
  adapter. They show up in the archive, the shelf, and outcome evidence.
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
