# foolscap

**The notebook for coding agents.**

Jupyter didn't beat the REPL with a prettier terminal — it turned sessions
into documents. Agent sessions deserve the same: every run a notebook you can
read top-to-bottom, replay, and share. Prompts as cells; diffs, tool calls and
costs as outputs. Dense, legible, yours.

> _foolscap: the paper ledgers were written on._

## What it does today (v0.1 — the Viewer)

Point it at nothing. It finds every Claude Code session already on your disk
(`~/.claude/projects/**.jsonl`) and renders your full history as documents:

- Each prompt opens a numbered cell `[1]`, `[2]`, …
- Tool calls as one-line ledger rows — click to expand inputs, results, errors
- Edits rendered as red/green diffs
- Thinking blocks collapsed by default
- Token counts, timestamps, cwd, branch — tabular numerals throughout
- **Read-only by construction.** It never writes to your session files.

Zero configuration. If you've used Claude Code, you already have data.

## Run it

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173. Windows-first, works everywhere Node does.

## Where this is going

- **v0.2 — Drive.** Start and steer live sessions via the Claude Agent SDK.
  Parallel agents in worktrees, one dense fleet view.
- **v0.3 — The notebook earns its name.** Re-run a cell with an edited
  prompt, fork a session from any point, session diffing, shareable exports.
- **Self-contained app.** Tauri wrapper (Rust core) — one small binary you
  can run anywhere.

## Why

Terminals are great for quick and precise commands. They are a poor default
modality for reading what an agent *did* — information density is too low,
and the record of the work disappears into scrollback. The record deserves to
be a document.

Local-first: your sessions stay on your disk, Obsidian-style.

## License

MIT
