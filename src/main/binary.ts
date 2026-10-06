/**
 * Locating the Claude Code CLI that the agent SDK spawns.
 *
 * The SDK resolves its binary with `require.resolve` relative to its own
 * sdk.mjs. Under asar that returns a path INSIDE app.asar, where `existsSync`
 * answers true because Electron patches fs, but `spawn` cannot execute it:
 * Electron's own asar documentation says only `execFile` works for binaries
 * inside an archive, and the SDK uses `spawn`. So the path is rewritten into
 * app.asar.unpacked, which electron-builder's `asarUnpack` rule populates.
 *
 * In dev there is no asar, the SDK's own resolution already works, and this
 * returns undefined so `Options.pathToClaudeCodeExecutable` is left unset.
 */

import { app } from 'electron';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { resolveClaudeBinary } from '../core/checks.ts';
import { logger } from '../core/log.ts';

const log = logger('binary');

export interface BinaryLocation {
  path: string;
  exists: boolean;
  executable: boolean;
  /** True when the resolved path had to be rewritten out of app.asar. */
  unpacked: boolean;
  problem?: string;
}

/**
 * Full detail, including why it is unusable, so the failure surfaces once at
 * launch rather than once per turn as a confusing Slack reply. The resolution
 * and the asar rewrite are core's, since the doctor check needs exactly the
 * same answer.
 */
export function locateClaudeBinary(): BinaryLocation {
  const resolved = resolveClaudeBinary();
  if (!resolved) {
    return {
      path: '',
      exists: false,
      executable: false,
      unpacked: false,
      problem: `The Claude Code CLI package for ${process.platform}-${process.arch} is not installed.`,
    };
  }

  if (!existsSync(resolved.path)) {
    return {
      path: resolved.path,
      exists: false,
      executable: false,
      unpacked: resolved.unpacked,
      problem: resolved.unpacked
        ? `The CLI was expected at ${resolved.path}. The build's asarUnpack rule did not unpack it.`
        : `The CLI is missing at ${resolved.path}.`,
    };
  }

  let executable = false;
  try {
    accessSync(resolved.path, constants.X_OK);
    executable = statSync(resolved.path).isFile();
  } catch {
    executable = false;
  }

  return {
    path: resolved.path,
    exists: true,
    executable,
    unpacked: resolved.unpacked,
    ...(executable ? {} : { problem: `${resolved.path} exists but is not executable.` }),
  };
}

/**
 * The value for RuntimeConfig.claudeExecutablePath. Undefined in dev, where the
 * SDK's own resolution is already correct, and undefined if resolution failed,
 * where passing a broken path would be worse than letting the SDK try.
 */
export function claudeBinaryPath(): string | undefined {
  if (!app.isPackaged) return undefined;
  const found = locateClaudeBinary();
  if (!found.exists || !found.executable) {
    log.error(found.problem ?? 'the Claude Code CLI could not be located');
    return undefined;
  }
  return found.path;
}
