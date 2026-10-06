/**
 * slack-code shared contract.
 *
 * THE SINGLE SOURCE OF TRUTH. Imported by src/core, src/main, src/preload and
 * src/renderer. If you need a type that describes something crossing a module
 * boundary, it belongs here and nowhere else. Do not redeclare these shapes
 * locally, and do not widen them with `any` at a call site.
 *
 * HARD RULES FOR THIS FILE
 * 1. Zero runtime imports. The only import is `import type` from the Agent SDK,
 *    which TypeScript erases completely, so this file is safe to bundle into the
 *    sandboxed renderer where node_modules does not exist at runtime.
 * 2. Everything exported as a value must be a plain constant or a pure function
 *    with no I/O, no timers and no platform APIs. The wizard validates aliases
 *    in the renderer with the exact same code the router uses in core; that is
 *    the point.
 * 3. Only structured-clonable data crosses IPC. contextBridge drops Symbols,
 *    class prototypes and custom Error properties, so every payload here is a
 *    plain object, array or primitive. Failures travel as `Result<T>`, never as
 *    a thrown custom error.
 */

import type {
  EffortLevel as SdkEffortLevel,
  PermissionMode as SdkPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Agent enums, declared locally and pinned to the SDK at compile time
// ---------------------------------------------------------------------------

/** Verified against @anthropic-ai/claude-agent-sdk 0.3.236 sdk.d.ts:2193. */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

/** Verified against @anthropic-ai/claude-agent-sdk 0.3.236 sdk.d.ts:576. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Compile-time drift guard. If a future SDK bump adds or removes a permission
 * mode or effort level, `npm run typecheck` fails here instead of failing at
 * runtime inside a turn. These are type aliases, so nothing is emitted.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type _AssertPermissionMode = AssertTrue<Exact<PermissionMode, SdkPermissionMode>>;
type _AssertEffortLevel = AssertTrue<Exact<EffortLevel, SdkEffortLevel>>;

/** Human labels for the permission picker. Keep the wording; it is a real authority grant. */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, { title: string; blurb: string; risky: boolean }> = {
  bypassPermissions: {
    title: 'Bypass permissions',
    blurb: 'Never asks. Full tool use including Bash, unattended, in every project directory.',
    risky: true,
  },
  auto: { title: 'Auto', blurb: 'The agent decides when to ask. Rarely blocks.', risky: false },
  acceptEdits: { title: 'Accept edits', blurb: 'File edits go through automatically, other tools still ask.', risky: false },
  dontAsk: { title: 'Do not ask', blurb: 'Suppresses prompts without granting bypass-level tool access.', risky: false },
  plan: { title: 'Plan only', blurb: 'Read and reason, never modify. Useful for a sensitive repo.', risky: false },
  default: { title: 'Default', blurb: 'Standard Claude Code prompting behaviour.', risky: false },
};

// ---------------------------------------------------------------------------
// Result and generic plumbing
// ---------------------------------------------------------------------------

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: string, code?: string): Result<T> {
  return code === undefined ? { ok: false, error } : { ok: false, error, code };
}

export interface FieldIssue {
  field: string;
  message: string;
}

/**
 * Validation collects EVERY problem rather than throwing on the first one.
 * The old ConfigError threw on the first bad field, which is wrong for a wizard
 * that wants to light up all the broken inputs at once.
 */
