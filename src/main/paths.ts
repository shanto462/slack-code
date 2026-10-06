/**
 * Every filesystem location the app writes to, resolved in one place.
 *
 * Nothing here derives a path from `import.meta.url`. The old daemon did that
 * for its state directory, which resolved relative to `dist/` and would break
 * completely once the code is inside app.asar. All app-owned paths hang off
 * `app.getPath`, which is correct in dev and packaged alike.
 */

import { app } from 'electron';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<userData>` differs between dev and packaged unless app.setName ran first. */
export function userDataDir(): string {
  return app.getPath('userData');
}

/** SQLite lives here. Created on demand, since a fresh install has no userData tree yet. */
export function stateDir(): string {
  const dir = join(userDataDir(), 'state');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(): string {
  return join(userDataDir(), 'config.json');
}

export function secretsPath(): string {
  return join(userDataDir(), 'secrets.json');
}

/**
 * Cache for the recovered login-shell PATH. Deliberately not in config.json:
 * it is a machine fact rather than a user setting, and rewriting config.json on
 * every launch would make the hand-editable file churn.
 */
export function envCachePath(): string {
  return join(userDataDir(), 'env-cache.json');
}

/**
 * Where `terminal.ts` writes the short-lived `.command` scripts that hand a
 * session to a terminal window.
 *
 * Mode 0700, and re-applied on every call rather than left to `mkdirSync`,
 * whose mode argument is filtered through the process umask and is ignored
 * outright for a directory that already exists. This is the one directory the
 * app asks the OS to EXECUTE something out of, so a directory another account
 * on this machine could write to would let it swap the script between the
 * write and LaunchServices opening it.
 */
export function terminalScriptDir(): string {
  const dir = join(userDataDir(), 'terminal');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * `~/Library/Logs/slack-code` once app.setAppLogsPath() has run. Without that
 * call it resolves to `.../Logs/Electron`, so index.ts sets it during boot.
 */
export function logDir(): string {
  const dir = app.getPath('logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function logFilePath(): string {
  return join(logDir(), 'slack-code.log');
}

/**
 * The repository root in dev, and the .app's Resources directory when packaged.
 * Used only to find build assets such as the tray icon; never for app state.
 *
 * In dev this file runs as `out/main/index.mjs`, so two levels up is the root.
 */
export function assetRoot(): string {
  if (app.isPackaged) return process.resourcesPath;
  return join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
}
