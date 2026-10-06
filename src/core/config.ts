import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  TUNING_RANGES,
  clampToRange,
  makeProjectId,
  normaliseAlias,
  validateAlias,
  type AgentDefaults,
  type AllowedUser,
  type AppSettings,
  type EffortLevel,
  type FieldIssue,
  type PermissionMode,
  type ProjectConfig,
  type ProjectId,
  type ResolvedProject,
  type ResolvedUser,
  type RoutingSettings,
  type RuntimeConfig,
  type StoredConfig,
  type ThemeMode,
  type TuningSettings,
  type ValidationReport,
} from '../shared/contract.ts';

/**
 * Config validation and shaping. Everything env-related is gone: no dotenv, no
 * `required()`, no `~` expansion off process.env, and no state directory derived
 * from `import.meta.url` (which resolved relative to dist/ and breaks under
 * asar). Main injects the paths.
 *
 * Nothing here throws. The old ConfigError stopped at the FIRST bad field,
 * which is wrong for a wizard that wants to light up every broken input at
 * once, so problems are collected and returned.
 */

/**
 * RuntimeConfig plus the two indexes the router and the dashboard need for
 * projects that are configured but PAUSED. `RuntimeConfig.projects`, `byAlias`
 * and `byId` deliberately carry only ENABLED projects, because those are the
 * only ones a session may run in. A paused alias still has to produce its own
 * distinct message rather than "unknown alias", so it is indexed separately.
 *
 * This is a structural superset of RuntimeConfig, so anything typed against the
 * shared contract keeps working unchanged.
 */
export interface RuntimeConfigInternal extends RuntimeConfig {
  paused: Map<string, ProjectConfig>;
  pausedProjects: ProjectConfig[];
  /**
   * The allowlist exactly as stored: a user id where the wizard resolved one,
   * otherwise the raw text the operator typed. The service re-resolves these
   * against Slack at start, which is what catches a deactivated account.
   */
  allowlistEntries: string[];
}

const EMPTY_PAUSED: Map<string, ProjectConfig> = new Map();

/** The paused index if this config carries one, an empty map otherwise. */
export function pausedIndex(config: RuntimeConfig): Map<string, ProjectConfig> {
  return (config as Partial<RuntimeConfigInternal>).paused ?? EMPTY_PAUSED;
}

export function pausedProjects(config: RuntimeConfig): ProjectConfig[] {
  return (config as Partial<RuntimeConfigInternal>).pausedProjects ?? [];
}

/**
 * Guarantee the internal indexes exist on a config that came in typed as the
 * shared `RuntimeConfig`. Fills them in place, so the router sees them too.
 */
export function asInternalConfig(config: RuntimeConfig): RuntimeConfigInternal {
  const partial = config as RuntimeConfig & Partial<RuntimeConfigInternal>;
  partial.paused ??= new Map<string, ProjectConfig>();
  partial.pausedProjects ??= [];
  partial.allowlistEntries ??= config.allowedUserIds.slice();
  return partial as RuntimeConfigInternal;
}

