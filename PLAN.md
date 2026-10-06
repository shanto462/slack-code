# slack-code to Electron: the implementation spec

Authoritative. Where this document and any earlier analysis disagree, **this document wins**.

Every API named here was verified against the packages installed on this machine, and the
runtime claims were verified by running real code inside Electron 43.4.1, not recalled from
memory. Section 2 lists what was checked, including four places where an earlier analysis was
wrong.

Baseline: commit `56ddef7`, 1450 lines across 8 files in `src/`, all working.
Target: an Electron menu-bar app with a setup wizard, multiple projects, alias routing, a
SQLite-backed dashboard, and a translucent macOS-native UI, with every behaviour in section 11
preserved exactly.

---

## 1. Decisions: every disagreement, resolved

The three analyses conflicted on 16 points. One answer each, with the reason.

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Service in the main process, or in a `utilityProcess`? | **Main process.** | `safeStorage`, `app.getPath`, `powerMonitor`, `Notification` and `dialog` are all main-only. A `utilityProcess` would push both decrypted tokens across an extra boundary, weakening the one property most worth protecting, and would double the serialisation surface for a large event union. The stated benefit (heartbeats off the UI thread) is weak: Socket Mode is I/O bound and the window does not exist most of the time. The real concern behind the suggestion, a synchronous disk write on every message, is answered by SQLite in WAL mode (§6). |
| 2 | Set `Options.env`? | **Never set it.** | `sdk.d.ts:1485` is explicit: "this value REPLACES the subprocess environment entirely". Setting it is exactly how `HOME`/`USER`/`LOGNAME` get dropped and every turn fails "Not logged in". Repair `process.env` in main at startup and let the child inherit. Inheritance cannot silently drop a variable; a hand-built env can. **Analysis 3 recommended `env: runtime.agentEnv`. Do not do that.** |
| 3 | `electron-store` for config? | **No, and it is not installed.** | Its own docs say it is "not intended for security purposes". Config is a small JSON file written atomically (§6.3). One less dependency in a bundle that already ships 317 MB. |
| 4 | Thread store: JSON or SQLite? | **SQLite, via the built-in `node:sqlite`.** | Mandated, and verified working (§2.1). All three analyses assumed the JSON store survives; it does not. Threads, cursors, turns and logs are append-heavy, unbounded, and the dashboard needs to query them. `better-sqlite3` is rejected: it is a native module needing an `electron-rebuild` step against Electron's ABI on every upgrade. `node:sqlite` ships inside Node, therefore inside Electron, so there is no native build step at all. |
| 5 | Settings in SQLite too? | **No. Plain JSON in `userData`.** | Deliberate. Settings are tiny, read once at boot, and the user benefits from being able to open, eyeball, hand-edit and back them up. Burying a six-field config in a binary database costs more than it gains. SQLite earns its place for the growing, queryable data, not for settings. |
| 6 | Create a thread record on an unknown alias? | **Yes, with `projectId: null`.** | The analyses only appeared to conflict. `bound` requires a *non-null* `projectId`, so an unbound record still lets the operator reply with just the alias to bind the thread. And the record is needed: the catch-up sweep iterates stored threads, so without a record a corrective reply sent during a disconnect is dropped. `rejectedNotifiedAt` then makes a burst of three bad aliases produce one error, not three. |
| 7 | Is `.` legal in an alias? | **No.** | Slack linkifies anything domain-shaped, so alias `foo.dev` arrives as `<http://foo.dev\|foo.dev>` and can never match. `/`, `:` and `@` are excluded for the same reason. Final grammar is `ALIAS_PATTERN` in `contract.ts`. |
| 8 | Unknown alias: always error, or fall back? | **Error by default; two bounded opt-in fallbacks.** | The product requirement is explicit about the error, so that is the default. `routing.defaultProjectId` is unset by default. `singleProjectFallback` defaults true but can only fire when exactly one project is enabled, where there is nothing to confuse it with, and it preserves today's behaviour verbatim. Pending-bind (§8.5) is the third, tightly gated. |
| 9 | In-thread commands | **`!` prefix**, plus bare `help` / `projects` on an *unbound* thread only. | `!` cannot collide with prose, so a bound thread's prompts are never swallowed. The bare forms only run where the alternative is an unknown-alias error anyway. |
| 10 | `includePartialMessages: true` to feed the stall watchdog? | **Yes, config-gated, default on.** | Verified this needs **zero changes to the watchdog or to `onMessage`**: `session.ts` sets `lastProgressAt` for *every* message before the switch, and `stream_event` falls through to `default: return`. A one-flag change that makes silence mean actual silence, instead of a max-effort thinking block reading as a stall. Gated by `tuning.streamProgressHeartbeat`. |
| 11 | Project identity | **`prj_` + 12 hex**, threads bind to the id, alias denormalised. | Readable in logs, no uuid dependency, and renaming an alias cannot orphan a live thread. |
| 12 | Default permission mode | **The wizard preselects nothing.** `acceptEdits` is only the corrupted-config fallback. `.env` import carries `bypassPermissions` across unchanged. | An absent field means a hand-edit or a truncated write; that path should land on the safer value. Choosing bypass is a real authority grant and deserves a deliberate click plus a consequences sheet. |
| 13 | `--doctor` / `--selftest` | **Kept, headless, inside Electron.** | They need `safeStorage` to decrypt tokens, which only exists in Electron. Main branches on `process.argv` before creating a window and calls `app.exit(code)`. `npm run whoami` is unchanged. |
| 14 | Renderer framework | **None. Plain TypeScript and DOM.** | Five parallel implementers and a settings UI do not need React's build surface. (c) and (d) each keep their own small DOM helpers, so there is no shared renderer module to fight over. The shared surface is CSS classes (§10.4), owned by (e). |
| 15 | `externalizeDepsPlugin` in `electron.vite.config.ts`? | **Do not use it.** Rely on the default. | See correction C1. It still exists but is deprecated; dependencies are externalised by default in v5. |
| 16 | Real macOS Liquid Glass? | **Not reachable. Do not claim it anywhere.** | `NSGlassEffectView` is AppKit/SwiftUI only and is not exposed to Electron. Native window vibrancy plus CSS `backdrop-filter` gets a convincing translucent macOS app, which is what we build (§10). |

---

## 2. Verified facts, and four corrections

Everything below was checked on this machine. Line references are into the installed packages.

### 2.1 `node:sqlite` inside Electron 43 (the mandated verification)

Ran in a **real Electron 43.4.1 main process**, not in Node:

```
electron 43.4.1, bundled node 24.18.1
import('node:sqlite')  -> OK
exports: DatabaseSync, Session, StatementSync, backup, constants, default
sqlite_version()       -> 3.53.1
file DB: PRAGMA journal_mode=WAL   -> {"journal_mode":"wal"}     (WAL confirmed on a FILE db)
explicit BEGIN / COMMIT            -> OK  (500-row batch insert)
PRAGMA user_version read + write   -> OK  (schema versioning works)
named parameters (:a)              -> OK
INSERT ... RETURNING               -> OK
BigInt round trip                  -> OK
```

**Conclusion: use `node:sqlite`. Do NOT add `better-sqlite3`, and do NOT add an
`electron-rebuild` or `install-app-deps` step.** There are no native modules in this project,
which is the entire point of the choice.

Two details that matter:

- On an **in-memory** database `PRAGMA journal_mode=WAL` returns `memory`, not `wal`. That is
  correct SQLite behaviour, not a failure. Only assert `wal` against a file database.
- Types: `@types/node@24.13.3` ships `sqlite.d.ts` with `DatabaseSync` and `StatementSync`, and
  a realistic usage typechecks under `lib: ["ES2022"]`. `@types/node` was bumped from `^22` to
  `^24` to match Electron's actual Node 24 runtime.

### 2.2 Electron runtime, verified by execution

| Claim | Result |
|---|---|
| `safeStorage.isEncryptionAvailable()` after ready | `true` |
| `safeStorage.isAsyncEncryptionAvailable()` | `true` |
| `encryptString()` return type | `Buffer` (35 bytes for a 22-char token) |
| base64 round trip through JSON | exact plaintext recovered |
| `getLoginItemSettings().status` | `'not-found'` when unpackaged |
| `systemPreferences.getAccentColor()` | `"007AFFFF"` |
| `nativeTheme.shouldUseDarkColors` | works |
| `BrowserWindow` with `vibrancy:'under-window'`, `visualEffectState:'active'`, transparent background, `titleBarStyle:'hiddenInset'` | constructs cleanly |
| `win.setVibrancy('sidebar')` | works |
| `app.setActivationPolicy('accessory')` | works |
| `app.setAppLogsPath()` then `getPath('logs')` | `~/Library/Logs/<appName>` |
| ESM main process reaching `app.whenReady()` | works (tested ESM and CJS, and with a deferred dynamic import) |

