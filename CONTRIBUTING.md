# Contributing

Thanks for taking the time. Bug reports, fixes and small focused features are all
welcome. For anything large, open an issue first so we can agree on the shape before
you spend time on it.

Found a security problem? Do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Setup

You need macOS to run the app (it is built and tested on Apple Silicon), Node.js
22.13 or newer, and a Claude Code login on the machine. The unit tests run on any OS.

```bash
npm ci
npm run check
npm run dev
```

`npm run check` is typecheck plus unit tests, and it is the gate: CI runs it, plus
`npm run build`, on every pull request. There is no linter and no formatter, so match
the style of the file you are editing.

Run one test file:

```bash
node --experimental-strip-types --test src/core/routing.test.ts
```

## How the code is laid out

[CLAUDE.md](CLAUDE.md) is the map: the four layers, what each may import, and the
invariants that will bite you if you break them. It is written for Claude Code, and
it works just as well for people. Read it before your first change. The short version:

- Logic worth testing belongs in `src/core`, which runs in plain Node with no Electron.
- Anything that crosses a process boundary is typed in `src/shared/contract.ts`.
- Relative imports carry the `.ts` extension. No `enum`, no namespaces.
- The renderer never assigns `innerHTML`.

[PLAN.md](PLAN.md) is the original design spec. It is the best record of why a
decision was made.

## Pull requests

`main` is protected: every change goes through a pull request, and CI must pass
before it can merge. Pull requests are squash-merged.

- Keep each pull request to one change. Add or update tests in `src/core` when you
  change behaviour there.
- Comments explain *why*, and usually name the failure they prevent. A comment that
  restates the code is noise. Do not drop an existing rationale when you edit nearby.
- Write the title as a plain sentence about the change ("Retry the socket after
  sleep"), and use the description to explain the problem, the fix, and how you
  verified it. That text becomes the commit message.
- Never commit real data: no real names, emails, Slack IDs, tokens or home-directory
  paths, in code, tests or docs. Use obvious placeholders like `U012ABC3DEF` and
  `/Users/you/project`.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
