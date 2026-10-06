/**
 * One-time migrations from the headless daemon.
 *
 * Two inputs, both left exactly where they are afterwards. Deleting an
 * operator's `.env` because we think we have finished with it is not our call,
 * and `.state/threads.json` is the only copy of the session ids that let old
 * Slack threads resume.
 *
 * `dotenv` was removed from the dependency list on purpose, so the parser here
 * is hand-rolled. It handles the three things a real .env file actually does:
 * comments, blank lines, and quoted values.
 */

import { app } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { logger } from '../core/log.ts';
import {
  DEFAULT_CONFIG,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  TUNING_RANGES,
  clampToRange,
  makeProjectId,
  validateAlias,
  type EffortLevel,
  type EnvMigrationCandidate,
  type LegacyStoreSnapshot,
  type PermissionMode,
  type ProjectConfig,
  type StoredConfig,
} from '../shared/contract.ts';
import { userDataDir } from './paths.ts';

const log = logger('migrate');

/** Parse a .env body. Not a general implementation, just the real cases. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Where a legacy .env might be. Bounded and explainable: an explicit override,
 * the working directory the app was launched from, the repo root in dev, and a
 * copy the operator dropped into userData.
 */
function envCandidatePaths(): string[] {
  const paths: string[] = [];
  const explicit = process.env.SLACK_CODE_ENV_FILE;
  if (explicit) paths.push(resolve(explicit));
  paths.push(join(process.cwd(), '.env'));
  if (!app.isPackaged) paths.push(join(app.getAppPath(), '.env'));
  paths.push(join(userDataDir(), '.env'));
  return [...new Set(paths)];
}

function readLegacyState(stateJsonPath: string): { threads: number; cursors: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(stateJsonPath, 'utf8')) as LegacyStoreSnapshot;
    return {
      threads: Object.keys(parsed.threads ?? {}).length,
      cursors: Object.keys(parsed.cursors ?? {}).length,
    };
  } catch {
    return null;
  }
}

/** The legacy thread store that sits next to a given .env, if there is one. */
export function legacyStatePathFor(envPath: string): string | undefined {
  const candidate = join(dirname(envPath), '.state', 'threads.json');
  return existsSync(candidate) ? candidate : undefined;
}

export function findEnvCandidate(): EnvMigrationCandidate | null {
  for (const envPath of envCandidatePaths()) {
    if (!existsSync(envPath)) continue;
    let values: Record<string, string>;
    try {
      values = parseEnvFile(readFileSync(envPath, 'utf8'));
    } catch (error) {
      log.debug(`could not read ${envPath}`, error);
      continue;
    }
    if (!values.SLACK_BOT_TOKEN && !values.PROJECT_DIR) continue;

    const statePath = legacyStatePathFor(envPath);
    const counts = statePath ? readLegacyState(statePath) : null;

    const candidate: EnvMigrationCandidate = {
      envPath,
      hasBotToken: Boolean(values.SLACK_BOT_TOKEN?.startsWith('xoxb-')),
      hasAppToken: Boolean(values.SLACK_APP_TOKEN?.startsWith('xapp-')),
      allowedUsers: (values.SLACK_ALLOWED_USERS ?? '')
        .split(',')
        .map((entry) => entry.trim().replace(/^@/, ''))
        .filter(Boolean),
      ...(values.PROJECT_DIR ? { projectDir: expandHome(values.PROJECT_DIR) } : {}),
      ...(values.PROJECT_NAME ? { projectName: values.PROJECT_NAME } : {}),
      ...(values.MODEL ? { model: values.MODEL } : {}),
      ...(values.PERMISSION_MODE ? { permissionMode: values.PERMISSION_MODE } : {}),
      ...(values.EFFORT ? { effort: values.EFFORT } : {}),
      ...(statePath ? { legacyStatePath: statePath } : {}),
      ...(counts ? { legacyThreadCount: counts.threads, legacyCursorCount: counts.cursors } : {}),
    };
    return candidate;
  }
  return null;
}

function expandHome(path: string): string {
  return resolve(path.replace(/^~(?=\/|$)/, process.env.HOME ?? ''));
}

/** Directory basename to a legal alias, falling back to something usable. */
export function slugifyAlias(input: string, taken: string[] = []): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');

  const check = validateAlias(base, taken);
  if (check.ok) return check.value;

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const attempt = validateAlias(`${base || 'project'}-${suffix}`.slice(0, 32), taken);
    if (attempt.ok) return attempt.value;
  }
  return `project-${Date.now().toString(36).slice(-4)}`;
}