export interface ValidationReport {
  ok: boolean;
  issues: FieldIssue[];
  /** Values that were out of range and were clamped rather than rejected. */
  clamped: FieldIssue[];
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** `prj_` + 12 lowercase hex. Opaque, permanent, never derived from the alias. */
export type ProjectId = string;

export interface ProjectConfig {
  id: ProjectId;
  /** Canonical routing key. Always stored already lowercased and validated. */
  alias: string;
  /** Optional extra routing keys, e.g. "w" for "writings". Same grammar as `alias`. */
  aliases: string[];
  /** Display name. Defaults to the directory basename. */
  name: string;
  /** Absolute, tilde already expanded, verified to be a directory when added. */
  dir: string;
  /** False means configured but paused. Routing answers with a distinct message. */
  enabled: boolean;
  /** Per-project overrides. `undefined` inherits from AgentDefaults. */
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  /** Maps to Options.additionalDirectories (sdk.d.ts:1379). */
  additionalDirectories?: string[];
  createdAt: string;
}

/** A project with every override already merged over the defaults. Sessions consume ONLY this. */
export interface ResolvedProject {
  id: ProjectId;
  alias: string;
  name: string;
  dir: string;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  additionalDirectories?: string[];
}

// ---------------------------------------------------------------------------
// Slack settings
// ---------------------------------------------------------------------------

export interface ResolvedUser {
  id: string;
  name: string;
}

export interface AllowedUser {
  /** Exactly what the operator typed or picked. Kept so a failed lookup can be shown back to them. */
  entry: string;
  id?: string;
  name?: string;
  resolvedAt?: string;
}

export interface SlackIdentity {
  botUserId: string;
  botName: string;
  teamId: string;
  teamName: string;
}

/** One row of the wizard's user picker. */
export interface SlackWorkspaceUser {
  id: string;
  name: string;
  realName: string;
  displayName: string;
  isBot: boolean;
  deleted: boolean;
  avatar?: string;
}

export interface AllowlistResolution {
  resolved: ResolvedUser[];
  unresolved: string[];
}

export interface SlackSettings {
  allowed: AllowedUser[];
  workspace?: SlackIdentity;
  /** Set by the wizard's live handshake step. Absence is a dashboard warning, not a failure. */
  eventsVerifiedAt?: string;
}

// ---------------------------------------------------------------------------
// Defaults, routing, tuning, app behaviour
// ---------------------------------------------------------------------------

export interface AgentDefaults {
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
}

export interface RoutingSettings {
  /**
   * Explicit fallback when the first line matches no alias. Unset by default,
   * because the product requirement is an explicit error listing valid aliases.
   */
  defaultProjectId?: ProjectId;
  /**
   * When exactly one project is enabled, route an unrecognised first line to it
   * instead of erroring. Preserves the pre-Electron single-project behaviour.
   */
  singleProjectFallback: boolean;
  /**
   * Slack desktop sends on Enter, so an operator often sends the alias and the
   * prompt as two separate top-level messages. After a bind-only message, the
   * next unbound top-level message in that channel inherits the binding for
   * this many minutes. 0 disables the heuristic entirely.
   */
  pendingBindMinutes: number;
  /** On an unbound reply, read the thread parent once to recover a lost binding. */
  recoverBindingFromParent: boolean;
}

export interface TuningSettings {
  sessionIdleMinutes: number;
  turnStallMinutes: number;
  catchupWindowHours: number;
  statusUpdateMs: number;
  /**
   * Enables Options.includePartialMessages so streamed partials refresh the
   * stall watchdog's progress timestamp. Without it a long extended-thinking
   * block reads as silence and a healthy turn can be reset.
   */
  streamProgressHeartbeat: boolean;
}

export interface AppSettings {
  runAtLogin: boolean;
  connectOnLaunch: boolean;
  menuBarOnly: boolean;
  notifyOnTurnFailure: boolean;
  notifyOnDisconnect: boolean;
  notifyOnStall: boolean;
  debugLogging: boolean;
  /** 'system' follows nativeTheme; the other two pin it. */
  themeMode: ThemeMode;
  /**
   * Native window vibrancy. Off gives an opaque window, which is the escape
   * hatch if translucency ever hurts legibility or performance.
   */
  vibrancy: boolean;
  /** Honour the OS "Reduce motion" setting AND allow forcing it on. */
  reduceMotion: boolean;
}

// ---------------------------------------------------------------------------
// Persisted config
// ---------------------------------------------------------------------------

export const CONFIG_SCHEMA_VERSION = 1;

/**
 * userData/config.json. Contains NO secrets, so it is safe to read, back up, or
 * paste into a bug report. Tokens live in StoredSecrets.
 */
export interface StoredConfig {
  schemaVersion: number;
  setupCompletedAt?: string;
  slack: SlackSettings;
  agent: AgentDefaults;
  projects: ProjectConfig[];
  routing: RoutingSettings;
  tuning: TuningSettings;
  app: AppSettings;
}

/**
 * userData/secrets.json, mode 0600. Values are base64 of safeStorage
 * ciphertext. Plaintext never touches this file and never reaches the renderer.
 */
export interface StoredSecrets {
  schemaVersion: number;
  slackBotToken?: string;
  slackAppToken?: string;
}

export interface SecretPresence {
  present: boolean;
  /** Redacted display form, e.g. "xoxb-…f2a9". Never the full token. */
  hint?: string;
}

export interface SecretsStatus {
  encryptionAvailable: boolean;
  /** False when safeStorage is unavailable. The UI must refuse to persist, not fall back to plaintext. */
  writable: boolean;
  bot: SecretPresence;
  app: SecretPresence;
}

export const DEFAULT_CONFIG: StoredConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  slack: { allowed: [] },
  agent: {
    model: 'claude-opus-5',
    effort: 'max',
    // The wizard preselects nothing and forces a deliberate choice. This value
    // is only what a missing or corrupted field falls back to, so it lands on
    // the safer option rather than on bypassPermissions.
    permissionMode: 'acceptEdits',
  },
  projects: [],
  routing: {
    singleProjectFallback: true,
    pendingBindMinutes: 5,
    recoverBindingFromParent: true,
  },
  tuning: {
    sessionIdleMinutes: 120,
    turnStallMinutes: 10,
    catchupWindowHours: 24,
    statusUpdateMs: 2000,
    streamProgressHeartbeat: true,
  },
  app: {
    runAtLogin: false,
    connectOnLaunch: true,
    menuBarOnly: true,
    notifyOnTurnFailure: true,
    notifyOnDisconnect: true,
    notifyOnStall: true,
    debugLogging: false,
    themeMode: 'system',
    vibrancy: true,
    reduceMotion: false,
  },
};

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * HONEST CEILING, and this wording must not be softened anywhere in the code,
 * the UI or the docs: Electron CANNOT render real macOS Liquid Glass.
 * `NSGlassEffectView` is AppKit/SwiftUI only and is not exposed to Electron.
 *
 * What is genuinely reachable, and what this app uses:
 *   1. Native window vibrancy   -> BrowserWindow `vibrancy` + `visualEffectState`
 *   2. Native traffic lights    -> `titleBarStyle: 'hiddenInset'`
 *   3. CSS backdrop-filter      -> layered glass surfaces INSIDE the window
 *   4. nativeTheme + accent     -> colour tokens that follow the system
 *
 * The result is a convincing, native-feeling translucent app. It is not
 * Liquid Glass, and nothing should claim it is.
 */
export interface ThemeState {
  /** Resolved from themeMode plus nativeTheme.shouldUseDarkColors. */
  dark: boolean;
  mode: ThemeMode;
  /**
   * From systemPreferences.getAccentColor(). VERIFIED to return 8 hex digits
   * as RGBA with NO leading `#`, e.g. "007AFFFF". Take the first 6 for a CSS
   * colour; do not paste all 8 into `#…` or the alpha silently changes it.
   */
  accentRgba: string;
  /** `#` + the first 6 characters of accentRgba, ready for CSS. */
  accentHex: string;
  /** True when the OS asks for reduced motion, or the user forced it in settings. */
  reduceMotion: boolean;
  /** True when window vibrancy is actually active, so CSS can lighten its own blur. */
  vibrancy: boolean;
  /** Vibrancy greys out on an unfocused window unless visualEffectState is 'active'. */
  windowFocused: boolean;
}

