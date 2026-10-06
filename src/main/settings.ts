/**
 * `<userData>/config.json`: settings and the project registry.
 *
 * Deliberately plain JSON rather than a row in the database. It is tiny, read
 * once at boot, and the operator benefits from being able to open it, eyeball
 * it, hand-edit it and back it up. It also contains NO secrets, so it is safe to
 * paste into a bug report, which makes "export my settings" safe by
 * construction.
 *
 * Writes go through write-to-tmp-then-rename, which is the crash-safety
 * property worth keeping from the old JSON thread store.
 *
 * This module must never throw on a bad file. A corrupt config that took the
 * app down would leave the operator with no UI to fix it from, so a file that
 * cannot be parsed is preserved as `.bak`, the defaults are used, and the
 * problem is reported on the diagnostics pane.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normaliseConfig } from '../core/config.ts';
import { logger } from '../core/log.ts';
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG, type DeepPartial, type StoredConfig } from '../shared/contract.ts';
import { configPath } from './paths.ts';

const log = logger('settings');

export interface SettingsLoad {
  config: StoredConfig;
  /** Set when the file existed but could not be used as-is. Surfaced in diagnostics. */
  problem?: string;
  /** Path of the preserved copy, when one had to be made. */
  backupPath?: string;
  /** True when the file did not exist at all, i.e. a first run. */
  fresh: boolean;
}

/**
 * Recursive merge for a DeepPartial patch. Objects merge, arrays and primitives
 * replace. Arrays replacing wholesale is what makes "save the project list"
 * behave the way the UI expects: the renderer sends the list it wants, not a
 * diff.
 *
 * A key present with the value `undefined` REMOVES that key, which is how an
 * optional setting such as `routing.defaultProjectId` gets cleared. A key that
 * is simply absent is left alone. Object.entries keeps explicitly-undefined
 * keys, so the two cases really are distinguishable.
 */
export function mergeConfig(base: StoredConfig, patch: DeepPartial<StoredConfig>): StoredConfig {
  const merge = (target: unknown, source: unknown): unknown => {
    if (source === null || Array.isArray(source) || typeof source !== 'object') return source;
    const out: Record<string, unknown> = {
      ...(target && typeof target === 'object' && !Array.isArray(target) ? (target as Record<string, unknown>) : {}),
    };
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (value === undefined) delete out[key];
      else out[key] = merge(out[key], value);
    }
    return out;
  };
  return merge(base, patch) as StoredConfig;
}

/**
 * Bring an older file forward. Only version 1 exists so far, so this is the
 * hook rather than the work. A file from a NEWER version is left alone and
 * reported: silently downgrading it would lose whatever the newer app wrote.
 */
function migrate(raw: Record<string, unknown>): { raw: Record<string, unknown>; problem?: string } {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;

  if (version > CONFIG_SCHEMA_VERSION) {
    return {
      raw,
      problem: `config.json was written by a newer version of the app (schema ${version}, this build understands ${CONFIG_SCHEMA_VERSION}). Nothing was changed, but unknown settings are ignored.`,
    };
  }

  // version 0 means a file written before schemaVersion existed. normaliseConfig
  // fills every missing field, so stamping the version is all that is needed.
  return { raw: { ...raw, schemaVersion: CONFIG_SCHEMA_VERSION } };
}

export function readSettings(): SettingsLoad {
  const path = configPath();
  if (!existsSync(path)) {
    return { config: normaliseConfig(DEFAULT_CONFIG), fresh: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const backupPath = `${path}.bak`;
    try {
      copyFileSync(path, backupPath);
    } catch {
      // If even the copy fails there is nothing more to do; the defaults still load.
    }
    const problem = `config.json could not be parsed (${error instanceof Error ? error.message : String(error)}). The defaults are in use and the unreadable file was kept as ${backupPath}.`;
    log.error(problem);
    return { config: normaliseConfig(DEFAULT_CONFIG), problem, backupPath, fresh: false };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const problem = 'config.json did not contain a JSON object. The defaults are in use.';
    log.error(problem);
    return { config: normaliseConfig(DEFAULT_CONFIG), problem, fresh: false };
  }

  const migrated = migrate(parsed as Record<string, unknown>);
  const config = normaliseConfig(migrated.raw);
  return {
    config,
    fresh: false,
    ...(migrated.problem ? { problem: migrated.problem } : {}),
  };
}

export function writeSettings(config: StoredConfig): void {
  const path = configPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
