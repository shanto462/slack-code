/**
 * Process environment repair. This file exists because of two separate hazards,
 * both of which produce confusing failures far from their cause.
 *
 * 1. KEYCHAIN IDENTITY. Claude Code resolves its credentials from the macOS
 *    login Keychain keyed by USER IDENTITY, not by binary path. A spawned agent
 *    process without HOME, USER and LOGNAME starts cleanly and then fails every
 *    single turn with "Not logged in".
 *
 *    The fix is to repair `process.env` once, here, and then let the child
 *    INHERIT it. `Options.env` is never set anywhere in this app: the SDK
 *    documents that it REPLACES the subprocess environment entirely, which is
 *    exactly how these three variables get dropped. Inheritance cannot silently
 *    drop a variable; a hand-built env can.
 *
 * 2. A CRIPPLED PATH. A GUI app launched from Finder, the Dock or a login item
 *    inherits HOME/USER/LOGNAME from launchd, so Keychain auth survives, but it
 *    inherits a minimal PATH of roughly /usr/bin:/bin:/usr/sbin:/sbin. No
 *    Homebrew, no nvm, no ~/.local/bin. The SDK's Bash tool spawns
 *    `/bin/bash --noprofile --norc`, so no profile is read and the PATH is never
 *    rebuilt: the agent gets a shell with no node, no npm and no rg, and every
 *    "run the build and verify" instruction fails with "command not found".
 *
 * The launchd job this app replaces papered over both with a hardcoded block,
 * kept here because it is the documentation for why this file exists. Note the
 * hardcoded PATH was already stale: it never had the nvm directory the daemon
 * was actually launched from.
 *
 *     <key>EnvironmentVariables</key>
 *     <dict>
 *         <key>PATH</key>
 *         <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
 *         <key>HOME</key>
 *         <string>/Users/you</string>
 *         <key>USER</key>
 *         <string>you</string>
 *         <key>LOGNAME</key>
 *         <string>you</string>
 *     </dict>
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter } from 'node:path';
import { logger } from '../core/log.ts';
import { envCachePath } from './paths.ts';

const log = logger('env');

/** Everything launchd hands a GUI app, and nothing else. */
const MINIMAL_PATH_ENTRIES = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

/** Refresh the cached login-shell PATH once a day, so installing a tool is picked up. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface EnvRepairReport {
  user: string;
  home: string;
  logname: string;
  /** True when any of the three identity variables had to be backfilled. */
  repaired: boolean;
  path: string;
  /** Where the PATH ended up coming from. */
  pathSource: 'inherited' | 'login-shell' | 'cache' | 'inherited-after-failure';
  /** Set when the login shell could not be asked. */
  pathError?: string;
}

interface EnvCache {
  shell: string;
  path: string;
  at: number;
}

let lastReport: EnvRepairReport | null = null;

/** The most recent repair, for the diagnostics pane. Null before boot finishes. */
export function environmentReport(): EnvRepairReport | null {
  return lastReport;
}

