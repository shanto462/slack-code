# slack-code

[![CI](https://github.com/shanto462/slack-code/actions/workflows/ci.yml/badge.svg)](https://github.com/shanto462/slack-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Drive Claude Code from Slack DMs, from a macOS menu-bar app. One DM thread is one
Claude Code session, bound to one project directory on this machine.

This is not Anthropic's Claude in Slack. That runs cloud sessions against GitHub
repos. This runs local sessions against local directories, on your Mac.

## How it works

Start a thread by naming a project on the first line:

```
myproject
have a look at the drafts and tell me which one is closest to done
```

The first line of a **new** thread is the project alias. Everything after it is
the prompt. Reply in the thread and it stays bound to that project, with full
history, and your replies are **not** alias-parsed, so a reply can start with any
word without being eaten.

If the alias does not match, it replies with the valid ones rather than guessing.

- Anything you send while it is working is **queued**, never injected mid-turn.
  A `:inbox_tray:` reaction confirms it landed; the agent picks it up at the
  start of its next turn. A burst of messages merges into one turn.
- Reactions track state: hourglass working, check done, cross failed.
- A live "working..." message shows recent tool calls. At turn end it is deleted
  and the answer posted fresh, with a receipt footer
  (`My Project · 3 tool calls · 12.4s`). A new message rather than an edit is
  deliberate: Slack does not push-notify an edit, and being notified when a turn
  finishes is the point.
- A turn that goes completely silent is reset, so a wedged turn cannot leave a
  thread permanently deaf. The deadline slides with real progress.
- DMs that arrive while the socket is down are swept up on reconnect, bounded by
  a persisted cursor so a restart never re-runs old turns. The sweep also fires
  when the machine wakes from sleep.

The agent is told it is on Slack, so it writes Slack mrkdwn, keeps answers short,
and never asks you to look at a terminal.

## Requirements

- macOS 12 or newer. It is built and tested on Apple Silicon.
- Node.js 22.13 or newer.
- Claude Code signed in on this Mac. The bridge uses your existing Claude Code
  login; check which account with `npm run whoami`.
- A Slack workspace where you can create an app (see
  [Slack app requirements](#slack-app-requirements)).

## Setup

```bash
git clone https://github.com/shanto462/slack-code.git
cd slack-code
npm install
npm run build
npx electron .
```

The app opens a setup wizard: Slack tokens, who may drive it, model, permission
mode, and your first project. Each step verifies against the real API as you go.

Migrating from the earlier headless `.env` daemon, skip the wizard:

```bash
npx electron . --import-env
```

That imports tokens, operators, model, permission mode and the project, creates
an alias, and migrates `.state/threads.json` into SQLite so old threads keep
their sessions. Neither the `.env` nor the JSON is deleted; both stay as the
rollback.

Check it any time:

```bash
npx electron . --doctor
```

### Slack app requirements

Socket Mode, so no public URL and no ngrok.

- **Socket Mode** enabled, app-level token with `connections:write`
- **Event Subscriptions, bot events**: `message.im`
- **Bot scopes**: `im:history`, `im:read`, `im:write`, `chat:write`,
  `reactions:write`, `users:read`

`doctor` cannot verify event delivery from the API. If everything passes and DMs
still never arrive, `message.im` is missing. Run the handshake step in the app to
confirm delivery with a real message.

## Running at login

```bash
npm run autostart:install
```

`com.slackcode.app.plist` in the repo is a template: the real paths are machine
specific, so the script resolves them from the current environment and installs
the result. Copying the template by hand will not work.

The app takes a single-instance lock, so launching it by hand while this is
loaded hands over to the running copy instead of starting a second bridge.

Logs: `~/Library/Logs/slack-code/slack-code.log`. To stop:

```bash
npm run autostart:uninstall
```

**Why a LaunchAgent instead of the in-app toggle.** The app has a run-at-login
switch, but Electron's `setLoginItemSettings` only works in a packaged build, and
the packaged build currently cannot keep your tokens (see Known limits). Until
the app is signed with a real Developer ID, this plist is how run-at-login
actually works. The plist sets `HOME`, `USER` and `LOGNAME` explicitly, and those
are load-bearing: Claude Code resolves Keychain credentials by user identity, so
without `USER` the bridge starts fine and then fails every turn with
`Not logged in`.

## Where things live

| What | Where |
|---|---|
| Settings and projects | `~/Library/Application Support/slack-code/config.json` |
| Slack tokens | Keychain, via Electron `safeStorage` |
| Threads, turns, logs | `~/Library/Application Support/slack-code/state/slack-code.db` |
| Claude Code sessions | `~/.claude/projects/<dir>/<sessionId>.jsonl` |

Settings stay plain JSON on purpose: small, read once at boot, and worth being
able to open and hand-edit. SQLite holds the data that grows and gets queried,
via the built-in `node:sqlite`, so there is no native module to rebuild on every
Electron upgrade.

Sessions are shared with the CLI and the desktop app, because Claude Code keys
its store off `$HOME`, not off the binary. A session started from Slack resumes
in your terminal:

```bash
cd /path/to/your/project && claude --resume
```

Note the agent runs the SDK's own bundled Claude Code
(`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`), pinned by
the SDK dependency. Upgrading your CLI does not upgrade the bot; bump
`@anthropic-ai/claude-agent-sdk` instead.

Check which account it is signed in as, free:

```bash
npm run whoami
```

## Development

```bash
npm run dev
npm run check
npm run selftest
npm run icons
npm run dist
```

`icons` rasterises `build/*.svg` into the PNGs the app and the packager use, via
Chromium rather than ImageMagick: the local ImageMagick advertises SVG support
but its delegate shells out to `rsvg-convert`, which is not installed, so it
would quietly fall back to its own renderer and mangle the gradients and masks.
The menu-bar files are hand-tuned per size, 16 and 32 being separate sources, and
the generator fails the build if a tray PNG contains any pixel that is not pure
black, since that is what stops macOS inverting it for a dark menu bar.

`check` is typecheck plus unit tests. `selftest` drives one real turn and posts
to Slack. `dist` writes outside this directory by default
(`~/Library/Caches/slack-code/release`, override with `SLACK_CODE_RELEASE_DIR`).
That is not a preference: a checkout under `~/Desktop` or `~/Documents` is often
synced by iCloud, and the file provider stamps `com.apple.FinderInfo` onto
Electron's helper bundles as electron-builder extracts them. codesign then refuses
them, and the attribute cannot be cleared while the provider owns the files.

## Security

`bypassPermissions` means the agent runs every tool without asking, including
arbitrary `Bash`, with nobody watching. What limits the blast radius:

1. **The allowlist is enforced before anything else.** A DM from anyone not on it
   is logged and dropped. If it resolves to nobody, the bridge refuses to start.
2. **Every session is pinned to its project directory.**

Neither stops the agent doing something destructive inside that directory. For a
hard floor, set a tighter permission mode per project, or add a
`permissions.deny` block to that project's `.claude/settings.json` for patterns
like `Bash(rm -rf *)`. Settings load from `user`, `project` and `local` sources.

To report a vulnerability, see [SECURITY.md](SECURITY.md). Please do not open a
public issue for it.

## Known limits

- **The packaged app forgets its tokens on quit.** With only an ad-hoc signature
  the Keychain lookup fails, `safeStorage` reports unavailable, and the app
  correctly refuses to persist rather than falling back to plaintext. Needs a
  real Developer ID signature. Running unpackaged, as the LaunchAgent above does,
  is unaffected.
- The in-app run-at-login toggle is inert unpackaged, hence the LaunchAgent.
- Text only. File uploads are acknowledged and ignored.
- DMs only. Channel mentions and slash commands are not wired up.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
setup, the checks a change has to pass, and the conventions. This project follows
a [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). Not affiliated with Anthropic or Slack.