### 2.3 Agent SDK 0.3.236

| Fact | Location |
|---|---|
| `PermissionMode = 'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'` | `sdk.d.ts:2193` |
| `EffortLevel = 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | `sdk.d.ts:576` |
| `pathToClaudeCodeExecutable?: string` | `sdk.d.ts:1777` |
| `maxBudgetUsd?: number` | `sdk.d.ts:1730` |
| `includePartialMessages?: boolean` | `sdk.d.ts:1678` |
| `additionalDirectories?: string[]` | `sdk.d.ts:1379` |
| `abortController?: AbortController` | `sdk.d.ts:1374` |
| `env` REPLACES the child environment | `sdk.d.ts:1483-1500` |
| `Query.setModel` / `setPermissionMode` / `interrupt` | `sdk.d.ts:2432` / `2405` / `2398` |

The six permission modes the product asked for are **exactly** the six the SDK defines. No
mapping layer is needed. `contract.ts` carries a compile-time drift guard that fails
`npm run typecheck` if a future SDK bump changes either union; the guard was negative-tested and
does fire.

The CLI binary is `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
**317,044,624 bytes**, mode `0755`.

### 2.4 Toolchain

- `allowImportingTsExtensions: true` is **required**. The import convention is `.ts`
  extensions (§3.4), and without this flag tsc raises `TS5097`.
- `skipLibCheck: true` is **required**, not cosmetic. Without it the agent SDK's transitive
  `@modelcontextprotocol/sdk` fails with `Cannot find name 'HeadersInit'` because the main
  tsconfig has no DOM lib. Proven by removing the flag.
- `node --experimental-strip-types --test` runs TypeScript tests on Node 22.18 with **zero new
  dependencies**, including importing `src/shared/contract.ts` with its type-only SDK import.
  Verified with a five-test suite against the real contract. This is `npm test`.

### Corrections

**C1. `externalizeDepsPlugin` was NOT removed in electron-vite 5.**
Analysis 2 stated it was removed. It is still exported (`electron-vite/dist/index.d.ts:14` and
`:167`) but marked `@deprecated`. The real behaviour is in
`dist/chunks/lib-q6ns0vZr.js:1636`: `const externalOptions = config.build?.externalizeDeps ?? true`.
So dependencies **are** externalised by default for main and preload. **Guidance: do not add the
plugin, do not copy v4-era config, and tune with `build.externalizeDeps` if ever needed.**
Note the library's own warning: if you use `isolatedEntries` in the preload config you must set
`build.externalizeDeps: false` there, so preload dependencies get bundled for the sandbox.

**C2. `ELECTRON_RENDERER_URL` is confirmed.**
Analysis 2 listed this as unverified risk #9. It is set by electron-vite at
`dist/chunks/lib-7y7CgM8M.js:67`. `window.ts` may rely on it in dev.

**C3. `Options.env` must never be set.**
Analysis 3 specified `env: runtime.agentEnv` in `buildOptions()`. That is the precise mechanism
that breaks Keychain auth. Overridden by decision 2.

**C4. `getAccentColor()` returns RGBA, not RGB.**
It returns 8 hex digits with no leading `#`, e.g. `007AFFFF`. Take the first 6 for CSS. Pasting
all 8 into `#…` silently changes the alpha.

Superseded by the storage mandate: every proposal in the analyses to keep the JSON thread store,
add `version: 2` to its snapshot, or debounce its writes. Threads, cursors, turns and logs are
SQLite now. The JSON file is read once, for import, and then left alone.

---

## 3. File ownership: five implementers, zero overlap

**No file appears twice.** If you need a change in a file you do not own, it is a contract change:
it goes through §4, not through editing their file.

| Owner | Owns exactly |
|---|---|
| **(a) core** | `src/core/**` (all logic, and its `*.test.ts`) |
| **(b) main** | `src/main/**` |
| **(c) preload + wizard** | `src/preload/**`, `src/renderer/setup/**` |
| **(d) dashboard** | `src/renderer/dashboard/**` |
| **(e) build + shell** | `electron.vite.config.ts`, `tsconfig*.json`, `electron-builder.yml`, `src/renderer/index.html`, `src/renderer/shell.ts`, `src/renderer/styles/**`, `build/**`, `.gitignore` |

**Owned by the tech lead, already written, do not edit:**
`src/shared/contract.ts`, `package.json`, `PLAN.md`.

If `contract.ts` genuinely lacks a type you need, post the exact shape you want rather than
declaring it locally or widening with `any`. A locally redeclared type is the one thing that
will break the parallel build.

**Deleted by (a) as part of the port** (they are the old headless entry points, and nothing may
import them once core exists): `src/config.ts`, `src/index.ts`, `src/log.ts`, `src/prompt.ts`,
`src/render.ts`, `src/session.ts`, `src/slack.ts`, `src/store.ts`. Move them into `src/core/`
rather than deleting and retyping: `render.ts` and `slack.ts` move essentially byte-for-byte.

**Deleted by (e):** `com.slackcode.daemon.plist` (replaced by `app.setLoginItemSettings`), and
the `dist/` directory. Preserve the plist's `EnvironmentVariables` block as a comment in
`src/main/env.ts`; it is the documentation for the PATH hazard in §7.2. `.env` and
`.state/threads.json` are **not** deleted: they are migration inputs.

### 3.1 Suggested order

(a) and (e) unblock everyone, so they start first. (b) needs core's `service.ts` interface but
can code against §4.1 immediately. (c) and (d) need only `contract.ts` and (e)'s CSS class list,
both of which exist now.

### 3.2 What is already done for you

- `npm install` has been run. **Install nothing.** Every dependency you need is present.
  `node:sqlite` is built in and needs no package. `dotenv` was removed on purpose: the `.env`
  migration uses a small hand-rolled parser (§9.7), so do not reinstate it.
- `src/shared/contract.ts` typechecks clean and its pure functions are test-covered.

### 3.3 Definition of done, per implementer

`npm run typecheck` and `npm test` both pass, and nothing outside your owned paths is modified.
`git status` showing a file you do not own is a defect.

### 3.4 Import conventions (all five implementers)

- Relative imports carry the **`.ts` extension**: `import { IPC } from '../shared/contract.ts'`.
  This is what makes `npm test` work without a bundler, and Vite handles it natively.
- Type-only imports must use `import type`. `verbatimModuleSyntax` is on, and Node's type
  stripping requires it.
- No `enum` and no namespaces anywhere in `src/`. Node's type stripping cannot handle them. Use
  a `const` object plus a union type, as `contract.ts` does throughout.
- Core imports **nothing** from `electron`. That is what keeps it testable, and it is enforced by
  the fact that `npm test` runs core in plain Node.

---

## 4. Cross-implementer contracts

Code against these signatures. You should not need to read another implementer's files.

### 4.1 What (a) core exports, consumed by (b) main