function readCache(): EnvCache | null {
  try {
    const raw = readFileSync(envCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<EnvCache>;
    if (typeof parsed.path === 'string' && typeof parsed.shell === 'string' && typeof parsed.at === 'number') {
      return { shell: parsed.shell, path: parsed.path, at: parsed.at };
    }
  } catch {
    // A missing or corrupt cache just means we ask the shell again.
  }
  return null;
}

function writeCache(cache: EnvCache): void {
  try {
    writeFileSync(envCachePath(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch (error) {
    log.debug('could not write the PATH cache', error);
  }
}

/** True when the PATH holds nothing beyond what launchd gives a GUI app. */
function looksMinimal(path: string): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .every((entry) => MINIMAL_PATH_ENTRIES.has(entry));
}

/**
 * Ask the login shell what a real terminal would have. `command -p echo` uses
 * the standard utility path rather than whatever `echo` the rc files aliased,
 * and the marker survives any banner the profile prints.
 */
function askLoginShell(shell: string): string | null {
  try {
    const out = execFileSync(shell, ['-lic', 'command -p echo "__SLACKCODE_PATH:$PATH"'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const recovered = out.match(/__SLACKCODE_PATH:(.*)/)?.[1]?.trim();
    return recovered && recovered.length > 0 ? recovered : null;
  } catch (error) {
    log.debug(`login shell ${shell} did not return a PATH`, error);
    return null;
  }
}

/**
 * Union rather than replace. The recovered entries come first, then anything
 * the inherited PATH had that the login shell did not, so this can only ever
 * add directories. A shell config that shortens PATH cannot take away a tool
 * the app could already see.
 */
function mergePaths(recovered: string, inherited: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...recovered.split(delimiter), ...inherited.split(delimiter)]) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged.join(delimiter);
}

/**
 * Repair process.env in place. Call once, in main, before anything can spawn an
 * agent. Safe to call again with `force` when the operator asks the diagnostics
 * pane to re-detect the PATH.
 */
export function repairEnvironment(options: { force?: boolean } = {}): EnvRepairReport {
  const info = (() => {
    try {
      return userInfo();
    } catch {
      return null;
    }
  })();

  const fallbackHome = homedir();
  const fallbackUser = info?.username ?? '';
  let repaired = false;

  if (!process.env.HOME && fallbackHome) {
    process.env.HOME = fallbackHome;
    repaired = true;
  }
  if (!process.env.USER && fallbackUser) {
    process.env.USER = fallbackUser;
    repaired = true;
  }
  if (!process.env.LOGNAME) {
    const logname = process.env.USER ?? fallbackUser;
    if (logname) {
      process.env.LOGNAME = logname;
      repaired = true;
    }
  }

  if (repaired) {
    // Loud on purpose. Failing every turn is a far worse outcome than a noisy
    // line at startup, and if these were empty it is an app bug, not a user one.
    log.warn(
      `backfilled identity variables (HOME=${process.env.HOME ?? ''} USER=${process.env.USER ?? ''} LOGNAME=${process.env.LOGNAME ?? ''}). ` +
        'Claude Code reads its credentials from the login Keychain by user identity, so without these every turn fails "Not logged in".',
    );
  }

  const inherited = process.env.PATH ?? '';
  const shell = process.env.SHELL || '/bin/zsh';
  let source: EnvRepairReport['pathSource'] = 'inherited';
  let pathError: string | undefined;

  const cache = readCache();
  const cacheUsable = cache !== null && cache.shell === shell && Date.now() - cache.at < CACHE_TTL_MS;

  if (options.force || looksMinimal(inherited) || !cacheUsable) {
    const recovered = askLoginShell(shell);
    if (recovered) {
      process.env.PATH = mergePaths(recovered, inherited);
      source = 'login-shell';
      writeCache({ shell, path: recovered, at: Date.now() });
    } else if (cache) {
      process.env.PATH = mergePaths(cache.path, inherited);
      source = 'cache';
      pathError = `could not ask ${shell} for the login PATH, using the cached copy`;
    } else if (looksMinimal(inherited)) {
      source = 'inherited-after-failure';
      pathError = `could not ask ${shell} for the login PATH, and the inherited one has no developer tools on it`;
      log.warn(pathError);
    }
  } else if (cache) {
    process.env.PATH = mergePaths(cache.path, inherited);
    source = 'cache';
  }

  lastReport = {
    user: process.env.USER ?? '',
    home: process.env.HOME ?? '',
    logname: process.env.LOGNAME ?? '',
    repaired,
    path: process.env.PATH ?? '',
    pathSource: source,
    ...(pathError ? { pathError } : {}),
  };

  log.info(`PATH ready (${source}), ${lastReport.path.split(delimiter).filter(Boolean).length} entries`);
  return lastReport;
}
