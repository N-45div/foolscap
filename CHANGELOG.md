# Changelog

## 1.0.0-alpha.0 — unreleased

foolscap is a desktop app that lives in your tray: an inbox for your
coding agents and assistants. It tells you the moment one needs you, and
sends the next prompt only when the tests pass.

### Added

- **The tray app** (Electron, Windows and Linux). One click on the icon
  opens a compact panel: Your move (approvals, red checks, held queues,
  finished work), Agents' move, and a line to start the next task.
  Ctrl+Shift+Space toggles it; the full window shows one task in detail.
- **Notifications with Approve and Deny** on the notification itself,
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

### Licence and price

- **GPL-3.0-or-later**, so every copy stays open source.
- **Open source, and paid.** Official builds have a 14-day trial, then a
  one-time licence: $9 for the first 50 early buyers, then $19; $99 with
  voice. Building it yourself stays free.
