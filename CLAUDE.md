# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A macOS menu-bar Electron app that bridges Slack DMs to local Claude Code sessions.
One DM thread = one Claude Code session, pinned to one project directory on this
machine. `README.md` covers the product behaviour and setup; `PLAN.md` is the
original implementation spec and still the best record of *why* a decision was made.

## Commands

```bash
npm run check        # typecheck + unit tests. The gate before anything is "done"
npm run dev          # electron-vite dev, with HMR on the renderer
npm run build        # bundle to out/
npm run doctor       # build, then run every verification headlessly, exits non-zero on failure
npm run selftest     # build, then drive one real turn and post it to Slack
npm run whoami       # which Claude account the SDK is authenticated as. Costs nothing
npm run icons        # rasterise build/*.svg into the tray and app PNGs
npm run dist         # package. Writes to ~/Library/Caches/slack-code/release, not here
```

Run one test file, or one test:

```bash
node --experimental-strip-types --test src/core/routing.test.ts
```

```bash
node --experimental-strip-types --test --test-name-pattern "R3" src/core/routing.test.ts
```

There is no linter and no formatter. `npm run check` (`tsc` on both leaf configs
plus `node --test`) is the whole automated gate, so it has to stay green.

Only `src/core` is tested, and it runs in plain Node with no bundler and no
Electron. That is the point of the layering below: if a piece of logic is worth a
test, it belongs in core.

## Architecture

Four layers, one contract.

| Layer | Runs in | May import |
|---|---|---|
| `src/core/**` | plain Node | Slack SDK, agent SDK, `node:*`, the contract. **Never `electron`** |
| `src/main/**` | Electron main | everything, including `electron` |
| `src/preload/index.ts` | sandboxed preload | `electron` + the contract only |
| `src/renderer/**` | sandboxed renderer | the contract, and `window.api` |

`src/shared/contract.ts` is the single source of truth for every type and constant
that crosses a boundary. It has **zero runtime imports** (the one `import type` from
the agent SDK erases), so it is safe to bundle into the sandboxed renderer. If you
need a shape that crosses a boundary, add it there rather than redeclaring it
locally or widening with `any`.

The Slack bridge runs in the **main process**, not a utilityProcess: `safeStorage`,
`app.getPath`, `powerMonitor`, `Notification` and `dialog` are main-only, and
keeping it there means a decrypted token never crosses an extra boundary.

### Core, roughly in dependency order

- `contract.ts` (shared) - types, IPC channel names, alias grammar, redaction, pure validators.
- `routing.ts` - **the heart, and pure**. Decides what an inbound message means. No Slack, no
  agent, no disk, no clock beyond `input.now`, which is what makes the R0-R7 table testable.
- `config.ts` - normalise / validate / resolve. Turns `StoredConfig` into the `RuntimeConfig`
  the service runs on, indexing projects by every alias.
- `storage.ts` - threads, cursors, turns and log lines on the built-in `node:sqlite`.
  **Every SQL string in the app lives here.**
- `session.ts` - one Slack thread's agent session. Owns the queue, the stall watchdog,
  the live status message and the receipt footer.
- `service.ts` - the daemon: Socket Mode, the allowlist, catch-up replay, thread binding,
  the session map. Startable, stoppable and reconfigurable while the app keeps running.
- `messages.ts` - **every operator-facing Slack string**, in Slack mrkdwn.
- `prompt.ts` - what gets appended to the stock Claude Code system prompt.
- `render.ts` - Markdown to mrkdwn, and chunking for Slack's 3000-char limit.
- `checks.ts` / `selftest.ts` - one implementation of every verification, shared by
  `--doctor` and the wizard, so no check exists twice.

### Main

`index.ts` is boot order and the comment at the top explains why each step sits where
it does (name before `getPath`, headless before the single-instance lock, `repairEnvironment`
before anything can spawn an agent, no window before `registerIpc`). `app.ts` is the spine:
config, secrets, storage, service, and the fan-out of everything they produce to IPC, the
tray and notifications.

State is split by access pattern, not pushed into one store:

| What | Where |
|---|---|
| Settings and projects | `<userData>/config.json`, plain JSON, hand-editable, no secrets |
| Slack tokens | `<userData>/secrets.json`, safeStorage ciphertext, mode 0600 |
| Threads, turns, logs | `<userData>/state/slack-code.db` via `node:sqlite` |

### Renderer

`shell.ts` reflects the theme onto `<html>` and routes on `status.setupComplete`:
`setup/` (a ten-step wizard, order derived from `SETUP_STEPS`) or `dashboard/`
(five panes). Both mount into a given element and return one teardown.

All CSS lives in `src/renderer/styles/`, imported through `index.css`. The wizard and
the dashboard ship no CSS of their own; they write markup against those class names.
The two slices keep separate DOM helpers (`setup/ui.ts`, `dashboard/dom.ts`) on purpose.

## Invariants that will bite you

These are load-bearing. Each one has a comment at its site explaining the failure it prevents.

**Imports**
- Relative imports carry the `.ts` extension: `import { IPC } from '../shared/contract.ts'`.
  That is what lets `npm test` run core with no bundler.
- Type-only imports must say `import type` (`verbatimModuleSyntax`).
- No `enum` and no namespaces anywhere in `src/`. Node's type stripping cannot handle them.
  Use a `const` object plus a union type, the way `contract.ts` does throughout.

**Process boundaries**
- Main builds as ESM (`.mjs`), preload as CJS (`.cjs`). The agent SDK is ESM-only so main
  cannot be CJS; a sandboxed preload cannot be ESM. Both are pinned in `electron.vite.config.ts`.
- Only structured-clonable data crosses IPC. Failures travel as `Result<T>`, never as a thrown
  custom error, because contextBridge drops custom Error properties and prototypes.
- Every IPC handler verifies the sender is this app's own window before acting.
- The preload exposes exactly the `Api` interface. `setSecrets` is write-only and there is no
  channel that reads a token back. Do not add one.
- The renderer never assigns `innerHTML`. Slack display names, API error text and file paths all
  reach it; text goes in through `textContent`.

**Agent SDK**
- **Never set `Options.env`.** The SDK replaces the subprocess environment entirely, which drops
  `HOME`/`USER`/`LOGNAME`, and Claude Code resolves Keychain credentials by user identity. The
  child inherits a `process.env` that `main/env.ts` repairs once at boot.
- The SDK's own bundled CLI is what runs. Upgrading a local `claude` install changes nothing;
  bump `@anthropic-ai/claude-agent-sdk` instead.
- Under asar the SDK's `require.resolve` returns a path that `spawn` cannot execute, so
  `main/binary.ts` rewrites it into `app.asar.unpacked`, which `asarUnpack` populates.

**Behaviour that is deliberate, not accidental**
- Messages are **queued at turn boundaries**, never injected mid-turn. A burst merges into one turn.
- The live "working..." message is **deleted** and the answer posted fresh. Slack does not
  push-notify an edit, and being notified when a turn finishes is the point.
- The persisted binding is the only routing discriminator, never `event.thread_ts`.
- A bound thread's first line is never inspected or stripped, so a reply may start with any word.
- No plaintext fallback for tokens. If safeStorage is unavailable the app runs from memory and
  refuses to persist.

## Conventions

Comments in this codebase explain *why*, and usually name the concrete failure avoided,
often with the measurement that proved it. Match that: a comment restating the code is noise
here, but dropping the rationale when you touch one of these files loses the only record of it.

Commit messages follow the same shape: a plain subject line, then prose explaining the problem,
the fix, and how it was verified.

`main` is protected by a ruleset: no direct pushes, no force pushes, no deletion. Work on a
branch and open a pull request; the `check` job in `.github/workflows/ci.yml` must pass, and
merges are squash or rebase only. The PR title and description become the commit message, so
write them in the shape above.

The repo is public. Never commit real data: no real names, emails, Slack user or channel IDs,
tokens, or home-directory paths, in code, tests or docs. Use placeholders like `U012ABC3DEF`
and `/Users/you/project`.