/**
 * Verified against node_modules/electron/electron.d.ts:4047. The BrowserWindow
 * constructor accepts all of these; note that `win.setVibrancy()` (line 3567)
 * accepts the same list MINUS the deprecated 'appearance-based'.
 */
export const VIBRANCY_MATERIALS = [
  'titlebar',
  'selection',
  'menu',
  'popover',
  'sidebar',
  'header',
  'sheet',
  'window',
  'hud',
  'fullscreen-ui',
  'tooltip',
  'content',
  'under-window',
  'under-page',
] as const;

export type VibrancyMaterial = (typeof VIBRANCY_MATERIALS)[number];

/**
 * The material for the main window. 'under-window' is the one that reads as a
 * desktop-app sidebar behind translucent content, and it is what the standard
 * macOS utility-app shape uses. Pair with `visualEffectState: 'active'`
 * (electron.d.ts:4054) so the blur does not go flat when the window loses focus,
 * and with a fully transparent backgroundColor so it shows through at all.
 */
export const WINDOW_VIBRANCY: VibrancyMaterial = 'under-window';

/** Inclusive [min, max] for every numeric setting. Out-of-range values are clamped and reported, never rejected. */
export const TUNING_RANGES = {
  sessionIdleMinutes: [5, 1440],
  turnStallMinutes: [2, 180],
  catchupWindowHours: [1, 168],
  /** Floor is Slack's tier-3 chat.update budget. Going below it gets the app rate limited. */
  statusUpdateMs: [1200, 30000],
  pendingBindMinutes: [0, 120],
} as const satisfies Record<string, readonly [number, number]>;

export function clampToRange(value: number, range: readonly [number, number]): number {
  if (!Number.isFinite(value)) return range[0];
  return Math.min(range[1], Math.max(range[0], value));
}

// ---------------------------------------------------------------------------
// Runtime config: what the service actually runs on
// ---------------------------------------------------------------------------

/**
 * Built once by main from StoredConfig + decrypted secrets, then handed to the
 * service. Sessions never see StoredConfig.
 *
 * NOTE ON `tuning`: hold this object by REFERENCE, never copy the numbers into
 * session fields. The status throttle and the stall watchdog read it fresh on
 * every tick, so a slider change hot-applies to running sessions for free.
 */
export interface RuntimeConfig {
  /** Decrypted. Main-process memory only. Must never be logged, serialised or sent over IPC. */
  botToken: string;
  appToken: string;
  allowedUserIds: string[];
  allowedUsers: ResolvedUser[];
  projects: ResolvedProject[];
  /** alias and every entry of `aliases`, all lowercased, pointing at the resolved project. */
  byAlias: Map<string, ResolvedProject>;
  byId: Map<ProjectId, ResolvedProject>;
  defaultProject?: ResolvedProject;
  routing: RoutingSettings;
  tuning: TuningSettings;
  /** Absolute path to userData/state. Injected; never derived from import.meta.url. */
  stateDir: string;
  /**
   * Absolute path to the unpacked native CLI. Passed as
   * Options.pathToClaudeCodeExecutable (sdk.d.ts:1777) because the SDK's own
   * resolution returns a path inside app.asar, which spawn cannot execute.
   * Undefined in dev, where the SDK's default resolution already works.
   */
  claudeExecutablePath?: string;
}

// ---------------------------------------------------------------------------
// Thread store
// ---------------------------------------------------------------------------

export const STORE_SCHEMA_VERSION = 2;

export interface ThreadRecord {
  /** Claude Code session id, so a reply days later resumes the same conversation. */
  sessionId: string;
  /**
   * The project directory at bind time. Kept even though projectId exists: a
   * mismatch against the project's current dir means the project moved, which
   * is worth surfacing rather than silently resuming in the wrong place.
   */
  cwd: string;
  slackUserId: string;
  createdAt: string;
  lastActiveAt: string;
  turns: number;
  costUsd: number;
  /** null means the thread has been seen but is not yet bound to a project. */
  projectId: ProjectId | null;
  /** Denormalised for display and error text. `projectId` always wins on conflict. */
  alias: string | null;
  /** Set when an unknown-alias error was already posted, so a burst produces one error, not three. */
  rejectedNotifiedAt?: string;
  /** Set when the bound project vanished from config and the thread was told once. */
  orphanNotifiedAt?: string;
}

/**
 * The shape of the LEGACY `.state/threads.json` file, kept only so the one-time
 * import can read it. Nothing writes this format any more: threads and cursors
 * now live in SQLite. See the Storage section below.
 */
export interface LegacyStoreSnapshot {
  version?: number;
  threads: Record<string, ThreadRecord>;
  /** Highest Slack ts already handled, per channel. Bounds the catch-up sweep. */
  cursors: Record<string, string>;
}

export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Storage is split by access pattern, deliberately, three ways:
 *
 *   SQLite      threads, cursors, turns, log lines. Append-heavy, unbounded,
 *               and the dashboard wants to QUERY it (recent turns, filtered
 *               logs). Uses the BUILT-IN `node:sqlite`
 *               module, so there is no native module and no electron-rebuild
 *               step on an Electron upgrade.
 *   safeStorage  the two Slack tokens, and nothing else.
 *   JSON        settings and the project registry, in userData/config.json.
 *               Tiny, read once at boot, and worth keeping hand-editable and
 *               eyeball-able. Burying six fields in a binary database costs
 *               more than it gains.
 *
 * VERIFIED on this machine, in the real Electron 43.4.1 main process:
 *   `node:sqlite` imports and exports DatabaseSync, StatementSync, Session,
 *   backup, constants. Bundled SQLite is 3.53.1 (Node 24.18.1). On a FILE
 *   database `PRAGMA journal_mode=WAL` returns "wal". Explicit BEGIN/COMMIT,
 *   `PRAGMA user_version` read and write, named parameters (`:a`) and
 *   `INSERT ... RETURNING` all work. So better-sqlite3 is NOT needed and must
 *   not be added.
 */