```ts
// src/core/service.ts
export interface ServiceDeps {
  storage: Storage;                       // from src/core/storage.ts
  onEvent: (event: ServiceEvent) => void; // main fans this out to IPC + tray + notifications
}

export class SlackCodeService {
  constructor(deps: ServiceDeps);
  /** Hot-apply config. Decides internally what needs a socket restart (§9.10). */
  applyConfig(config: RuntimeConfig): Promise<void>;
  start(): Promise<Result<null>>;
  stop(opts?: { force?: boolean }): Promise<void>;
  restart(): Promise<Result<null>>;
  /** The complete paintable state. A window opening mid-run paints from this alone. */
  snapshot(): DaemonStatus;
  readonly state: ServiceState;
  /** Dashboard row actions. */
  resetThread(key: string): Result<null>;
  cancelQueued(key: string): Result<{ dropped: number }>;
  selftest(projectId: ProjectId): Promise<Result<SelfTestResult>>;
}

// src/core/storage.ts
export function openStorage(dir: string): Storage;          // Storage is in contract.ts
export function importLegacyState(
  storage: Storage, jsonPath: string, projects: ProjectConfig[]
): LegacyImportReport;

// src/core/config.ts
export function validateConfig(raw: unknown): ValidationReport;
export function normaliseConfig(raw: unknown): StoredConfig;   // fills defaults, clamps ranges
export function resolveProject(p: ProjectConfig, d: AgentDefaults): ResolvedProject;
export function toRuntimeConfig(input: {
  config: StoredConfig; botToken: string; appToken: string;
  stateDir: string; claudeExecutablePath?: string;
}): RuntimeConfig;

// src/core/checks.ts   (doctor and the wizard share these; no verification logic exists twice)
export function checkBotToken(token: string): Promise<SetupCheckResult<SlackIdentity>>;
export function checkAppToken(token: string): Promise<SetupCheckResult<null>>;
export function checkAllowlist(token: string, entries: string[]): Promise<SetupCheckResult<AllowlistResolution>>;
export function checkUserIdentity(): SetupCheckResult<UserIdentityCheckData>;
export function checkShellPath(): SetupCheckResult<ShellPathCheckData>;
export function checkClaudeBinary(path?: string): Promise<SetupCheckResult<ClaudeBinaryCheckData>>;
export function checkClaudeAuth(p: ResolvedProject, exe?: string): Promise<SetupCheckResult<null>>;
export function checkProjectDir(dir: string): SetupCheckResult<ProjectDirCheckData>;

// src/core/slack.ts
export class Slack {
  constructor(botToken: string);
  whoAmI(): Promise<SlackIdentity>;
  listWorkspaceUsers(): Promise<SlackWorkspaceUser[]>;   // wizard user picker
  resolveUsers(entries: string[]): Promise<AllowlistResolution>;
  postToThread(channel: string, threadTs: string, text: string): Promise<string>;
  postRaw(channel: string, threadTs: string | undefined, text: string): Promise<string>;
  deleteMessage(channel: string, ts: string): Promise<void>;
  update(channel: string, ts: string, text: string): Promise<void>;
  historySince(channel: string, oldest: string): Promise<SlackEventLike[]>;
  repliesSince(channel: string, threadTs: string, oldest: string): Promise<SlackEventLike[]>;
  react(channel: string, ts: string, name: string): Promise<void>;
  unreact(channel: string, ts: string, name: string): Promise<void>;
}

// src/core/routing.ts   (pure; no Slack, no agent, no clock beyond the passed `now`)
export function route(input: RouteInput, config: RuntimeConfig): Route;

// src/core/messages.ts  (every operator-facing Slack string, one place)
export function unknownAliasMessage(seen: string, projects: ResolvedProject[], isReply: boolean, suggestion?: string): string;
export function bindAckMessage(p: ResolvedProject): string;
export function pausedMessage(alias: string, others: ResolvedProject[]): string;
export function orphanedMessage(alias: string | null, others: ResolvedProject[]): string;
export function helpMessage(projects: ResolvedProject[]): string;
export function projectsMessage(projects: ResolvedProject[], spend: SpendSummary): string;
export function receiptFooter(p: ResolvedProject, info: TurnEndInfo): string;

// src/core/log.ts   (same logger(scope) signature as today, so no call site changes)
export function logger(scope: string): { debug: F; info: F; warn: F; error: F };
export function setDebug(enabled: boolean): void;
export function setLogSink(sink: (line: LogLine) => void): void;  // main pipes into Storage + IPC
export function logTail(limit?: number): LogLine[];               // ring buffer backfill
```

`SlackEventLike` is the minimal inbound-message shape core needs (`channel`, `ts`, `thread_ts?`,
`user`, `text`, `subtype?`, `bot_id?`). It is declared and exported by `src/core/slack.ts`.

### 4.2 What (b) main provides

Main implements every `IPC.*` channel in `contract.ts` with `ipcMain.handle`, and pushes every
`IPC_EVENTS.*`. That is its whole contract; (c) and (d) reach it only through `window.api`.

Main also exports, for its own internal use only (no other implementer imports these):
`claudeBinaryPath()`, `repairEnvironment()`, `readSettings()`, `writeSettings()`,
`readSecrets()`, `writeSecrets()`, `currentTheme()`.

### 4.3 What (c) preload + wizard provides

```ts
// src/preload/index.ts  -> built to out/preload/index.cjs
// Calls contextBridge.exposeInMainWorld('api', api) with an object implementing
// EXACTLY the `Api` interface from contract.ts. Nothing more, nothing less.

// src/renderer/setup/index.ts
export function mountSetup(root: HTMLElement, onComplete: () => void): () => void;
```

`mountSetup` renders the wizard into `root` and returns a teardown function. It calls
`onComplete()` after `api.completeSetup()` resolves, which is (e)'s cue to swap in the dashboard.

### 4.4 What (d) dashboard provides

```ts
// src/renderer/dashboard/index.ts
export function mountDashboard(root: HTMLElement, initialView?: RendererView): () => void;
```

Same shape: render into `root`, return teardown. It owns its own sidebar navigation between
`dashboard`, `projects`, `settings`, `logs` and `diagnostics`, and it must handle
`api.onNavigate` so the tray can jump straight to a view.

### 4.5 What (e) build + shell provides

- `src/renderer/index.html` with a single `<div id="root">` and a module script importing
  `shell.ts`.
- `src/renderer/shell.ts`: reads `api.getStatus()`, mounts `mountSetup` or `mountDashboard` by
  `status.setupComplete`, subscribes to `api.onTheme` and reflects it onto
  `document.documentElement` (see §10.3), and swaps views when setup completes.
- `src/renderer/styles/`: the design-token layer and every component class in §10.4. **(c) and
  (d) write markup against those class names and must not ship their own CSS files.** A
  component (c) or (d) needs that is not in §10.4 is a request to (e), not a local stylesheet.

---

## 5. `src/core` file by file (implementer a)

### 5.1 `render.ts`

Move byte-for-byte. Zero imports, zero I/O, zero `process.*`. Do not touch it.

### 5.2 `log.ts`

Keep `logger(scope)` exactly as it is so no call site changes. Four additions:

1. `process.env.SLACK_CODE_DEBUG` at the top is a module-level `const` evaluated at import, so
   the UI could never toggle it. Replace with a mutable module flag plus `setDebug(boolean)`.
2. A bounded ring buffer of `LOG_RING_CAPACITY` (2000) lines, exposed as `logTail(limit)`, so a
   newly opened window can backfill its log pane instantly.
3. `setLogSink(sink)` so main can fan lines into SQLite and IPC. One sink, set once.
4. **Every line goes through `redactSecrets()` from `contract.ts` before it reaches the ring
   buffer, the sink, or the console.** Redact once, at the source, so no downstream consumer can
   forget.

### 5.3 `slack.ts`

Moves untouched except for two additions: `listWorkspaceUsers()` (the pagination loop already
exists inside `resolveUsers`; expose it) and making `SlackEventLike` an exported type.

One behaviour to preserve: `botUserId` is only set inside `whoAmI()`, and the self-message filter
depends on it. **A `Slack` instance must be rebuilt, and `whoAmI()` re-run, whenever the bot token
changes.** A restart that reuses a stale instance would have a null self id and stop filtering its
own messages, which loops.

### 5.4 `store.ts` becomes `storage.ts`

Delete the JSON store. Implement the `Storage` interface from `contract.ts` over `node:sqlite`.

Open sequence, in this order:

```sql
PRAGMA journal_mode = WAL;      -- verified to return 'wal' on a file db
PRAGMA synchronous  = NORMAL;   -- WAL + NORMAL is the durable-enough, fast pairing
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Schema, created on first open, versioned with `PRAGMA user_version` (verified working):

```sql
CREATE TABLE IF NOT EXISTS threads (
  channel              TEXT    NOT NULL,
  thread_ts            TEXT    NOT NULL,
  session_id           TEXT,
  project_id           TEXT,              -- NULL = seen but not yet bound
  alias                TEXT,              -- denormalised for display; project_id always wins
  cwd                  TEXT    NOT NULL,  -- dir at bind time; mismatch means the project moved
  slack_user           TEXT    NOT NULL,
  created_at           INTEGER NOT NULL,
  last_active_at       INTEGER NOT NULL,
  turn_count           INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL    NOT NULL DEFAULT 0,
  rejected_notified_at INTEGER,
  orphan_notified_at   INTEGER,
  PRIMARY KEY (channel, thread_ts)
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_threads_active  ON threads(channel, last_active_at DESC);

CREATE TABLE IF NOT EXISTS cursors (
  channel TEXT PRIMARY KEY,
  last_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT    NOT NULL,
  thread_ts   TEXT    NOT NULL,
  project_id  TEXT,
  alias       TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  tool_count  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL    NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  subtype     TEXT    NOT NULL DEFAULT 'success',
  error       TEXT,
  preview     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_turns_started ON turns(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_project ON turns(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  level   TEXT    NOT NULL,
  scope   TEXT    NOT NULL,
  message TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_at    ON logs(at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, at DESC);
```

Rules for this module:

- **All SQL lives here.** No SQL string anywhere else in the app. That is the point of the
  narrow interface.
- **Prepare every statement once**, at open, and reuse the `StatementSync`. Do not call
  `db.prepare()` per message.
- **The cursor must never move backwards.** Slack timestamps are numeric strings, so compare
  numerically, not lexicographically:

  ```sql
  INSERT INTO cursors(channel, last_ts) VALUES(?, ?)
  ON CONFLICT(channel) DO UPDATE SET last_ts = excluded.last_ts
    WHERE CAST(excluded.last_ts AS REAL) > CAST(cursors.last_ts AS REAL);
  ```

  This is the persisted-cursor protection that stops a restart replaying a day of old turns
  under `bypassPermissions`. It is the single most important line in this file.
- `booleans` are stored as `INTEGER` 0/1. Convert at the boundary so callers see real booleans.
- `prune(policy)` runs the `DEFAULT_RETENTION` sweeps: delete logs older than `logDays`, delete
  turns older than `turnDays`, then trim logs to `maxLogRows` by id. Call it at open and hourly.
- `close()` runs `PRAGMA optimize` then closes. Main calls it from `before-quit`.
- Synchronous throughout, deliberately. `node:sqlite` is a synchronous API, and it preserves the
  invariant that a thread record exists **before** `enqueue` is called (§8.3).

### 5.5 `legacy import`

`importLegacyState(storage, jsonPath, projects)` reads the old `.state/threads.json`, which on
this machine holds **7 threads and 1 cursor** (one DM channel and its cursor), every
thread with a `cwd` under the operator's home directory.

- Insert each thread, binding `project_id` by matching stored `cwd` against a configured project
  `dir`. No match leaves `project_id` NULL, which is a valid unbound record, not an error.
- **Import the cursors with the threads.** Losing them re-seeds every channel and is exactly the
  bug the cursor logic exists to prevent.
- Idempotent: skip entirely if the `threads` table is non-empty.
- **Leave the JSON file alone afterwards.** Do not delete it.

### 5.6 `config.ts`

Everything env-related is deleted: `import 'dotenv/config'`, `required()`, `optional()`,
`intWithDefault()`, the `~` expansion via `process.env.HOME`, and the
`new URL('../.state', import.meta.url)` default (it resolves relative to `dist/` today and breaks
under asar). What survives is the validation *messages*, which are good.

`ConfigError` throwing on the **first** problem is wrong for a wizard. `validateConfig` returns a
`ValidationReport` listing every issue at once, plus everything that was clamped rather than
rejected. Ranges are `TUNING_RANGES` in `contract.ts`; out-of-range numbers clamp and report,
they never throw.

Project directory existence is checked at add time by the wizard **and** re-checked at service
start. A project whose directory was deleted or unmounted is reported and skipped, never fatal.

### 5.7 `prompt.ts`

Signature becomes `slackSystemPrompt(project: ResolvedProject)`. Add one sentence naming the
alias and saying the operator does not need to repeat it on replies. Without that the model sees
a stray token at the top of the first turn and has no idea why.

### 5.8 `routing.ts` (pure, and the heart of requirement 5)

`route(input, config)` returns a `Route`. No I/O, no Slack, no clock beyond `input.now`. This is
where the unit tests go.

**The persisted binding is the only discriminator. Never `event.thread_ts`.** Two concrete
reasons in this codebase: `conversations.history` returns `thread_ts === ts` on any parent that
has replies, so a replayed first message would look like a reply; and a genuine reply can arrive
into a thread with no binding at all, which must not be mistaken for a bound thread.

```
bound = record?.projectId != null
     && config.byId.has(record.projectId)
     && that project is enabled
```

Rules, evaluated in order:

- **R0 command.** First line starts with `!` and names a `ThreadCommand`. Works bound or unbound.
  Courtesy exception: a bare `help` or `projects` on an *unbound* thread also runs, because the
  alternative is an unknown-alias error anyway.
- **R1 bound.** Return `{kind:'bound', prompt: text}`. **The first line is never inspected and
  never stripped.** A reply whose first line happens to equal an alias is just prose. Threads
  never change project: a resumed session is pinned to the cwd it was created in, so rebinding
  mid-thread would resume in the wrong directory.
- **R2 orphaned.** `projectId` set but the project is gone or disabled. Post once, set
  `orphanNotifiedAt`, then stay silent on that thread until config changes. Never silently
  reroute.
- **R3 bind.** Unbound, alias matches an enabled project, body non-empty. Bind, and enqueue
  **only the body**. The alias line must never reach the model.
- **R4 bindOnly.** Unbound, alias matches, body empty. Bind, react `:pushpin:`, acknowledge,
  **start no session and spawn nothing**. This makes "open a thread on the phone, then dictate"
  work, and it is free.
- **R5 paused.** Alias matches a disabled project. Distinct message from an unknown alias,
  because the operator's mental model ("I have that project") is correct.
- **R6 fallback.** No alias match, but a fallback resolves. The **whole text** is the prompt,
  unstripped, because here the first line is a real prompt line. Order: `defaultProjectId`, then
  `singleProjectFallback` when exactly one project is enabled, then a live pending bind (§8.5).
- **R7 unknownAlias.** Post the alias list, react `:grey_question:`, **do not bind and do not
  spawn**. The thread stays unbound, so the operator can reply with just the alias in that same
  thread and R4 binds it. That recovery costs no extra code.

Lookup is an exact hit on `config.byAlias`, a pre-built lowercased map covering `alias` and every
entry of `aliases`. Never scan projects per message. Matching is never fuzzy: a near miss
produces a *suggestion in the error text*, never a silent route. Normalisation is
`normaliseAlias()` from `contract.ts`, which absorbs the non-breaking spaces and zero-width
characters that mobile keyboards inject, plus a leading `/`, `@` or `#` and a trailing `:`, `,`
or `.`.

### 5.9 `messages.ts`

Every operator-facing string, in one file, in Slack mrkdwn (single asterisks for bold). Rules:

- Echoes of operator text are truncated to 60 characters and have backticks replaced with `'` so
  they cannot break out of a code span.
- More than 10 projects lists the first 10 and appends `_+N more, see the app._`
- The unknown-alias message must show the offending line, list every valid alias with its
  display name, and show a worked example with the alias on its own first line. Include the
  desktop hint: Shift+Enter makes the line break, and only the first message of a thread needs
  the alias.
- The receipt footer gains the project name: `_Writings · 3 tool calls · 12.4s · $0.08_`. One
  line of change, and it makes every answer self-identifying in a multi-project DM list.

### 5.10 `session.ts`

**Nine field reads change. The state machine does not.**

`SessionDeps.config` becomes two fields: `project: ResolvedProject` and `tuning: TuningSettings`.

| Now | Becomes |
|---|---|
| `cwd: config.projectDir` | `project.dir` |
| `permissionMode: config.permissionMode` | `project.permissionMode` |
| `allowDangerouslySkipPermissions: config.permissionMode === 'bypassPermissions'` | `project.permissionMode === 'bypassPermissions'` |
| `slackSystemPrompt(config.projectName, config.projectDir)` | `slackSystemPrompt(project)` |
| `config.model` | `project.model` |
| `config.effort` | `project.effort` |
| `deps.config.statusUpdateMs` | `deps.tuning.statusUpdateMs` |
| `deps.config.turnStallMs` | `deps.tuning.turnStallMs` |
| (new) | `pathToClaudeCodeExecutable`, `maxBudgetUsd`, `additionalDirectories`, `includePartialMessages`, `abortController` |

**Hold `tuning` by reference, never copy the numbers into fields.** The status throttle and the
stall watchdog read it fresh on every tick, so a slider change hot-applies to running sessions
for free. Copying would silently break that.

Additions to `buildOptions()`, all verified present in the SDK:

- `pathToClaudeCodeExecutable: runtime.claudeExecutablePath` when set (§9.4).
- `maxBudgetUsd: project.maxTurnBudgetUsd` when non-zero. It returns
  `subtype: 'error_max_budget_usd'`, which today's `onTurnEnd` would render as the unhelpful
  "Turn ended without a result: error_max_budget_usd". Special-case that subtype into a readable
  sentence naming the ceiling.
- `additionalDirectories: project.additionalDirectories` when set.
- `includePartialMessages: tuning.streamProgressHeartbeat`.
- `abortController`, so `close({force:true})` can abort an in-flight turn. Without it,
  `close()` only sets `closed` and stdin ends, and the child finishes its current turn anyway,
  orphaning a 317 MB process on quit.

**Never set `Options.env`.** See decision 2.

Add one `onEvent(event: TurnEvent)` dep and emit at the sites that already exist: `turn:started`
right after `this.idle = false`; `turn:progress` where `activity.push(toolLabel(...))` already
runs; `turn:ended` alongside the existing `onTurnEnd`; `turn:stalled` in `onStall`. Do not import
an emitter into core.

`close()` should also call `stopStallWatchdog()`, for symmetry with the existing
`stopStatusTimer()`.

**Do not touch:** `waitForWork()`, `input()`, the `!this.idle` term, `this.idle = false`,
`splice(0, this.pending.length)`, `join('\n\n')`, `priority: 'later'`, the stall watchdog, or the
clear-status-then-post-fresh sequence at turn end. Those are §11.

### 5.11 `service.ts`

`Daemon` becomes `SlackCodeService`. Same socket wiring, same catch-up sweep, same allowlist gate.
Three things are new: `applyConfig`, a real `snapshot()`, and correct teardown.

**Bugs that only appear once restart exists.** The old `stop()` was written for process exit and
leaks state. Every one of these must be reset in `stop()`:

- `catchupRunning` is never reset. If `stop()` lands while a sweep is in flight the flag stays
  true forever, and the next `start()` returns immediately at its guard. **Reconnect catch-up
  then silently stops working after one restart.** Same failure class as the cursor bug, and
  invisible until it costs a turn.
- `allowed` is never cleared, and the resolve step only ever adds. After tightening the
  allowlist and restarting, removed users stay authorised.
- `handled`, `socket` (not nulled today) and `reaper` (timer cleared, field left set) all need
  resetting.

**`applyConfig` granularity** (never tear down a busy session for a settings change):

| Changed | Action |
|---|---|
| `botToken` | rebuild `Slack`, re-run `whoAmI()`, full restart |
| `appToken` | new `SocketModeClient`, full restart |
| `allowedUserIds` | re-resolve and **replace** the set. No socket restart |
| projects added/removed/renamed | rebuild the alias index; close sessions of removed projects. No socket restart |
| `defaults.*` | apply in place via `Query.setModel()` / `setPermissionMode()` on live handles; otherwise close **idle** sessions only |
| `tuning` | nothing to do, it is held by reference |

**Startup failure must not kill the app.** The allowlist rule stays: refuse to run if it resolves
to nobody. But it must set `state: 'error'` with a detail, open the window and show why. Refuse
to serve, not to exist. The old `throw` reached `process.exit(1)`, which in a GUI app is an app
that vanishes.

Also add: a `powerMonitor`-triggered catch-up on resume is main's job (§9.9), but the service
must expose the sweep for main to call.

### 5.12 `checks.ts` and `selftest.ts`

`doctor()` currently prints as it goes and returns a number. Split the verifications into the
pure-ish functions in §4.1, each returning a `SetupCheckResult`. Then the CLI `doctor` is a thin
printer over them and the wizard calls the same functions over IPC. **No verification logic
exists twice.**

`checkClaudeAuth` keeps today's probe exactly: `query({prompt:'Reply with exactly: OK', options:{
cwd, maxTurns:1, permissionMode:'plan', model}})`, read until `type === 'result'`.
`permissionMode: 'plan'` is what makes it safe to run against a real directory. It spawns the
317 MB binary and takes seconds, so it reports `durationMs` and the UI must show a spinner and
not block other steps.

New checks beyond today's: `safeStorage` availability, the claude binary exists and is
executable, per-project directory health, login-shell PATH with a resolved-tools table, and the
legacy `com.slackcode.daemon` launchd job **not** being loaded (§9.8).

---

## 6. Storage architecture

Split by access pattern, deliberately, three ways.

### 6.1 SQLite: `<userData>/state/slack-code.db`

Threads, cursors, turns, logs. Append-heavy, unbounded, and queried by the dashboard. Owned by
`src/core/storage.ts` behind the `Storage` interface. Details in §5.4.

### 6.2 safeStorage: `<userData>/secrets.json`, mode `0600`

The two Slack tokens and nothing else. `{ "schemaVersion": 1, "slackBotToken": "<base64>",
"slackAppToken": "<base64>" }` where each value is base64 of `safeStorage.encryptString()`
ciphertext (verified to be a `Buffer`, and to round-trip through base64 and JSON).

Seven rules, each grounded in something verified:

1. Call `isEncryptionAvailable()` **after** `app.whenReady()`, always. macOS has no documented
   ready requirement but two of three platforms do, and it costs nothing.
2. Keychain calls **block the calling thread**. Decrypt **once** at startup, hold the plaintext
   in a main-process variable, and never decrypt per turn or per Slack event. Prefer the async
   variants inside IPC handlers so a Keychain prompt cannot freeze the socket event loop.
3. `encryptString` throws on failure. Wrap it.
4. Treat a failed decrypt as either a throw **or** garbage: validate the result against the known
   `xoxb-` / `xapp-` prefixes. On failure, clear the blob and route back into setup. **Never
   crash, and never fall back to plaintext.**
5. Ciphertext is bound to the app identity, and an unsigned local build's ad-hoc signature
   changes on every rebuild. So rule 4 is a routine path, not an exotic one.
6. `isEncryptionAvailable() === false` is a supported state: show a blocking banner, refuse to
   persist, run from in-memory tokens only. Do not call `setUsePlainTextEncryption(true)`; it is
   a no-op on macOS regardless.
7. The renderer never receives a token. `secretsSet` is write-only; `secretsStatus` returns
   presence plus a redacted hint. This is the main prize of putting the service in main.

### 6.3 JSON: `<userData>/config.json`

Settings and the project registry. Written with the existing write-to-`.tmp`-then-`renameSync`
pattern, which is the crash-safety property worth keeping. Contains **no secrets**, so it is safe
to read, back up, or paste into a bug report, and "export my settings" is safe by construction.
Deliberately hand-editable.

### 6.4 Logs on disk

`app.setAppLogsPath()` with no argument, called **after** `app.setName()`, gives
`~/Library/Logs/slack-code` (verified: without `setName` it resolves to `.../Logs/Electron`).
Rotate and cap the file. Do not write bulk data into `appData` directly, since some environments
back that directory up to cloud storage.

---

## 7. The auth fact, and the hazard the port introduces

### 7.1 Keychain identity

Claude Code resolves credentials from the macOS login Keychain keyed by **user identity**, not by
binary path. Any spawned agent process must have `HOME`, `USER` and `LOGNAME` in its environment
or every turn fails with "Not logged in".

`buildOptions()` does not set `Options.env` today. **That is correct and must stay correct.**
The SDK inherits `process.env` when `env` is omitted, and inheritance cannot silently drop a
variable. Repair happens once, in main, by mutating `process.env` (§9.2). If anyone ever adds
`env` (for example to set `CLAUDE_AGENT_SDK_CLIENT_APP`), it must be
`{ ...process.env, HOME, USER, LOGNAME, PATH }`.

At service start, assert all three are present and backfill from `os.userInfo()` /
`os.homedir()` if not, logging loudly. Failing every turn is a far worse outcome than a loud
startup warning. If `USER` or `LOGNAME` were empty, report it as an app bug, not a user error:
the app is supposed to set them.

### 7.2 The new hazard: a crippled PATH

A GUI app launched from Finder, the Dock, or a login item inherits `HOME`, `USER` and `LOGNAME`
from launchd, so Keychain auth survives. But it inherits a **minimal PATH** of roughly
`/usr/bin:/bin:/usr/sbin:/sbin`. No Homebrew, no nvm, no `~/.local/bin`.

The SDK's Bash tool spawns `/bin/bash --noprofile --norc`, which means **no profile is read and
the PATH is never rebuilt**. The agent inherits whatever main has. Under a login item that gives
the agent a shell with no `node`, no `npm` and no `rg`, failing with a confusing "command not
found" rather than an auth error. Every "run the build and verify" instruction in the system
prompt would fail.

`com.slackcode.daemon.plist` papers over this today with a hardcoded PATH, and that hardcoded
value is already stale (it omits the nvm path). Hardcoding does not scale.

**Fix, once, in main, before any `query()` runs:**

```ts
const shell = process.env.SHELL || '/bin/zsh';
const out = execFileSync(shell, ['-lic', 'command -p echo "__P:$PATH"'],
                         { encoding: 'utf8', timeout: 5000 });
const recovered = out.match(/__P:(.*)/)?.[1];
if (recovered) process.env.PATH = recovered;
```

Cache the result in settings, allow a refresh from the UI, and surface the effective PATH plus a
resolved-tools table (`git`, `node`, `npm`, `rg`) in the diagnostics panel, so the failure is
visible before it bites rather than after a confusing Slack reply.

---

## 8. Routing: the seam, and the four things that are easy to get wrong

### 8.1 Where it goes

Inside the inbound-message handler, **between the empty-text guard and the call that gets or
creates a session**. Order:

1. Mention stripping and `.trim()` stay **first**. A leading `<@U…>` would otherwise corrupt the
   alias.
2. `const threadTs = event.thread_ts ?? ts;` stays.
3. Look up the persisted binding.
4. Call `route()`.
5. Act on the `Route`.

### 8.2 The cursor advance stays above this block

A rejected alias is still a **handled** message. If the cursor were not advanced, a reconnect
sweep would replay it and re-post the same error forever.

### 8.3 The record is created synchronously, before `enqueue`

Message 1 creates and binds thread T. Messages 2 and 3 arriving milliseconds later as in-thread
replies then hit R1 and skip alias parsing entirely. Making binding async would open a race where
the burst's later messages get alias-parsed. This is why `Storage` is synchronous.

### 8.4 Replay inherits routing for free

The catch-up sweep funnels into the same handler, so a replayed top-level DM gets alias-parsed
and a replayed thread reply resolves by binding. Nothing extra to write, and **do not "optimise"
replay into a separate path**.

### 8.5 Pending bind: the desktop Enter trap

On Slack desktop, Enter sends and Shift+Enter inserts a newline. On mobile, Return inserts a
newline and send is a button. So a desktop operator will often send `writings` (Enter), then the
prompt (Enter), and the second message is a **new top-level thread**, not a reply, so the R4 bind
on the first thread does not help it.

After an R4 `bindOnly`, remember `channel -> {projectId, expiresAt}`. It is consumed by R6 only
when **all** of these hold: the message is top-level, the thread is unbound, the first line
matches no alias, no default project exists, and the window is live. Consumed once, then cleared,
and the reply footer says where it went. `pendingBindMinutes: 0` disables it.

The R4 acknowledgement also teaches the direct fix, so the heuristic gets rarer with use.

### 8.6 Orphan recovery

On `unknownAlias` **and** `isReply` **and** `recoverBindingFromParent`, do one bounded lookup of
the thread parent before posting any error, and bind from its first line if it names a valid
alias. One API call, only on the orphan path. It makes routing survive a deleted database, which
is exactly the failure the store admits to.

---

## 9. `src/main` file by file (implementer b)

### 9.1 `index.ts`, and why the order matters

```
1.  app.setName('slack-code')            // BEFORE any getPath, or userData and logs split
                                         //    between dev and packaged (verified)
2.  app.requestSingleInstanceLock()       // if false: app.quit() and return, immediately
3.  register 'second-instance' -> show window
4.  branch on process.argv for --doctor / --selftest  (headless, app.exit(code), no window)
5.  repairEnvironment()                   // §7. Before anything can spawn an agent
6.  await app.whenReady()
7.  Menu.setApplicationMenu(...)          // appMenu + editMenu. See below
8.  read settings, read+decrypt secrets, open Storage, run migrations
9.  build service, wire events
10. create tray; create window unless quiet-start
11. connectOnLaunch && setupComplete -> service.start()
```

**The single-instance lock is a correctness control, not a nicety.** The dedupe set is
per-process, so two copies on the same app token each receive every DM and each run it under
`bypassPermissions`. Same category as the cursor bug. Note its limit: it defends against a second
copy of *this app* only, not against the old launchd daemon (§9.8) or against `npm run dev`
running while the packaged app is open.

**`Menu.setApplicationMenu` with `appMenu` and `editMenu` is mandatory, not decoration.** The
setup flow requires **pasting Slack tokens**, and without an Edit menu `Cmd+V` does not reach the
renderer. This is also why `LSUIElement: 1` must not be set in `Info.plist`, tempting as it looks
for a menu-bar app.

Delete all four `process.exit()` calls and both signal handlers. `process.exit` in an Electron
main process skips `before-quit`, so a config error would kill the window with no message and no
database flush. Use `before-quit` / `will-quit`, and flush and `storage.close()` there.

### 9.2 `env.ts`

`repairEnvironment()`: assert and backfill `HOME`/`USER`/`LOGNAME`, then recover the login-shell
PATH (§7). Preserve the old plist's `EnvironmentVariables` block here as a comment; it is the
documentation for why this file exists.

### 9.3 `settings.ts` and `secrets.ts`

Per §6.2 and §6.3. `settings.ts` also owns the config schema migration keyed on
`CONFIG_SCHEMA_VERSION`, and must never throw on a corrupt file: fall back to `DEFAULT_CONFIG`,
keep a `.bak` of what could not be parsed, and report it on the diagnostics panel.

### 9.4 `binary.ts`

The SDK resolves its CLI by `require.resolve` relative to its own `sdk.mjs`, which under asar
returns a path inside `app.asar`. `existsSync` returns true there (Electron patches fs) but
**`spawn` cannot execute it**: Electron's asar documentation says only `execFile` works for
binaries inside an archive, and the SDK uses `spawn`.

```ts
export function claudeBinaryPath(): string {
  const require = createRequire(import.meta.url);
  let p = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  if (!existsSync(p)) throw new Error(`Claude binary missing at ${p}`);
  return p;
}
```

Assert at startup that it exists and is executable, and add the same as a doctor check. The
failure otherwise surfaces once per turn in Slack instead of once at launch. In dev, the SDK's
own resolution already works, so `claudeExecutablePath` may be left undefined.

### 9.5 `ipc.ts`

Implement every `IPC.*` channel with `ipcMain.handle`. **Every handler verifies
`event.sender === mainWindow.webContents` before acting.** These handlers hold Slack tokens and
can start an agent that runs shell commands, so the sender check matters more than usual.

Errors cross as `Result<T>`, never as thrown custom errors: `contextBridge` drops custom `Error`
properties, class prototypes and Symbols.

Guard every main-to-renderer send with a null check **and** `!win.isDestroyed()`, because in this
app the window genuinely does not exist most of the time.

### 9.6 `window.ts`, `tray.ts`, `theme.ts`, `autostart.ts`, `notify.ts`

`window.ts` creates the window per §10.2 and reports focus and blur into `theme.ts`.

```ts
win.on('close', (e) => {                 // hide, do not quit
  if (isQuitting) return;
  e.preventDefault(); win.hide();
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
});
app.on('window-all-closed', () => { /* deliberately empty */ });
```

**`window-all-closed` must be subscribed even though the body is empty.** If you do not subscribe,
the default behaviour quits the app, so closing the settings window would kill the Slack bridge.

Prefer `app.setActivationPolicy('accessory' | 'regular')` over `app.dock.hide()`: the docs record
that `hide()` within one second of a previous call does nothing, and show/hide of a settings
window is exactly that sub-second pattern.

`tray.ts`: template images, so the filename **must** end in `Template` (`trayTemplate.png` 16x16
and `trayTemplate@2x.png` 32x32) for automatic light and dark inversion. Menu: status line,
Open dashboard, Pause / Resume, Open logs, Quit. Keep `tray` at module scope; a dropped reference
gets garbage collected and the icon vanishes.

`theme.ts`: build `ThemeState` from `nativeTheme.shouldUseDarkColors`, `app.themeMode`,
`systemPreferences.getAccentColor()` (remember: **RGBA**, take the first 6 hex digits) and window
focus. Push on `IPC_EVENTS.theme` from `nativeTheme`'s `updated` event, from accent changes, and
on focus and blur.

`autostart.ts`: `app.setLoginItemSettings({ openAtLogin })`, read back with
`getLoginItemSettings()`. Three rules:

- **Do not use `openAsHidden`.** It is deprecated and does not work on macOS 13 and up; this
  machine is macOS 26.5. Start hidden by branching on `wasOpenedAtLogin` instead.
- **Read `status`, not just `openAtLogin`.** On macOS 13+ this is `SMAppService`-backed and the
  user can deny the item in System Settings. `requires-approval` is the state where the app
  thinks it is enabled but macOS will not honour it, and a toggle reading only `openAtLogin`
  will lie.
- Gate the toggle on `app.isPackaged`. Verified: unpackaged, `status` is `'not-found'`, and
  registering would register the Electron helper binary rather than the app.

Quiet start: `app.isPackaged && getLoginItemSettings().wasOpenedAtLogin` means tray only, no
window. **Except** on first run or when setup is incomplete, where the window is always forced
open; otherwise a misconfigured login-item launch is invisible and silent.

### 9.7 `migrate.ts`

Two migrations on first launch, both idempotent:

1. `.env` to `config.json`, offered on the welcome step. Parse it with a small hand-rolled reader
   (`dotenv` is deliberately not a dependency): split on the first `=`, ignore blank lines and
   `#` comments, strip matching surrounding quotes. `PROJECT_DIR`/`PROJECT_NAME` become the first
   project with alias `slugify(basename(PROJECT_DIR))`, shown for edit. Tokens are read, verified,
   then encrypted. **Leave the source `.env` alone** and tell the operator to delete it.
2. `.state/threads.json` into SQLite, per §5.5.

### 9.8 `diagnostics.ts` and `headless.ts`

`headless.ts` runs `--doctor` and `--selftest` without a window and calls `app.exit(code)`.

One check that no earlier analysis included and that matters here: **the legacy launchd job.** If
`com.slackcode.daemon` is still loaded, the old headless daemon and the Electron app both connect
to Socket Mode, and the single-instance lock will **not** catch it because they are different
programs. Slack load-balances events across connections, so roughly half the DMs would go to the
daemon and vanish. Check `launchctl list` for `com.slackcode.daemon`, warn loudly, and tell the
operator to `launchctl bootout` it.

### 9.9 Sleep and network

`powerMonitor.on('resume')` forces a catch-up sweep. Socket Mode's `authenticated` event usually
covers a reconnect, but a laptop lid closed for eight hours is exactly the case the cursor logic
exists for, and the extra sweep costs one API call.

### 9.10 `handshake.ts`

The wizard's live Socket Mode handshake (§12 step 5). Opens a temporary connection, waits for the
operator to DM a code word, then **closes the socket** before setup continues. On success it also
writes the channel cursor to that message's `ts`, so the daemon's first catch-up has an explicit
baseline instead of replaying history.

---

## 10. The UI (implementers c, d, e)

### 10.1 The honest ceiling

**Electron cannot render real macOS Liquid Glass.** `NSGlassEffectView` is AppKit and SwiftUI
only and is not exposed to Electron. **Do not claim otherwise in code comments, in the UI, in
commit messages, or in the README.**

What is reachable, and what we use, all four verified by execution:

1. **Native window vibrancy**: `vibrancy` plus `visualEffectState` on `BrowserWindow`.
2. **Native traffic lights over our own chrome**: `titleBarStyle: 'hiddenInset'`.
3. **CSS `backdrop-filter`** for layered glass surfaces inside the window, over the native
   vibrancy underneath.
4. **`nativeTheme` and the system accent colour** driving the token set.

The result is a convincing, native-feeling translucent macOS app. It is not Liquid Glass.

### 10.2 The window (owned by b, specified here so c/d/e can rely on it)

```ts
new BrowserWindow({
  width: 980, height: 700, minWidth: 820, minHeight: 560,
  show: false,
  titleBarStyle: 'hiddenInset',
  vibrancy: 'under-window',        // electron.d.ts:4047
  visualEffectState: 'active',     // electron.d.ts:4054, so blur does not grey out when unfocused
  backgroundColor: '#00000000',    // fully transparent, or the vibrancy never shows through
  webPreferences: {
    preload: <out/preload/index.cjs>,
    contextIsolation: true, nodeIntegration: false, sandbox: true,
  },
});
```

Show on `ready-to-show` to avoid a white flash. When `app.vibrancy` is false, omit `vibrancy` and
`visualEffectState` and use an opaque `backgroundColor`; `ThemeState.vibrancy` tells the renderer
which mode it is in so the CSS can compensate.

### 10.3 Theme plumbing

`shell.ts` (e) subscribes to `api.onTheme` and sets on `document.documentElement`:

```
data-theme      = "light" | "dark"
data-vibrancy   = "on" | "off"
data-focus      = "on" | "off"
data-motion     = "full" | "reduced"
style.setProperty('--accent', theme.accentHex)
```

Every rule in the stylesheet keys off those attributes. (c) and (d) never read theme state
directly; they just use the tokens.

### 10.4 The CSS contract (owned by e, consumed by c and d)

**(c) and (d) ship no CSS files.** They write markup against these class names. Anything missing
is a request to (e).

*Tokens* (defined for light and dark):
`--bg`, `--bg-elevated`, `--glass-bg`, `--glass-stroke`, `--glass-highlight`, `--text`,
`--text-dim`, `--text-faint`, `--accent`, `--accent-contrast`, `--ok`, `--warn`, `--bad`,
`--hairline`, `--radius-sm`, `--radius`, `--radius-lg`, `--gap`, `--shadow`.

*Layout*: `.app-shell`, `.titlebar` (carries `-webkit-app-region: drag`), `.titlebar-actions`
(**must** set `-webkit-app-region: no-drag`, or every control in the title bar becomes
unclickable), `.sidebar`, `.sidebar-nav`, `.nav-item` (selected via `aria-current="page"`),
`.detail`, `.detail-header`, `.detail-body`, `.row`, `.stack`, `.spread`.

*Surfaces*: `.glass`, `.card`, `.card-header`, `.card-body`, `.card-footer`, `.hairline`.

*Controls*: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn[disabled]`, `.switch`
(a real switch, not a checkbox), `.segmented` and `.segmented-option` (exclusive choices),
`.field`, `.field-label`, `.field-hint`, `.field-error`, `.input`, `.input-mono`, `.select`,
`.textarea`, `.chip`, `.chip-ok`, `.chip-bad`, `.chip-pending`.

*Status and data*: `.pill`, `.pill-ok`, `.pill-warn`, `.pill-bad`, `.pill-idle`, `.spinner`,
`.table`, `.table-empty`, `.empty-state`, `.log-line`, `.log-level-{debug,info,warn,error}`,
`.kbd`, `.code`.

*Wizard*: `.wizard`, `.wizard-rail`, `.wizard-step`, `.wizard-step[data-state]`
(`todo` / `current` / `done` / `error`), `.wizard-body`, `.wizard-footer`.

Rules (e) must honour:

- System typography only: `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`.
  **Ship no webfont and link no webfont.**
- Hairlines via `color-mix(in srgb, currentColor 12%, transparent)` rather than hard greys, so
  they read correctly in both themes.
- Concentric radii: an inner radius is the outer radius minus its padding, never a random value.
- A soft specular highlight on the top edge of glass surfaces (a 1px inset light border),
  which is what sells the material.
- Restrained colour: the accent does the work, everything else stays neutral.
- Motion is short and eased, and **every transition is disabled under
  `[data-motion="reduced"]`**, which is set from both the OS setting and the in-app toggle.
- Wide content (tables, log lines, paths) scrolls inside its own `overflow-x: auto` container.
  The window body must never scroll horizontally.
- **Accessibility is not optional**: visible focus rings on every interactive element, real
  contrast in both themes, and every control reachable by keyboard.
- Verify all three states before calling it done: **light, dark, and unfocused.**

### 10.5 Scope discipline

This is a utility app the user glances at, not a landing page. No hero sections, no decorative
illustration, no animated gradients. Every pixel does a job. A small hand-written token layer,
not a component library.

---

## 11. Must-not-regress checklist

Verify each of these explicitly before calling the port done. They are already built, tested and
working, and a porting agent will be tempted to tidy them.

1. **Messages queue at turn boundaries, never mid-turn.** The streaming-input generator refuses
   to yield until the previous turn emits a result. The `!this.idle` term in `waitForWork` and
   `this.idle = false` in `input()` **are** the guarantee.
2. **A burst of Slack messages merges into ONE user turn**, via `splice(0, pending.length)` and
   `join('\n\n')`.
3. **`query.interrupt()` is only ever reached from the stall watchdog.** It is the only
   `interrupt()` in the codebase. Never use it for a user message. `!cancel` drops queued
   messages only and must not touch the running turn.
4. **The stall watchdog resets a turn silent for `turnStallMinutes`**, with the deadline sliding
   on real progress, so a thread is never left permanently deaf.
5. **The reconnect catch-up sweep replays missed DMs, bounded by a persisted per-channel cursor
   seeded to `now` on first sight.** Without the cursor, a restart re-runs a day of old turns
   under `bypassPermissions`. This was a real bug. The cursor moves to SQLite and must never move
   backwards (§5.4).
6. **Turn end deletes the live status message and posts the answer as a NEW message** with a
   receipt footer. Deliberate: Slack does not push-notify an edit. Do not "optimise" it into an
   update.
7. **The allowlist is enforced before anything else, and the service refuses to start if it
   resolves to nobody.** Now it refuses to *serve*, showing the reason in the UI, rather than
   exiting the process.
8. **`Options.env` is never set**, so the agent inherits `HOME`, `USER` and `LOGNAME` and
   Keychain auth works.
9. **Session eviction on idle** continues to work, and `close()` now also aborts the in-flight
   turn on force.

---

## 12. The setup wizard (implementer c)

Ten steps. Non-secret answers persist to a draft after each step; verified tokens go into the
secret store the moment they pass. Quitting mid-wizard resumes at the last incomplete step.
`SETUP_BLOCKING_STEPS` cannot be advanced past without a green check; `handshake` and `probe`
allow Skip with a persistent dashboard warning.

| # | Step | Asks | Validates |
|---|---|---|---|
| 0 | welcome | nothing | detects `.env` and offers import |
| 1 | slackApp | nothing | **Copy app manifest** button plus a link to create the app from it |
| 2 | botToken | `xoxb-…`, masked | prefix, then `checkBotToken`; shows team and bot name |
| 3 | appToken | `xapp-…`, masked | prefix, then `checkAppToken` |
| 4 | operators | Slack identities as chips | `checkAllowlist`; **cannot advance with zero resolved** |
| 5 | handshake | DM a code word to the bot | live Socket Mode; the one failure `doctor()` structurally cannot see |
| 6 | project | folder picker, alias, name, overrides | `checkProjectDir`, live `validateAlias` |
| 7 | agent | model, effort, permission mode, cost ceiling | union membership; **no preselected permission mode** |
| 8 | probe | nothing | `checkUserIdentity`, `checkShellPath`, `checkClaudeBinary`, `checkClaudeAuth` |
| 9 | finish | run at login, menu bar vs dock, connect on launch | full review plus **Run all checks** |

Step 1 is the highest-value screen in the whole app. `message.im` not being subscribed is the one
failure the API cannot report, and it produces the classic "starts fine, DMs never arrive" bug.
The manifest makes it unmissable:

```yaml
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events: [message.im]
oauth_config:
  scopes:
    bot: [im:history, im:read, im:write, chat:write, reactions:write, users:read]
```

Error text must be specific, mapping the raw Slack error to an action: `invalid_auth` to "revoked
or from a different workspace, reinstall and copy the Bot User OAuth Token again";
`not_allowed_token_type` to "that is not an app-level token, generate one under Basic Information
with `connections:write`"; `missing_scope` naming the scope. Distinguish a network failure from a
rejected token, and offer Retry.

Choosing `bypassPermissions` opens a consequences sheet: unrestricted Bash in every project
directory, no approval prompts, nobody watching.

---

## 13. The dashboard (implementer d)

Sidebar plus detail, the standard macOS utility-app shape.

**Status bar**, always visible: three pills with timestamps. Slack (`connected` / `reconnecting`
/ `disconnected` / `stopped by you`, and the last is not a fault, so it is not red), Claude
(account and last verified), Operators (resolved chips, amber on any unresolved entry). Plus one
unambiguous Start/Stop button, with Restart in an overflow.

**Active threads**: project, operator, state, current activity, elapsed, turns, cost. Fed by
`DaemonStatus.activeThreads`, repainted from `snapshot()` on open and from `onStatus` after.
Row actions: Open in Slack (`slack://channel?team=…&id=…&message=…`), Reveal folder, Reset thread,
Cancel queued.

**Recent turns**: from `api.recentTurns()`, which is a SQLite query, so filtering by project and
"failures only" is cheap and should be offered. Failed turns are the ones you actually open.

**Spend**: today and last 7 days, total and per project, from `api.spendSummary()`. A number, not
a chart. Show turns that hit `maxTurnBudgetUsd`.

**Problems feed**: unresolved allowlist entries, socket drops, stalls, failed posts, rate limits,
`Not logged in`. Each with a timestamp and a fix hint. The empty state is a single green line,
which is the point.

**Logs**: live tail via `onLog`, backfilled from `logTail()`, filterable through `queryLogs()`.
Already redacted at the source. Reveal in Finder, and Copy Diagnostics that bundles check results
plus the last 200 redacted lines.

**Projects and Settings** panes: add, edit, remove, reorder, live alias validation, per-project
overrides, and every tuning value with the ranges from `TUNING_RANGES`.

Native notifications on turn failure, on a disconnect longer than 60s, and on a stall reset.
Clicking one opens the thread in Slack.

---

## 14. Build configuration (implementer e)

### `electron.vite.config.ts`

electron-vite's defaults already match the conventional layout (`src/main/index.ts`,
`src/preload/index.ts`, `src/renderer/index.html`, output `out/`), so no entry paths are needed.

