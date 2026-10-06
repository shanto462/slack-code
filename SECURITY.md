# Security policy

slack-code gives people in a Slack workspace a way to run Claude Code on your Mac.
Depending on the permission mode you pick, that can mean arbitrary shell commands
in a project directory with nobody watching. Please treat security reports seriously,
and please report them privately.

## Reporting a vulnerability

Use GitHub's private reporting:
[open a security advisory](https://github.com/shanto462/slack-code/security/advisories/new).
Do not open a public issue, pull request or discussion for a vulnerability.

Please include:

- what an attacker can do, and what they need first (for example "any member of the
  workspace who is not on the allowlist can ...")
- steps to reproduce, with the permission mode and macOS version you used
- the commit you tested (`git rev-parse HEAD`)

You should get a first reply within 7 days. Once a fix is ready, it lands on `main`
and the advisory is published with credit to you, unless you prefer to stay anonymous.

## Supported versions

There are no tagged releases yet. Only the latest commit on `main` is supported.

## Scope

In scope, for example:

- a DM from someone who is not on the allowlist reaching the agent
- a session running outside the project directory it is bound to
- a Slack token readable from disk in plaintext, or reachable from the renderer
- the renderer executing content that came from Slack, the agent, or the file system
- an IPC call from anything other than the app's own window being accepted

Out of scope:

- what the agent does inside its project directory under `bypassPermissions`. That
  mode is unrestricted by design, and the README says so. Pick a tighter mode or add
  `permissions.deny` rules if you need a hard floor.
- an allowlisted operator, or anyone with access to their Slack account, driving the
  agent. The allowlist is the trust boundary.
- an attacker who already has code execution as your macOS user
- the packaged app forgetting its tokens on quit (a known limit of ad-hoc signing)

## How the app limits the blast radius

- **Allowlist first.** Every inbound DM is checked against the operator allowlist
  before anything else. Messages from anyone else are logged and dropped. If the
  allowlist resolves to nobody, the bridge refuses to start.
- **One directory per session.** Each Slack thread is bound to one project
  directory, and its session runs there.
- **No public endpoint.** Slack connects over Socket Mode, so nothing listens on
  the network.
- **Tokens stay encrypted.** Slack tokens are encrypted with Electron `safeStorage`
  (Keychain) and written with mode `0600`. If encryption is unavailable the app keeps
  them in memory and refuses to persist. There is no plaintext fallback, and no IPC
  channel reads a token back.
- **Locked-down renderer.** The window runs with `sandbox`, `contextIsolation` and a
  Content Security Policy. It never assigns `innerHTML`, and every IPC handler checks
  that the caller is the app's own window.
