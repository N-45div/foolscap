# Changelog

## 1.0.0-beta.5 — unreleased

### Added

- **Open in your editor.** Each task's folder opens in VS Code, Cursor,
  Windsurf, Antigravity or Zed, whichever are installed, or in the file
  manager.
- **Ports per task.** Every task gets its own block of ten ports from
  4100; its agent gets `PORT` and `FOOLSCAP_PORTS`.
- **Run.** Starts the task's dev server on its port, from `.foolscap.json`
  `"run"` or the `dev`/`start` script, shows its local address as a link,
  and stops it, and everything it started, on Stop, Merge or Discard.

### Fixed

- A test run that exited 0 and counted its own passing tests is green
  even when a passing test's name mentions a permission error or "no
  tests found"; it used to hold the queue as "sandbox blocked".
- A task folder an editor still had open after Merge or Discard is
  removed once that window closes, instead of staying behind empty.

## 1.0.0-beta.4 — 19 October 2026

foolscap is a desktop app that lives in your tray: an inbox for your
coding agents and assistants. It tells you the moment one needs you, and
sends the next prompt only when the tests pass.

### Added

- **The tray app** (Electron, Windows and Linux). One click on the icon
  opens a compact panel: Your move (approvals, red checks, held queues,
  finished work), Agents' move, and a line to start the next task.
  Ctrl+Shift+Space toggles it; the full window shows one task in detail.
- **The pill**, a small capsule above the taskbar with one mark per task
  (a dot when one needs you, a ring while one works). Hover it to approve,
  deny or merge right there; click it for the panel. Drag it anywhere.
- **The orbit**: you at the centre and every task a planet, urgency as
  distance. Each task keeps its own angle, so it moves straight in or out
  as its state changes. Tab walks the planets, A approves, D denies.
- **Notifications with Approve and Deny** on the notification itself
  (Windows; Linux notifications carry no buttons, so the pill does it),
  and a finished turn reported with foolscap's own test verdict.
- **The next-prompt queue.** Line up "then…" steps per task. After each
  turn foolscap runs the repo's own tests itself, outside any agent
  sandbox, and sends the next prompt only on green; anything else holds
  it with the reason, and you can send anyway.
- **Codex, natively** through `codex exec --json`, next to native Claude
  Code. **ACP agents**: Gemini CLI, OpenCode, Goose, Qwen Code, Kimi,
  Copilot CLI, Kiro, and the assistants **Hermes** and **OpenClaw**.
- **Strict evidence.** A test run is green only with exit code 0 and at
  least one test that ran, read from the runner's own counts. A runner
  named inside a string is not a run.
- **Windows done properly.** Agents resolve through npm shims and native
  installers to their real executables and launch with no shell; API
  keys are stripped from their environment so a subscription is never
  switched to API billing.
- **A worktree per task**, with Merge (one commit on your branch,
  refusing a dirty checkout and backing out of conflicts) and Discard.
  Dependencies are linked in, `.worktreeinclude` files copied.
- **Reply from the notification** (Windows): a finished turn's next prompt, what to
  do instead of a held one, or the answer to an agent's question.
- **Claude Code sessions from your own terminal**, through hooks you
  approve in Settings: they join the inbox, their permissions get Approve
  and Deny, and queued prompts go out at their next stop after green tests.
- **While you were away**, and a Today line, both counted from a local
  journal of what happened.
- **Voice prompts**: a mic in the new-task line that records, cuts at your
  pauses, uploads while you talk and writes a clean prompt, through
  foolscap Cloud with your licence key.

### Licence and price

- **GPL-3.0-or-later**, so every copy stays open source.
- **Open source, and paid.** Official builds have a 14-day trial, then a
  one-time licence: $9 for the first 50 early buyers, then $19; $99 with
  voice; or the voice subscription ($8 a month or $79 a year), which
  includes the app while it runs. Building it yourself stays free.
- **Licence keys** are checked online: only the key, its activation and
  the computer's name are sent, and a key keeps working offline for 7
  days.