```ts
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: { rollupOptions: { output: { format: 'es', entryFileNames: '[name].mjs' } } },
  },
  preload: {
    // CJS on purpose: sandbox: true forbids an ESM preload.
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {},
});
```

- **Do not add `externalizeDepsPlugin`** (correction C1). Dependencies are externalised by
  default. This matters: `@anthropic-ai/claude-agent-sdk` must not be bundled, because it
  resolves its native binary relative to its own `import.meta.url`.
- Format and `entryFileNames` are set explicitly rather than inferred, so `package.json#main`
  is deterministic.

**Why main is ESM and preload is CJS**, and it is not a style choice: the agent SDK is ESM-only,
so a CJS main could not import it. Electron then requires that an ESM preload use `.mjs`, and
separately that sandboxed preloads run as plain non-ESM JavaScript. Sandbox has been on by
default since Electron 20 and we keep it on. Therefore: **main ESM, preload CJS**. Emitting
`.cjs` also stops `"type": "module"` reinterpreting it.

The sandboxed preload gets a polyfilled `require` and cannot be split across files, which is a
second reason a bundler is mandatory here and plain `tsc` is not an option.

`__dirname` does not exist in `out/main/index.mjs`. Use
`fileURLToPath(new URL('.', import.meta.url))`.

### tsconfigs