function intFrom(values: Record<string, string>, key: string, fallback: number, range: readonly [number, number]): number {
  const raw = values[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clampToRange(parsed, range);
}

export interface EnvImportResult {
  config: StoredConfig;
  botToken?: string;
  appToken?: string;
  notes: string[];
}

/**
 * Turn a legacy .env into a StoredConfig plus the two tokens, which the caller
 * encrypts. The permission mode carries across unchanged, including
 * bypassPermissions: this is a machine that was already running that way, and
 * silently tightening it would break the operator's setup without telling them.
 */
export function buildConfigFromEnv(base: StoredConfig, candidate: EnvMigrationCandidate): EnvImportResult {
  const values = parseEnvFile(readFileSync(candidate.envPath, 'utf8'));
  const notes: string[] = [];

  const config: StoredConfig = {
    ...base,
    slack: {
      ...base.slack,
      allowed: candidate.allowedUsers.map((entry) => ({ entry })),
    },
    agent: { ...base.agent },
    projects: [...base.projects],
    tuning: { ...base.tuning },
  };

  const mode = values.PERMISSION_MODE?.trim();
  if (mode) {
    if (PERMISSION_MODES.includes(mode as PermissionMode)) {
      config.agent.permissionMode = mode as PermissionMode;
    } else {
      notes.push(`PERMISSION_MODE was "${mode}", which is not one of ${PERMISSION_MODES.join(', ')}. Left at ${config.agent.permissionMode}.`);
    }
  }

  const effort = values.EFFORT?.trim();
  if (effort) {
    if (EFFORT_LEVELS.includes(effort as EffortLevel)) config.agent.effort = effort as EffortLevel;
    else notes.push(`EFFORT was "${effort}", which is not a known level. Left at ${config.agent.effort}.`);
  }

  const model = values.MODEL?.trim();
  if (model) config.agent.model = model;

  config.tuning.sessionIdleMinutes = intFrom(values, 'SESSION_IDLE_MINUTES', config.tuning.sessionIdleMinutes, TUNING_RANGES.sessionIdleMinutes);
  config.tuning.turnStallMinutes = intFrom(values, 'TURN_STALL_MINUTES', config.tuning.turnStallMinutes, TUNING_RANGES.turnStallMinutes);
  config.tuning.catchupWindowHours = intFrom(values, 'CATCHUP_WINDOW_HOURS', config.tuning.catchupWindowHours, TUNING_RANGES.catchupWindowHours);
  config.tuning.statusUpdateMs = intFrom(values, 'STATUS_UPDATE_MS', config.tuning.statusUpdateMs, TUNING_RANGES.statusUpdateMs);

  if (candidate.projectDir) {
    const dir = candidate.projectDir;
    const exists = existsSync(dir) && statSync(dir).isDirectory();
    if (!exists) {
      notes.push(`PROJECT_DIR (${dir}) does not exist any more, so no project was created from it.`);
    } else if (!config.projects.some((project) => project.dir === dir)) {
      const alias = slugifyAlias(basename(dir), config.projects.map((project) => project.alias));
      const project: ProjectConfig = {
        id: makeProjectId(),
        alias,
        aliases: [],
        name: candidate.projectName?.trim() || basename(dir),
        dir,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      config.projects.push(project);
      notes.push(`Created project "${project.name}" with alias ${alias}. Change the alias now if you want a shorter one.`);
    }
  }

  const botToken = values.SLACK_BOT_TOKEN?.trim();
  const appToken = values.SLACK_APP_TOKEN?.trim();
  if (botToken && !botToken.startsWith('xoxb-')) notes.push('SLACK_BOT_TOKEN did not look like a bot token, so it was skipped.');
  if (appToken && !appToken.startsWith('xapp-')) notes.push('SLACK_APP_TOKEN did not look like an app-level token, so it was skipped.');

  notes.push(`${candidate.envPath} was left untouched. Delete it yourself once the app works, since it still holds both tokens in plain text.`);

  return {
    config,
    ...(botToken?.startsWith('xoxb-') ? { botToken } : {}),
    ...(appToken?.startsWith('xapp-') ? { appToken } : {}),
    notes,
  };
}

/** The defaults a fresh install starts from, used when there is nothing to import. */
export function freshConfig(): StoredConfig {
  return structuredClone(DEFAULT_CONFIG);
}