export const DB_SCHEMA_VERSION = 2;

/** File name inside userData/state. */
export const DB_FILENAME = 'slack-code.db';

/** One row of the `turns` table. This is what the dashboard's history views read. */
export interface TurnRow {
  id: number;
  channel: string;
  threadTs: string;
  projectId: ProjectId | null;
  alias: string | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  toolCount: number;
  costUsd: number;
  failed: boolean;
  /** result subtype, e.g. 'success' or 'error_max_turns'. */
  subtype: string;
  error?: string;
  /** First line of the prompt, already truncated and redacted. */
  preview: string;
}

/** One row of the `logs` table. Mirrors LogLine plus an id for paging. */
export interface LogRow extends LogLine {
  id: number;
}

/** Filters for the dashboard's log pane. All fields are optional and AND-ed together. */
export interface LogQuery {
  level?: LogLevel;
  scope?: string;
  /** Case-insensitive substring match against the message. */
  search?: string;
  since?: number;
  limit?: number;
  /** Page backwards: return rows with id < before. */
  before?: number;
}

export interface TurnQuery {
  projectId?: ProjectId;
  failedOnly?: boolean;
  since?: number;
  limit?: number;
}

/**
 * One SESSION: one Slack DM thread, pinned to one project directory, backed by
 * one Claude Code session id. That is the `threads` table read as what it has
 * been all along, plus the thread's most recent turn so a list of sessions can
 * still answer "what happened last".
 *
 * The timestamps are EPOCH MS, not the ISO strings `ThreadRecord` carries: the
 * dashboard's relativeTime ticker reads a `data-relative` attribute of epoch
 * ms, so this shape hands back the raw column instead of round-tripping through
 * an ISO string the renderer would only parse again.
 */
export interface SessionRow {
  /** `${channel}:${threadTs}`, the routing key. Same string `threadKey` builds. */
  key: string;
  channel: string;
  threadTs: string;
  /** null until the first turn gives us one. */
  sessionId: string | null;
  projectId: ProjectId | null;
  alias: string | null;
  cwd: string;
  slackUserId: string;
  createdAt: number;
  lastActiveAt: number;
  turns: number;
  /** Absent when the thread was bound but has never run a turn. */
  lastTurn?: {
    startedAt: number;
    durationMs: number;
    toolCount: number;
    failed: boolean;
    subtype: string;
    preview: string;
    error?: string;
  };
}

export interface SessionQuery {
  projectId?: ProjectId;
  /** Sessions whose MOST RECENT turn failed. Sessions with no turns are excluded. */
  failedOnly?: boolean;
  since?: number;
  limit?: number;
  offset?: number;
}

export interface SessionPage {
  rows: SessionRow[];
  /** Matching sessions ignoring limit/offset, so the footer can say "1-20 of 137". */
  total: number;
  offset: number;
  limit: number;
}

/**
 * Rows older than these limits are pruned on a timer, so the database cannot
 * grow without bound on a machine that runs the app for a year.
 */
export interface RetentionPolicy {
  logDays: number;
  turnDays: number;
  /** Hard ceiling on log rows, enforced after the age sweep. */
  maxLogRows: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  logDays: 14,
  turnDays: 180,
  maxLogRows: 200_000,
};

/**
 * The ONLY interface the rest of the app uses to reach persistent state.
 *
 * No SQL string may appear outside the module that implements this. Core,
 * main and the renderer all code against this shape, so swapping the engine
 * later touches exactly one file.
 *
 * Every method is synchronous: `node:sqlite` is a synchronous API, the
 * operations are single-row or small, and keeping it synchronous preserves the
 * existing invariant that a thread record is created BEFORE `enqueue` is
 * called. Making binding async would open a race where the later messages of a
 * burst get alias-parsed instead of inheriting the binding.
 */
export interface Storage {
  // threads
  getThread(channel: string, threadTs: string): ThreadRecord | undefined;
  putThread(channel: string, threadTs: string, record: ThreadRecord): void;
  patchThread(channel: string, threadTs: string, patch: Partial<ThreadRecord>): void;
  /**
   * Forget one thread completely: its `threads` row AND every `turns` row it
   * recorded, in one transaction. Returns how many turns went, so the caller
   * can tell the operator what was removed.
   *
   * The channel's `cursors` row is deliberately NOT touched. A cursor is per
   * channel, not per thread, so dropping it would re-seed that channel and
   * replay a day of old DMs. See `advanceCursor`.
   */
  deleteSession(channel: string, threadTs: string): { turns: number };
  /** Threads in one channel whose lastActiveAt is at or after `since`. Bounds the catch-up sweep. */
  threadsFor(channel: string, since?: number): { key: string; record: ThreadRecord }[];
  /** Every thread bound to a project, used when a project is removed. */
  threadsForProject(projectId: ProjectId): { key: string; record: ThreadRecord }[];

  // cursors
  getCursor(channel: string): string | undefined;
  /** Monotonic: never moves a cursor backwards, even if called with an older ts. */
  advanceCursor(channel: string, ts: string): void;
  allCursors(): Record<string, string>;

  // turns
  recordTurn(row: Omit<TurnRow, 'id'>): void;
  recentTurns(query?: TurnQuery): TurnRow[];

  // sessions
  /**
   * Every thread, newest active first, one page at a time, each carrying its
   * most recent turn. Paged rather than capped because the thread table only
   * ever grows, and a page object rather than a bare array so the caller never
   * has to guess whether a short page means the end.
   */
  sessions(query?: SessionQuery): SessionPage;

  // logs
  appendLog(line: LogLine): void;
  queryLogs(query?: LogQuery): LogRow[];

  // lifecycle
  /** Runs the age and row-count sweeps. Called on a timer and at startup. */
  prune(policy?: RetentionPolicy): void;
  /** Flush and close. Called from `before-quit`. */
  close(): void;
}

