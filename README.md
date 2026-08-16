# foolscap

**The notebook for coding agents.** Your agent sessions, rendered as
documents — dense, replayable, shareable.

![MIT license](https://img.shields.io/badge/license-MIT-b8860b)
![Works with](https://img.shields.io/badge/works%20with-claude%20code%20·%20codex-1a1a1a)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-2f6349)

![A Codex session rendered as a foolscap document](docs/screenshot.png)

Jupyter didn't beat the REPL with a prettier terminal — it turned sessions
into **documents**. Agent sessions deserve the same. Every run becomes a
notebook you can read top-to-bottom, audit, and hand to someone else:
prompts as numbered cells; diffs, tool calls, thinking and costs as outputs
nested inside them.

> _foolscap: the paper ledgers were written on._

---

## Why

Terminals are superb for issuing precise commands and terrible for reading
what an agent *did*. The record of hours of agent work — every edit, every
command, every decision — disappears into scrollback, or into JSONL files
nobody opens. That record deserves to be a legible artifact:

- **Reviewable** — see every change an agent made, as diffs, in context
- **Recallable** — "what did we do in Tuesday's session?" has an answer
- **Shareable** — a session exports to one self-contained HTML file
- **Yours** — local-first; your sessions never leave your disk

## Supported harnesses

foolscap is **harness-agnostic by design**: every harness is one adapter
that maps its on-disk log format into a neutral session document. The
renderer, exporter and skill never know which tool wrote the session.

| Harness | Status | Reads from |
|---|---|---|
| Claude Code | ✅ | `~/.claude/projects/**/*.jsonl` |
| Codex CLI | ✅ | `~/.codex/sessions/**/rollout-*.jsonl` |
| Gemini CLI | planned | — |
| opencode | planned | — |
| aider | planned | `.aider.chat.history.md` |

Your harness missing? [Adding one is a single file](#add-a-harness).

## Quickstart

Requires Node 24+ and pnpm.

```sh
git clone https://github.com/N-45div/foolscap
cd foolscap
pnpm install
pnpm dev
```

Open http://localhost:5173. **Zero configuration** — if you've used Claude
Code or Codex, your archive is already there.

## Features

- **Sessions as documents** — each prompt opens a numbered cell `[1]`,
  `[2]`, …; the agent's work nests inside it
- **Search the whole archive** — every session, every harness, ranked by
  match count with a snippet; Enter to search, Esc to clear
- **Tool calls as ledger rows** — one line each, expandable to full
  inputs, results and errors
- **Edits as diffs** — old/new rendered red/green
- **Markdown, rendered** — the agent's answers display as real documents
  (headings, tables, code fences), sanitized before display
- **Thinking, collapsed** — reasoning is there when you want it, out of
  the way when you don't
- **Provenance header** — cwd, branch, harness + version, cell count,
  token totals where the format records them; tabular numerals throughout
- **Read-only by construction** — foolscap never writes to session files

## Export

One button (or one command) renders a session to a **single self-contained
HTML file**: no JavaScript, no external requests, dark/light from the
reader's OS, expand/collapse via native `<details>`. Host it, mail it,
attach it to a PR.

> ⚠️ Exports include tool inputs and results **verbatim** — review for
> secrets (keys, env vars, tokens) before sharing.

## CLI

No build step — Node 24 runs the TypeScript directly:

```sh
node cli.ts list                          # recent sessions, newest first
node cli.ts export latest -o session.html # shareable document
node cli.ts path <id-prefix>              # locate a session's JSONL
```

(CLI currently covers the Claude Code archive; multi-source is on the
roadmap.)

## Agent skill

`skills/foolscap/SKILL.md` teaches a Claude Code agent to operate the
archive itself — recall, summarize and export past sessions:

```sh
cp -r skills/foolscap ~/.claude/skills/foolscap
```

Then ask your agent things like *"what did we change in yesterday's
session?"*. The skill is read-only by instruction and never shares an
export without your explicit say-so.

## Architecture

Three layers; the middle one is the point.

```
adapters                 the document            surfaces
src/sources/*.ts   →     SessionDoc        →     viewer · export · CLI · skill
(one per harness)        (neutral model)         (never know the harness)
```

An adapter implements one function:

```ts
parse(raw: string): SessionDoc
```

plus a discovery entry that says where its files live. Parsing is
deliberately tolerant — unknown entry types are skipped, malformed lines
are counted, and a session that half-parses renders half a notebook, never
a blank screen.

### Custom archive roots

`FOOLSCAP_ROOT` points the viewer at any directory — a copied archive from
another machine, a backup, a fixture set:

```sh
FOOLSCAP_ROOT=/path/to/archive pnpm dev
```

Two layouts are understood: per-source subdirectories (`<root>/claude/…`,
`<root>/codex/…`) or a bare Claude-style projects directory. When
`FOOLSCAP_ROOT` is set, **only** that root is scanned.

## Add a harness

The ideal first contribution. To support a new agent tool:

1. **`src/sources/yours.ts`** — implement `parse(raw): SessionDoc`.
   Map prompts to cells, tool invocations to `ToolInteraction`s (pair
   calls with results by id), reasoning to `thinking` parts. Be tolerant:
   never throw on a malformed line.
2. **Register it** in `src/sources/index.ts` (id + label + parser).
3. **Add discovery** in `vite.config.ts` — where the files live, how to
   group them into projects.
4. Open a PR with a small **synthetic** fixture file (never real session
   data — transcripts contain private material).

If your agent writes a log, foolscap can be its notebook.

## Roadmap

- **v0.2 — Drive.** Start and steer live sessions via the Claude Agent
  SDK; parallel agents in worktrees on one dense fleet view; subagent
  sidechains rendered as nested documents.
- **v0.3 — The notebook earns its name.** Re-run a cell with an edited
  prompt, fork a session from any point, session diffing, search across
  the archive.
- **Self-contained app.** Tauri wrapper (Rust core) — one small binary,
  no Node required.
- More harnesses: Gemini CLI, opencode, aider, and yours.

## Philosophy

Local-first, Obsidian-style: the archive is files on your disk, and
foolscap is a lens over them — never a database, never a cloud. Read-only
against session files, always. Sessions contain private material, so
nothing leaves your machine unless you explicitly export it, and exports
warn you to review before sharing.

## License

[MIT](LICENSE)