/** Expand a leading `~`, then make the path absolute. */
export function expandHome(input: string, home = homedir()): string {
  const expanded = input.replace(/^~(?=\/|$)/, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((e) => e.trim());
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

function isEffort(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function normaliseProject(raw: unknown, index: number, taken: string[]): ProjectConfig {
  const source = asRecord(raw);
  const dirRaw = str(source.dir, '');
  const dir = dirRaw ? expandHome(dirRaw) : '';
  const fallbackAlias = dir.split('/').filter(Boolean).pop() ?? `project${index + 1}`;
  const aliasCheck = validateAlias(str(source.alias, fallbackAlias), taken);
  const alias = aliasCheck.ok ? aliasCheck.value : normaliseAlias(str(source.alias, fallbackAlias));

  const project: ProjectConfig = {
    id: str(source.id, '').startsWith('prj_') ? str(source.id, '') : makeProjectId(),
    alias,
    aliases: strArray(source.aliases).map(normaliseAlias).filter((entry) => entry && entry !== alias),
    name: str(source.name, dir.split('/').filter(Boolean).pop() ?? alias),
    dir,
    enabled: bool(source.enabled, true),
    createdAt: str(source.createdAt, new Date().toISOString()),
  };

  if (typeof source.model === 'string' && source.model.trim()) project.model = source.model.trim();
  if (isPermissionMode(source.permissionMode)) project.permissionMode = source.permissionMode;
  if (isEffort(source.effort)) project.effort = source.effort;
  const extra = strArray(source.additionalDirectories).map((entry) => expandHome(entry));
  if (extra.length > 0) project.additionalDirectories = extra;
  return project;
}

/**
 * Fill defaults, clamp ranges, and repair anything shaped wrongly. Never
 * throws, so a hand-edited or half-written config still boots into a usable
 * app that can explain what it had to fix.
 */
export function normaliseConfig(raw: unknown): StoredConfig {
  const source = asRecord(raw);
  const slackRaw = asRecord(source.slack);
  const agentRaw = asRecord(source.agent);
  const routingRaw = asRecord(source.routing);
  const tuningRaw = asRecord(source.tuning);
  const appRaw = asRecord(source.app);

  const allowed: AllowedUser[] = (Array.isArray(slackRaw.allowed) ? slackRaw.allowed : [])
    .map((entry): AllowedUser | null => {
      if (typeof entry === 'string') return entry.trim() ? { entry: entry.trim().replace(/^@/, '') } : null;
      const record = asRecord(entry);
      const text = str(record.entry, '');
      if (!text) return null;
      const user: AllowedUser = { entry: text.replace(/^@/, '') };
      if (typeof record.id === 'string' && record.id) user.id = record.id;
      if (typeof record.name === 'string' && record.name) user.name = record.name;
      if (typeof record.resolvedAt === 'string' && record.resolvedAt) user.resolvedAt = record.resolvedAt;
      return user;
    })
    .filter((entry): entry is AllowedUser => entry !== null);

  const projects: ProjectConfig[] = [];
  const takenAliases: string[] = [];
  const rawProjects = Array.isArray(source.projects) ? source.projects : [];
  for (const [index, entry] of rawProjects.entries()) {
    const project = normaliseProject(entry, index, takenAliases);
    takenAliases.push(project.alias, ...project.aliases);
    projects.push(project);
  }

  const agent: AgentDefaults = {
    model: str(agentRaw.model, DEFAULT_CONFIG.agent.model),
    effort: isEffort(agentRaw.effort) ? agentRaw.effort : DEFAULT_CONFIG.agent.effort,
    // An absent or unrecognised value means a hand-edit or a truncated write,
    // and that path should land on the safer mode, never on bypassPermissions.
    permissionMode: isPermissionMode(agentRaw.permissionMode) ? agentRaw.permissionMode : DEFAULT_CONFIG.agent.permissionMode,
  };

  const routing: RoutingSettings = {
    singleProjectFallback: bool(routingRaw.singleProjectFallback, DEFAULT_CONFIG.routing.singleProjectFallback),
    pendingBindMinutes: Math.round(
      clampToRange(num(routingRaw.pendingBindMinutes, DEFAULT_CONFIG.routing.pendingBindMinutes), TUNING_RANGES.pendingBindMinutes),
    ),
    recoverBindingFromParent: bool(routingRaw.recoverBindingFromParent, DEFAULT_CONFIG.routing.recoverBindingFromParent),
  };
  const defaultProjectId = str(routingRaw.defaultProjectId, '');
  if (defaultProjectId && projects.some((project) => project.id === defaultProjectId)) {
    routing.defaultProjectId = defaultProjectId;
  }

  const tuning: TuningSettings = {
    sessionIdleMinutes: Math.round(
      clampToRange(num(tuningRaw.sessionIdleMinutes, DEFAULT_CONFIG.tuning.sessionIdleMinutes), TUNING_RANGES.sessionIdleMinutes),
    ),
    turnStallMinutes: Math.round(
      clampToRange(num(tuningRaw.turnStallMinutes, DEFAULT_CONFIG.tuning.turnStallMinutes), TUNING_RANGES.turnStallMinutes),
    ),
    catchupWindowHours: Math.round(
      clampToRange(num(tuningRaw.catchupWindowHours, DEFAULT_CONFIG.tuning.catchupWindowHours), TUNING_RANGES.catchupWindowHours),
    ),
    statusUpdateMs: Math.round(
      clampToRange(num(tuningRaw.statusUpdateMs, DEFAULT_CONFIG.tuning.statusUpdateMs), TUNING_RANGES.statusUpdateMs),
    ),
    streamProgressHeartbeat: bool(tuningRaw.streamProgressHeartbeat, DEFAULT_CONFIG.tuning.streamProgressHeartbeat),
  };

  const app: AppSettings = {
    runAtLogin: bool(appRaw.runAtLogin, DEFAULT_CONFIG.app.runAtLogin),
    connectOnLaunch: bool(appRaw.connectOnLaunch, DEFAULT_CONFIG.app.connectOnLaunch),
    menuBarOnly: bool(appRaw.menuBarOnly, DEFAULT_CONFIG.app.menuBarOnly),
    notifyOnTurnFailure: bool(appRaw.notifyOnTurnFailure, DEFAULT_CONFIG.app.notifyOnTurnFailure),
    notifyOnDisconnect: bool(appRaw.notifyOnDisconnect, DEFAULT_CONFIG.app.notifyOnDisconnect),
    notifyOnStall: bool(appRaw.notifyOnStall, DEFAULT_CONFIG.app.notifyOnStall),
    debugLogging: bool(appRaw.debugLogging, DEFAULT_CONFIG.app.debugLogging),
    themeMode: isThemeMode(appRaw.themeMode) ? appRaw.themeMode : DEFAULT_CONFIG.app.themeMode,
    vibrancy: bool(appRaw.vibrancy, DEFAULT_CONFIG.app.vibrancy),
    reduceMotion: bool(appRaw.reduceMotion, DEFAULT_CONFIG.app.reduceMotion),
  };

  const config: StoredConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    slack: { allowed },
    agent,
    projects,
    routing,
    tuning,
    app,
  };

  const setupCompletedAt = str(source.setupCompletedAt, '');
  if (setupCompletedAt) config.setupCompletedAt = setupCompletedAt;
  const workspace = asRecord(slackRaw.workspace);
  if (typeof workspace.botUserId === 'string' && workspace.botUserId) {
    config.slack.workspace = {
      botUserId: str(workspace.botUserId, ''),
      botName: str(workspace.botName, ''),
      teamId: str(workspace.teamId, ''),
      teamName: str(workspace.teamName, ''),
    };
  }
  const eventsVerifiedAt = str(slackRaw.eventsVerifiedAt, '');
  if (eventsVerifiedAt) config.slack.eventsVerifiedAt = eventsVerifiedAt;

  return config;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function clampIssue(field: string, before: number, after: number, clamped: FieldIssue[]): void {
  if (before !== after) clamped.push({ field, message: `${before} is out of range, using ${after}.` });
}

/**
 * Collects EVERY problem instead of throwing on the first one, and separates
 * things that were repaired (clamped) from things a human has to fix (issues).
 */
export function validateConfig(raw: unknown): ValidationReport {
  const issues: FieldIssue[] = [];
  const clamped: FieldIssue[] = [];
  const source = asRecord(raw);
  const normalised = normaliseConfig(raw);

  // Tuning: out of range is clamped and reported, never rejected.
  const tuningRaw = asRecord(source.tuning);
  for (const key of ['sessionIdleMinutes', 'turnStallMinutes', 'catchupWindowHours', 'statusUpdateMs'] as const) {
    if (tuningRaw[key] === undefined) continue;
    clampIssue(`tuning.${key}`, num(tuningRaw[key], normalised.tuning[key]), normalised.tuning[key], clamped);
  }
  const routingRaw = asRecord(source.routing);
  if (routingRaw.pendingBindMinutes !== undefined) {
    clampIssue(
      'routing.pendingBindMinutes',
      num(routingRaw.pendingBindMinutes, normalised.routing.pendingBindMinutes),
      normalised.routing.pendingBindMinutes,
      clamped,
    );
  }

  const agentRaw = asRecord(source.agent);
  if (agentRaw.permissionMode !== undefined && !isPermissionMode(agentRaw.permissionMode)) {
    issues.push({
      field: 'agent.permissionMode',
      message: `Must be one of ${PERMISSION_MODES.join(', ')}. Using ${normalised.agent.permissionMode}.`,
    });
  }
  if (agentRaw.effort !== undefined && !isEffort(agentRaw.effort)) {
    issues.push({ field: 'agent.effort', message: `Must be one of ${EFFORT_LEVELS.join(', ')}. Using ${normalised.agent.effort}.` });
  }
  if (!normalised.agent.model) issues.push({ field: 'agent.model', message: 'Pick a model.' });

  if (normalised.slack.allowed.length === 0) {
    issues.push({
      field: 'slack.allowed',
      message: 'Add at least one Slack operator. With nobody on the list the service would accept nobody and refuses to start.',
    });
  }

  if (normalised.projects.length === 0) {
    issues.push({ field: 'projects', message: 'Add at least one project, so a message has somewhere to go.' });
  }

  const seenAliases = new Set<string>();
  for (const [index, project] of normalised.projects.entries()) {
    const field = `projects[${index}]`;

    const aliasCheck = validateAlias(project.alias, [...seenAliases]);
    if (!aliasCheck.ok) issues.push({ field: `${field}.alias`, message: aliasCheck.message ?? 'Invalid alias.' });
    seenAliases.add(project.alias);
    for (const extra of project.aliases) {
      const check = validateAlias(extra, [...seenAliases]);
      if (!check.ok) issues.push({ field: `${field}.aliases`, message: check.message ?? `Invalid alias "${extra}".` });
      seenAliases.add(extra);
    }

    if (!project.dir) {
      issues.push({ field: `${field}.dir`, message: 'Pick the project directory.' });
    } else if (!isAbsolute(project.dir)) {
      issues.push({ field: `${field}.dir`, message: `Must be an absolute path, got "${project.dir}".` });
    } else {
      const health = checkDirectory(project.dir);
      if (!health.ok) issues.push({ field: `${field}.dir`, message: health.message });
    }
  }

  if (normalised.projects.length > 0 && !normalised.projects.some((project) => project.enabled)) {
    issues.push({ field: 'projects', message: 'Every project is paused, so nothing can run. Enable at least one.' });
  }

  const routingDefault = str(asRecord(source.routing).defaultProjectId, '');
  if (routingDefault && !normalised.routing.defaultProjectId) {
    issues.push({ field: 'routing.defaultProjectId', message: 'Points at a project that no longer exists. Cleared.' });
  }

  return { ok: issues.length === 0, issues, clamped };
}

/** Existence and type of a project directory, phrased the way the UI shows it. */
export function checkDirectory(dir: string): { ok: boolean; message: string } {
  try {
    if (!existsSync(dir)) return { ok: false, message: `Directory does not exist: ${dir}` };
    if (!statSync(dir).isDirectory()) return { ok: false, message: `Not a directory: ${dir}` };
    return { ok: true, message: dir };
  } catch (error) {
    return { ok: false, message: `Cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Merge a project's overrides over the defaults. Sessions consume ONLY this. */
export function resolveProject(project: ProjectConfig, defaults: AgentDefaults): ResolvedProject {
  const resolved: ResolvedProject = {
    id: project.id,
    alias: project.alias,
    name: project.name || project.alias,
    dir: project.dir,
    model: project.model ?? defaults.model,
    permissionMode: project.permissionMode ?? defaults.permissionMode,
    effort: project.effort ?? defaults.effort,
  };
  if (project.additionalDirectories?.length) resolved.additionalDirectories = project.additionalDirectories;
  return resolved;
}

/**
 * Build what the service actually runs on. Enabled projects only, indexed by
 * every alias they answer to, so routing is one map hit per message rather than
 * a scan.
 */
export function toRuntimeConfig(input: {
  config: StoredConfig;
  botToken: string;
  appToken: string;
  stateDir: string;
  claudeExecutablePath?: string;
}): RuntimeConfigInternal {
  const { config } = input;

  const enabled = config.projects.filter((project) => project.enabled);
  const projects = enabled.map((project) => resolveProject(project, config.agent));

  const byAlias = new Map<string, ResolvedProject>();
  const byId = new Map<ProjectId, ResolvedProject>();
  for (const [index, resolvedProject] of projects.entries()) {
    byId.set(resolvedProject.id, resolvedProject);
    const source = enabled[index]!;
    for (const alias of [source.alias, ...source.aliases]) {
      const key = normaliseAlias(alias);
      if (key && !byAlias.has(key)) byAlias.set(key, resolvedProject);
    }
  }

  const pausedList = config.projects.filter((project) => !project.enabled);
  const paused = new Map<string, ProjectConfig>();
  for (const project of pausedList) {
    for (const alias of [project.alias, ...project.aliases]) {
      const key = normaliseAlias(alias);
      // An enabled project always wins an alias collision.
      if (key && !byAlias.has(key) && !paused.has(key)) paused.set(key, project);
    }
  }

  const allowedUsers: ResolvedUser[] = config.slack.allowed
    .filter((entry): entry is AllowedUser & { id: string } => Boolean(entry.id))
    .map((entry) => ({ id: entry.id, name: entry.name ?? entry.entry }));

  const runtime: RuntimeConfigInternal = {
    botToken: input.botToken,
    appToken: input.appToken,
    allowedUserIds: allowedUsers.map((user) => user.id),
    allowedUsers,
    projects,
    byAlias,
    byId,
    routing: config.routing,
    tuning: config.tuning,
    stateDir: input.stateDir,
    paused,
    pausedProjects: pausedList,
    allowlistEntries: allowlistEntries(config),
  };

  if (config.routing.defaultProjectId) {
    const fallback = byId.get(config.routing.defaultProjectId);
    if (fallback) runtime.defaultProject = fallback;
  }
  if (input.claudeExecutablePath) runtime.claudeExecutablePath = input.claudeExecutablePath;

  return runtime;
}

/** Entries of the allowlist exactly as typed, for a re-resolve against Slack. */
export function allowlistEntries(config: StoredConfig): string[] {
  return config.slack.allowed.map((entry) => entry.id ?? entry.entry).filter(Boolean);
}