/** Result of the one-time import of `.state/threads.json` into SQLite. */
export interface LegacyImportReport {
  imported: boolean;
  sourcePath: string;
  threads: number;
  cursors: number;
  /** Threads whose stored `cwd` matched a configured project directory and were auto-bound. */
  bound: number;
  /** Threads left with `projectId: null` because no project directory matched. */
  unbound: number;
}

// ---------------------------------------------------------------------------
// Alias grammar and normalisation
// ---------------------------------------------------------------------------

/**
 * 1 to 32 characters, lowercase alphanumeric, with `_` and `-` allowed inside
 * only. The dot is deliberately excluded: Slack linkifies anything that looks
 * like a domain, so an alias `foo.dev` would arrive as `<http://foo.dev|foo.dev>`
 * and could never match. `/`, `:` and `@` are excluded for the same reason.
 */
export const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

/** Words that mean something else on the first line of a thread. */
export const RESERVED_ALIASES: readonly string[] = [
  'help',
  'projects',
  'status',
  'cancel',
  'stop',
  'reset',
  'new',
  'whoami',
  'cost',
] as const;

/**
 * Turn the first line of a Slack message into a lookup key.
 *
 * Mobile keyboards inject non-breaking spaces and zero-width characters, and
 * operators naturally type "/writings", "@writings" or "writings:". All of that
 * is absorbed here so the lookup itself stays an exact map hit. Matching is
 * never fuzzy: a near miss produces a suggestion in the error text, never a
 * silent route to the wrong project.
 */