Three files: a root base plus `tsconfig.node.json` (main, preload, shared) and
`tsconfig.web.json` (renderer, shared). Vite transpiles with esbuild, so TypeScript is a pure
checker: `noEmit: true` everywhere, and drop `outDir` and `rootDir`.

**Four options are mandatory, each proven necessary:**

| Option | Why |
|---|---|
| `skipLibCheck: true` | without it the SDK's transitive `@modelcontextprotocol/sdk` fails with `Cannot find name 'HeadersInit'` |
| `allowImportingTsExtensions: true` | required by the `.ts` import convention (§3.4), else `TS5097` |
| `strict: true` | keep it |
| `verbatimModuleSyntax: true` | Node's type stripping needs `import type` to be explicit |

`tsconfig.node.json` uses `lib: ["ES2022"]` and `types: ["node", "electron"]`.
`tsconfig.web.json` uses `lib: ["ES2022", "DOM", "DOM.Iterable"]` and `types: []`.
Both include `src/shared/**`.

### `electron-builder.yml`

```yaml
appId: io.github.shanto462.slackcode
productName: slack-code
directories: { output: release, buildResources: build }
files: [out/**, package.json]
asar: true
asarUnpack:
  - "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**"
mac:
  category: public.app-category.developer-tools
  target: dir
  identity: null          # ad-hoc signature, no Developer ID
extraResources:
  - build/trayTemplate.png
  - build/trayTemplate@2x.png
```

