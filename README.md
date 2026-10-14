# foolscap

**An inbox for your coding agents and assistants.** foolscap lives in your
tray, tells you the moment an agent needs you, and sends the next prompt
only when the tests pass.

![GPL-3.0 license](https://img.shields.io/badge/license-GPL--3.0-b8860b)
![Windows and Linux](https://img.shields.io/badge/runs%20on-Windows%20·%20Linux-1a1a1a)
![Status: alpha](https://img.shields.io/badge/status-1.0%20alpha-2f6349)

> _foolscap: the paper ledgers were written on._

Running three agents at once fails the same way every time: you keep
switching terminals to see which one is stuck on a permission prompt,
which one finished, and which one broke the tests. foolscap does that
watching for you.

- **One click away.** It starts with your computer and sits in the tray.
  Click the icon and a small panel opens: **Your move** on top
  (approvals, failing checks, finished work), **Agents' move** below,
  and a line to start the next task. `Ctrl+Shift+Space` does the same.
- **Approve from the notification.** When an agent asks to run a
  command, the notification has **Approve** and **Deny** on it.
- **Queue the next step.** Give a task its "then…" steps. After each
  turn, foolscap runs the repo's own tests itself, outside the agent's
  sandbox, and sends the next prompt only when they pass. Red or unclear
  holds the queue and tells you why. You can always send anyway.
- **Green means green.** A test run counts as passing only with exit
  code 0 and at least one test that actually ran, read from the runner's
  own counts. Zero tests, a missing exit code or a sandbox block is never
  green.
- **Every agent in one place.** Claude Code and Codex natively, plus any
  agent that speaks [ACP](https://agentclientprotocol.com), including
  personal assistants like Hermes and OpenClaw.

## Agents

| Agent | How foolscap runs it | Approvals in foolscap |
|---|---|---|
| **Claude Code** | your own `claude`, natively (stream-json) | yes, through a permission relay |
| **Codex** | your own `codex exec --json`, one run per turn | no: headless Codex works inside its sandbox |
| Gemini CLI, OpenCode, Goose, Qwen Code, Kimi, Copilot CLI, Kiro | ACP over stdio | yes, ACP permission requests |
| **Hermes**, **OpenClaw** (assistants) | `hermes acp`, `openclaw acp` | yes; their queue always waits for you |
| Claude Code / Codex through their ACP adapters | `npx` adapters, pinned | yes; API keys only (see below) |
| Anything else that speaks ACP | give its command | yes |

foolscap only shows agents it finds installed. On Windows it looks
through npm `.cmd` shims and native installers to the real executable,
and launches it with no shell in between.

## Your login stays yours

foolscap runs the agent CLIs you already installed and signed in to,
unmodified. It never reads, stores or forwards your tokens. It removes
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` from the agents
it launches, so a key left in your environment can't silently move your
subscription to pay-per-token billing. The Claude Code and Codex ACP
adapters authenticate through SDKs whose terms do not cover routing a
personal subscription through another app, so they are listed for API
keys only.

By default Claude Code starts with your own settings and `CLAUDE.md`.
Turn off **Use my Claude Code settings** to start it with only the
repo's settings (`--setting-sources project,local`).

## How the queue decides

After a turn, foolscap finds the repo's test command:

1. `.foolscap.json` with `{ "test": "…" }`, if the repo has one;
2. else the `package.json` test script, run by the package manager its
   lockfile names (npm, pnpm, yarn or bun);
3. else `cargo test`, `go test ./...` or `python -m pytest -q`.

It runs that command outside any agent sandbox (on Windows, Codex's
sandbox stops `node --test` before any test code runs) and reads the
result strictly. Green sends the next queued prompt. Red, unclear, an
error or a stopped turn holds the queue with the reason. An assistant's
queue always waits for you.

## Install

1.0 is in alpha. Installers (an NSIS installer and the Microsoft Store
for Windows; AppImage, deb, rpm and pacman for Linux) come with the
first release. Until then, build it:

```sh
git clone https://github.com/N-45div/foolscap.git
cd foolscap
pnpm install
pnpm dev          # runs the tray app from source
pnpm dist:win     # or dist:linux, to build installers into release/
```

Needs Node 22.5+ and pnpm. On GNOME, tray icons need the
[AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/);
`Ctrl+Shift+Space` and the tray menu work everywhere. On Windows 11, new
tray icons start behind the `^` arrow: turn foolscap on under Settings ›
Personalization › Taskbar › Other system tray icons to keep it in sight.

## Open source, and paid

The code is open: read it, change it, build it yourself, free. The
**official app** (signed installer, auto-updates, the Microsoft Store)
is how foolscap is paid for, once, with no subscription:

| | Price | What you get |
|---|---|---|
| **foolscap** | **$9 for the first 50 early buyers**, then $19 | The app forever, every update, on up to 3 computers, plus 2,000 voice words a week |
| **foolscap + Voice** | $99 | The app forever, plus voice prompts forever (25,000 words a month) |
| Voice subscription | $8/month or $79/year | For heavy talkers: 120,000 voice words a month |

Official builds start with a 14-day free trial. After it, tasks already
running finish and new ones need a key; a build you make yourself never
asks. Keys are checked with [Polar](https://polar.sh): only the key, its
activation and your computer's name are sent, and a key keeps working
offline for 7 days after its last check.

**Voice prompts** (coming with the first release): hold a key, speak
(Hinglish welcome), and a clean prompt lands in the task, with your
repo's file names spelled right.

## Develop

```sh
pnpm test         # node --test: no network, no API keys, no real agents
pnpm build        # the renderer into dist/renderer
```

- `app/main/`: the Electron main process (tray, panel, notifications,
  permission relay, settings)
- `app/renderer/`: the panel and full window (React)
- `server/`: the session core: drivers, the next-prompt queue, evidence,
  test verification, the archive readers

See [CONTRIBUTING.md](CONTRIBUTING.md) for adding an agent or a driver.

## License

GPL-3.0-or-later: you may use, change and share foolscap, and any copy
you share must stay open under the same licence.