export function normaliseAlias(line: string): string {
  return line
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .replace(/^[/@#]/, '')
    .replace(/[:,.]$/, '')
    .trim()
    .toLowerCase();
}

export type AliasRejection = 'empty' | 'charset' | 'reserved' | 'duplicate';

export interface AliasValidation {
  ok: boolean;
  /** The normalised value that would be stored. */
  value: string;
  reason?: AliasRejection;
  message?: string;
}

/**
 * Shared by the wizard's live field validation and by the config validator, so
 * the UI can never accept an alias the router would reject.
 * `taken` is every alias already in use by OTHER projects, lowercased.
 */
export function validateAlias(raw: string, taken: readonly string[] = []): AliasValidation {
  const value = normaliseAlias(raw);
  if (!value) return { ok: false, value, reason: 'empty', message: 'Give the project an alias.' };
  if (!ALIAS_PATTERN.test(value)) {
    return {
      ok: false,
      value,
      reason: 'charset',
      message: 'Use 1 to 32 characters: lowercase letters, numbers, and - or _ inside. No dots, slashes or @.',
    };
  }
  if (RESERVED_ALIASES.includes(value)) {
    return { ok: false, value, reason: 'reserved', message: `\`${value}\` is reserved for in-thread commands.` };
  }
  if (taken.includes(value)) {
    return { ok: false, value, reason: 'duplicate', message: `\`${value}\` is already used by another project.` };
  }
  return { ok: true, value };
}

/** Split a message into its first line and everything after it. Neither part is trimmed of internal newlines. */
export function splitFirstLine(text: string): { head: string; body: string } {
  const index = text.indexOf('\n');
  if (index === -1) return { head: text.trim(), body: '' };
  return { head: text.slice(0, index).trim(), body: text.slice(index + 1).trim() };
}

/** `prj_` + 12 lowercase hex. Uses the Web Crypto global, present in both Node 22 and the renderer. */
export function makeProjectId(): ProjectId {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `prj_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/** Every log sink, the in-app tail and Copy Diagnostics must run text through this. */
export function redactSecrets(text: string): string {
  return text
    .replace(/xox[abposr]-[A-Za-z0-9-]{8,}/g, (m) => `${m.slice(0, 9)}…redacted`)
    .replace(/xapp-[A-Za-z0-9-]{8,}/g, (m) => `${m.slice(0, 9)}…redacted`)
    // Anthropic keys. Log lines pass through here, and a turn can surface one
    // from an env dump or an error body even though nothing deliberately prints
    // it. Redacting costs nothing; missing one is unrecoverable once written.
    .replace(/sk-ant-[A-Za-z0-9_-]{16,}/g, (m) => `${m.slice(0, 10)}…redacted`)
    // OAuth bearer tokens and generic "token=..." / "key=..." pairs.
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, '$1 …redacted')
    .replace(/\b(api[-_]?key|secret|password|token)(["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/-]{12,})/gi,
      (_m, key: string, sep: string) => `${key}${sep}…redacted`);
}

/** Display form for a stored token: prefix plus last four characters. */
export function tokenHint(token: string): string {
  if (token.length < 8) return '…';
  const dash = token.indexOf('-');
  const prefix = dash > 0 ? token.slice(0, dash + 1) : token.slice(0, 5);
  return `${prefix}…${token.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Every outcome of reading one inbound Slack message. Produced by a pure
 * function in core so the whole routing table is unit-testable without Slack
 * and without the agent.
 */
export type Route =
  /** Thread already bound. The ENTIRE text is the prompt; the first line is never inspected. */
  | { kind: 'bound'; project: ResolvedProject; prompt: string }
  /** First message of a thread, alias matched, body present. Bind, then run `prompt`. */
  | { kind: 'bind'; project: ResolvedProject; alias: string; prompt: string }
  /** Alias alone with no body. Bind and acknowledge. Start no session. */
  | { kind: 'bindOnly'; project: ResolvedProject; alias: string }
  /** No alias matched but a fallback resolved. The WHOLE text is the prompt. */
  | { kind: 'fallback'; project: ResolvedProject; prompt: string; why: 'default' | 'single' | 'pending' }
  /** No alias, no fallback. Post the alias list. Do not bind, do not spawn. */
  | { kind: 'unknownAlias'; seen: string; suggestion?: string; isReply: boolean }
  /** Alias matched a project that is configured but disabled. */
  | { kind: 'paused'; project: ProjectConfig | ResolvedProject; alias: string }
  /** Thread was bound to a project that no longer exists. Told once, then silent. */
  | { kind: 'orphaned'; alias: string | null }
  /** `!help`, `!projects`, `!cancel`, or a bare `help`/`projects` on an unbound thread. */
  | { kind: 'command'; name: ThreadCommand; args: string }
  /** Nothing actionable, e.g. an attachment-only message. */
  | { kind: 'ignore'; why: string };

export type ThreadCommand = 'help' | 'projects' | 'cancel' | 'status';

export const THREAD_COMMANDS: readonly ThreadCommand[] = ['help', 'projects', 'cancel', 'status'] as const;

/** Input to the pure router. Everything it needs, nothing it does not. */
export interface RouteInput {
  /** Mention-stripped and trimmed. */
  text: string;
  /** The persisted record for this thread, if any. */
  record: ThreadRecord | undefined;
  /** True when Slack says this is a reply, i.e. thread_ts is set and differs from ts. */
  isReply: boolean;
  /** A live pending bind for this channel, if the window has not expired. */
  pendingBind?: { projectId: ProjectId; expiresAt: number };
  now: number;
}

// ---------------------------------------------------------------------------
// Service state and events
// ---------------------------------------------------------------------------

export type ServiceState =
  | 'stopped'
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface ProjectHealth {
  id: ProjectId;
  alias: string;
  name: string;
  dir: string;
  enabled: boolean;
  /** False when the directory is missing or unreadable. The project is skipped, not fatal. */
  dirOk: boolean;
  problem?: string;
}

export interface ActiveThread {
  /** `${channel}:${threadTs}` */
  key: string;
  channel: string;
  threadTs: string;
  projectId: ProjectId | null;
  alias: string | null;
  projectName: string | null;
  slackUserId: string;
  slackUserName?: string;
  /** True while a turn is running. */
  busy: boolean;
  /** Messages queued behind the running turn. */
  queued: number;
  /** Last tool label, e.g. "Bash: npm test". */
  currentActivity?: string;
  turnStartedAt?: number;
  turns: number;
  sessionId: string | null;
  lastActiveAt: number;
}

/**
 * The complete paintable state of the service. `snapshot()` returns this, and
 * it is pushed on IPC_EVENTS.status. A window opening mid-run must be able to
 * paint everything from this object alone, without waiting for the next event.
 */
export interface DaemonStatus {
  state: ServiceState;
  detail?: string;
  /** Epoch ms the current state was entered. */
  since: number;
  identity?: SlackIdentity;
  allowlist: AllowlistResolution;
  projects: ProjectHealth[];
  activeThreads: ActiveThread[];
  lastEventAt?: number;
  lastCatchupAt?: number;
  lastCatchupReplayed?: number;
  encryptionAvailable: boolean;
  claudeExecutablePath?: string;
  /** True when setupCompletedAt is set. The renderer routes on this. */
  setupComplete: boolean;
}

export interface TurnEndInfo {
  failed: boolean;
  durationMs: number;
  costUsd: number;
  toolCount: number;
  numTurns: number;
  /** result subtype, e.g. 'success' or 'error_max_turns'. */
  subtype: string;
}

/** Turn lifecycle. Emitted by Session through the `onEvent` dep, never by importing an emitter into core. */
export type TurnEvent =
  | { type: 'turn:queued'; at: number; threadTs: string; channel: string; projectId: ProjectId | null; chars: number; behindWork: boolean }
  | { type: 'turn:started'; at: number; threadTs: string; channel: string; projectId: ProjectId | null }
  | { type: 'turn:progress'; at: number; threadTs: string; channel: string; tool: string; count: number }
  | { type: 'turn:ended'; at: number; threadTs: string; channel: string; projectId: ProjectId | null; info: TurnEndInfo }
  | { type: 'turn:stalled'; at: number; threadTs: string; channel: string; silentMs: number };

export type ServiceEvent =
  | TurnEvent
  | { type: 'status'; at: number; status: DaemonStatus }
  | { type: 'catchup'; at: number; replayed: number }
  | { type: 'routing:rejected'; at: number; channel: string; threadTs: string; alias: string }
  | { type: 'session:evicted'; at: number; key: string }
  | { type: 'error'; at: number; scope: string; message: string };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  at: number;
  level: LogLevel;
  scope: string;
  /** Already redacted. */
  message: string;
}

/** How many lines the in-memory ring buffer keeps for backfilling a newly opened window. */
export const LOG_RING_CAPACITY = 2000;

// ---------------------------------------------------------------------------
// Checks (doctor, and the wizard's verification steps)
// ---------------------------------------------------------------------------

export type SetupCheckId =
  | 'botToken'
  | 'appToken'
  | 'allowlist'
  | 'events'
  | 'userIdentity'
  | 'shellPath'
  | 'claudeBinary'
  | 'claudeAuth'
  | 'projectDir'
  | 'safeStorage'
  | 'legacyDaemon'
  | 'singleInstance';

export interface SetupCheckResult<T = unknown> {
  id: SetupCheckId;
  ok: boolean;
  /** Short name, e.g. "bot token". */
  label: string;
  /** What was found, e.g. "yourbot in Your Workspace". */
  detail: string;
  /** What to do about it when not ok. */
  hint?: string;
  /** A warning does not block the wizard or fail `npm run doctor`. */
  severity: 'error' | 'warning';
  data?: T;
  ranAt: number;
  /** ms the check took. The claudeAuth probe spawns a 317 MB binary and takes seconds. */
  durationMs?: number;
}

export interface ProjectDirCheckData {
  dir: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  hasClaudeSettings: boolean;
  hasDenyRules: boolean;
}

export interface ClaudeBinaryCheckData {
  path: string;
  executable: boolean;
  version?: string;
  /** True when the resolved path had to be rewritten out of app.asar. */
  unpacked: boolean;
}

export interface ShellPathCheckData {
  path: string;
  recovered: boolean;
  tools: { name: string; resolved: string | null }[];
}

export interface UserIdentityCheckData {
  user: string;
  home: string;
  logname: string;
  /** True when the app had to backfill any of these from os.userInfo(). */
  repaired: boolean;
}

export interface SelfTestResult {
  ok: boolean;
  projectId: ProjectId;
  channel: string;
  threadTs: string;
  durationMs: number;
  detail: string;
}

// ---------------------------------------------------------------------------
// Wizard support
// ---------------------------------------------------------------------------

export type SetupStepId =
  | 'welcome'
  | 'slackApp'
  | 'botToken'
  | 'appToken'
  | 'operators'
  | 'handshake'
  | 'project'
  | 'agent'
  | 'probe'
  | 'finish';

export const SETUP_STEPS: readonly SetupStepId[] = [
  'welcome',
  'slackApp',
  'botToken',
  'appToken',
  'operators',
  'handshake',
  'project',
  'agent',
  'probe',
  'finish',
] as const;

/** Steps that cannot be advanced past without a green check. */
export const SETUP_BLOCKING_STEPS: readonly SetupStepId[] = ['botToken', 'appToken', 'operators', 'project', 'agent'] as const;

/** Detected legacy `.env`, offered for import on the welcome step. */
export interface EnvMigrationCandidate {
  envPath: string;
  hasBotToken: boolean;
  hasAppToken: boolean;
  allowedUsers: string[];
  projectDir?: string;
  projectName?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  /** Legacy .state/threads.json found next to it, with this many threads and cursors. */
  legacyStatePath?: string;
  legacyThreadCount?: number;
  legacyCursorCount?: number;
}

export interface HandshakeSession {
  /** The word the operator must DM to the bot. */
  codeWord: string;
  expiresAt: number;
}

export interface HandshakeResult {
  ok: boolean;
  /** Set on success, so the daemon's first catch-up has an explicit baseline. */
  channel?: string;
  ts?: string;
  userId?: string;
  detail: string;
}

export interface LoginItemState {
  enabled: boolean;
  status: 'not-registered' | 'enabled' | 'requires-approval' | 'not-found';
  /** False in dev, where the login item would register the Electron helper binary rather than the app. */
  supported: boolean;
  wasOpenedAtLogin: boolean;
}

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  userDataPath: string;
  stateDir: string;
  logDir: string;
  configPath: string;
}

// ---------------------------------------------------------------------------
// IPC channels
// ---------------------------------------------------------------------------

/**
 * Renderer -> main, all via ipcRenderer.invoke / ipcMain.handle.
 * Every handler must verify `event.sender` is the app's own window before
 * acting: these handlers hold Slack tokens and can start an agent that runs
 * shell commands.
 */
export const IPC = {
  configGet: 'config:get',
  configSave: 'config:save',
  configValidate: 'config:validate',

  secretsStatus: 'secrets:status',
  secretsSet: 'secrets:set',
  secretsClear: 'secrets:clear',

  projectsAdd: 'projects:add',
  projectsUpdate: 'projects:update',
  projectsRemove: 'projects:remove',
  projectsReorder: 'projects:reorder',

  dialogPickDirectory: 'dialog:pickDirectory',

  slackVerifyBotToken: 'slack:verifyBotToken',
  slackVerifyAppToken: 'slack:verifyAppToken',
  slackListUsers: 'slack:listUsers',
  slackResolveAllowlist: 'slack:resolveAllowlist',
  slackHandshakeStart: 'slack:handshakeStart',
  slackHandshakeCancel: 'slack:handshakeCancel',
  slackAppManifest: 'slack:appManifest',

  checksRunAll: 'checks:runAll',
  checksRunOne: 'checks:runOne',

  serviceStart: 'service:start',
  serviceStop: 'service:stop',
  serviceRestart: 'service:restart',
  serviceStatus: 'service:status',
  serviceSelftest: 'service:selftest',
  serviceResetThread: 'service:resetThread',
  serviceCancelQueued: 'service:cancelQueued',

  appInfo: 'app:info',
  appGetLoginItem: 'app:getLoginItem',
  appSetLoginItem: 'app:setLoginItem',
  appCompleteSetup: 'app:completeSetup',
  appEnvCandidate: 'app:envCandidate',
  appImportEnv: 'app:importEnv',
  appOpenExternal: 'app:openExternal',
  appRevealPath: 'app:revealPath',
  appCopyDiagnostics: 'app:copyDiagnostics',
  appQuit: 'app:quit',

  logsTail: 'logs:tail',
  logsQuery: 'logs:query',
  turnsRecent: 'turns:recent',
  sessionsList: 'sessions:list',
  sessionsOpen: 'sessions:openInTerminal',
  sessionsRemove: 'sessions:remove',

  themeGet: 'theme:get',
  themeSetMode: 'theme:setMode',
} as const;

/** Main -> renderer, via webContents.send. Subscribe through the preload wrappers. */
export const IPC_EVENTS = {
  status: 'evt:status',
  log: 'evt:log',
  turn: 'evt:turn',
  config: 'evt:config',
  handshake: 'evt:handshake',
  /** Tray asked the window to show a particular view. */
  navigate: 'evt:navigate',
  /** Fired on nativeTheme 'updated', on accent-colour change, and on window focus/blur. */
  theme: 'evt:theme',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

export type RendererView = 'setup' | 'dashboard' | 'projects' | 'settings' | 'logs' | 'diagnostics';

// ---------------------------------------------------------------------------
// The preload bridge
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void;

/** Payload for adding or editing a project. `id` is absent when adding. */
export interface ProjectDraft {
  id?: ProjectId;
  alias: string;
  aliases?: string[];
  name: string;
  dir: string;
  enabled?: boolean;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  additionalDirectories?: string[];
}

/**
 * Exactly what `window.api` exposes. The preload implements this and nothing
 * more; the renderer codes against this and nothing more.
 *
 * Note what is NOT here: any way to read a token back. `secretsSet` is
 * write-only and `secretsStatus` returns presence plus a redacted hint. The
 * renderer never holds a Slack token, which is the main prize of putting the
 * service in the main process.
 */
export interface Api {
  // config
  getConfig(): Promise<StoredConfig>;
  saveConfig(patch: DeepPartial<StoredConfig>): Promise<Result<StoredConfig>>;
  validateConfig(candidate: DeepPartial<StoredConfig>): Promise<ValidationReport>;

  // secrets (write-only)
  secretsStatus(): Promise<SecretsStatus>;
  setSecrets(input: { botToken?: string; appToken?: string }): Promise<Result<SecretsStatus>>;
  clearSecrets(): Promise<Result<SecretsStatus>>;

  // projects
  addProject(draft: ProjectDraft): Promise<Result<ProjectConfig>>;
  updateProject(draft: ProjectDraft & { id: ProjectId }): Promise<Result<ProjectConfig>>;
  removeProject(id: ProjectId): Promise<Result<null>>;
  reorderProjects(ids: ProjectId[]): Promise<Result<ProjectConfig[]>>;
  pickDirectory(): Promise<string | null>;

  // slack setup
  verifyBotToken(token: string): Promise<SetupCheckResult<SlackIdentity>>;
  verifyAppToken(token: string): Promise<SetupCheckResult<null>>;
  listWorkspaceUsers(): Promise<Result<SlackWorkspaceUser[]>>;
  resolveAllowlist(entries: string[]): Promise<SetupCheckResult<AllowlistResolution>>;
  startHandshake(): Promise<Result<HandshakeSession>>;
  cancelHandshake(): Promise<Result<null>>;
  /** The ready-to-paste Slack app manifest YAML, with every required scope. */
  slackAppManifest(): Promise<string>;

  // checks
  runAllChecks(): Promise<SetupCheckResult[]>;
  runCheck(id: SetupCheckId, arg?: { projectId?: ProjectId; dir?: string }): Promise<SetupCheckResult>;

  // service
  startService(): Promise<Result<null>>;
  stopService(): Promise<Result<null>>;
  restartService(): Promise<Result<null>>;
  getStatus(): Promise<DaemonStatus>;
  runSelftest(projectId: ProjectId): Promise<Result<SelfTestResult>>;
  resetThread(key: string): Promise<Result<null>>;
  cancelQueued(key: string): Promise<Result<{ dropped: number }>>;

  // app
  appInfo(): Promise<AppInfo>;
  getLoginItem(): Promise<LoginItemState>;
  setLoginItem(enabled: boolean): Promise<LoginItemState>;
  completeSetup(): Promise<Result<null>>;
  envCandidate(): Promise<EnvMigrationCandidate | null>;
  importEnv(): Promise<Result<StoredConfig>>;
  openExternal(url: string): Promise<Result<null>>;
  revealPath(path: string): Promise<Result<null>>;
  copyDiagnostics(): Promise<Result<string>>;
  quit(): Promise<void>;

  // data (all served from SQLite through the Storage interface)
  logTail(limit?: number): Promise<LogLine[]>;
  queryLogs(query?: LogQuery): Promise<LogRow[]>;
  recentTurns(query?: TurnQuery): Promise<TurnRow[]>;
  listSessions(query?: SessionQuery): Promise<SessionPage>;
  /**
   * Resume this thread's Claude session in a terminal on this machine.
   *
   * Takes ONLY the thread key, and that is load-bearing rather than terse: main
   * reads the session id and the project directory back out of SQLite itself
   * and writes them into a shell script it then asks the OS to run. Nothing the
   * renderer supplies may reach that script, so there is deliberately no
   * overload here that accepts a path or a session id.
   */
  openSessionInTerminal(key: string): Promise<Result<null>>;
  /**
   * Forget one thread: its row and its turns leave this app's database.
   *
   * Scoped to this app only. The Claude Code transcript under `~/.claude` is
   * never touched, so `claude --resume` on that session id still works.
   * Refused while that thread is running a turn, because the turn would write
   * the row straight back. See SlackCodeService.removeSession.
   */
  removeSession(key: string): Promise<Result<{ turns: number }>>;

  // appearance
  getTheme(): Promise<ThemeState>;
  setThemeMode(mode: ThemeMode): Promise<ThemeState>;

  // subscriptions
  onStatus(cb: (status: DaemonStatus) => void): Unsubscribe;
  onLog(cb: (line: LogLine) => void): Unsubscribe;
  onTurn(cb: (event: TurnEvent) => void): Unsubscribe;
  onConfig(cb: (config: StoredConfig) => void): Unsubscribe;
  onHandshake(cb: (result: HandshakeResult) => void): Unsubscribe;
  onNavigate(cb: (view: RendererView) => void): Unsubscribe;
  onTheme(cb: (theme: ThemeState) => void): Unsubscribe;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

declare global {
  interface Window {
    api: Api;
  }
}

// ---------------------------------------------------------------------------
// Slack surface constants shared by core and the renderer preview
// ---------------------------------------------------------------------------

export const REACTIONS = {
  working: 'hourglass_flowing_sand',
  done: 'white_check_mark',
  failed: 'x',
  queued: 'inbox_tray',
  bound: 'pushpin',
  unknownAlias: 'grey_question',
} as const;

/** Everything the Slack app must have. Shown on the wizard's manifest step. */
export const SLACK_REQUIRED_BOT_SCOPES: readonly string[] = [
  'im:history',
  'im:read',
  'im:write',
  'chat:write',
  'reactions:write',
  'users:read',
] as const;

export const SLACK_REQUIRED_BOT_EVENTS: readonly string[] = ['message.im'] as const;

/** The one scope the app-level token needs, for Socket Mode. */
export const SLACK_REQUIRED_APP_SCOPES: readonly string[] = ['connections:write'] as const;