- Development dependencies are never included, and production `node_modules` always are, so the
  three runtime deps and the matching native binary ship automatically while `electron` does not.
- Only the `darwin-arm64` optional dependency is installed here, so one 317 MB binary ships, not
  eight.
- `asarUnpack` is what makes §9.4's path rewrite work. Do not rely on automatic executable
  detection.
- **No `install-app-deps` or `electron-rebuild` step.** There are no native modules, by design.

Unsigned build consequences, stated honestly: a locally built `.app` is not quarantined so
Gatekeeper is not an issue; ad-hoc signing still happens and is required on Apple Silicon; the
signature changes on every rebuild, so expect to re-approve the login item and expect
`safeStorage` ciphertext to occasionally need re-entry (§6.2 rules 4 and 5); there is no
auto-update; and the bundle lands around 600 MB, which is why the target is `dir` rather than a
DMG.

### Also owned by (e)

`build/trayTemplate.png` and `@2x` (template images, §9.6), an app icon, `.gitignore` updated for
`out/` and `release/`, and deletion of `com.slackcode.daemon.plist` and `dist/`.

---

## 15. Verification

Nobody calls their part done on inspection. The real checks:

| Level | Command | Who |
|---|---|---|
| types | `npm run typecheck` | all |
| routing unit tests | `npm test` | (a) writes them, all run them |
| headless checks | `npm run doctor` | (a) and (b) |
| end to end | `npm run selftest` | (b) |
| account probe | `npm run whoami` | unchanged |
| packaged build | `npm run dist`, then launch the `.app` | (e) |

`npm test` runs `node --experimental-strip-types --test "src/core/**/*.test.ts"` with zero extra
dependencies. **(a) must cover the full routing table**: every rule R0 to R7, the bound-thread
case where the first line coincidentally equals an alias, alias normalisation of mobile
zero-width and non-breaking-space input, cursor monotonicity, and the legacy import binding
threads by `cwd`. Routing is the riskiest new logic in the port and it is pure, so there is no
excuse for not testing it.

Two things cannot be verified from a terminal and need the user to drive the real app: anything
behind `app.whenReady()` in an interactive session, and the packaged-build behaviours (login
item registration, `safeStorage` across a rebuild, and the asar binary path). Say so plainly
rather than claiming a green result you did not see.
