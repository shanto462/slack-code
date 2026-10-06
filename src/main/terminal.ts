/**
 * Handing one Slack thread's Claude session to a terminal on this machine.
 *
 * A session id plus a working directory is exactly what `claude --resume`
 * takes, so a row in the Sessions table can carry the conversation out of Slack
 * and let it continue in a terminal window.
 *
 * THIS IS THE APP'S ONLY EXECUTE-A-FILE PATH HANDOFF, and it inherits no
 * existing guard. The `OPENABLE` allowlist in ipc.ts gates URL *schemes* for
 * `openExternal` and has no bearing on `openPath`; `shell.showItemInFolder`
 * only reveals in Finder and cannot execute. So the three refusals and the
 * quoting below are the whole of the protection, not a second layer on top of
 * one. Packaging does not save us either: electron-builder.yml sets
 * `hardenedRuntime: false` with no App Sandbox entitlement.
 *
 * Two rules follow from that, and neither is optional.
 *
 * 1. `openSessionInTerminal` takes ONLY a thread key. The session id and the
 *    directory are read back out of SQLite here, so nothing the renderer
 *    supplies ever reaches the script. Do not add a convenience overload that
 *    accepts a path or a session id over IPC.
 * 2. Every value interpolated into the script is single-quoted. Both values
 *    come from the database, but a project directory is user-supplied text that
 *    got there through a directory picker.
 *
 * NOT AppleScript. `osascript -e 'tell app "Terminal" to do script …'` is the
 * obvious approach and it is the wrong one: driving another app needs an
 * Automation grant under TCC, which prompts once, can be denied, and once
 * denied fails silently forever with no way for this app to ask again. It also
 * hard-codes Terminal.app. Opening a `.command` file goes through
 * LaunchServices instead, needs no permission at all, and respects an operator
 * who has made iTerm the handler for shell scripts.
 */

import { shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { chmodSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { logger } from '../core/log.ts';
import { err, ok, type Result, type Storage } from '../shared/contract.ts';
import { locateClaudeBinary } from './binary.ts';
import { terminalScriptDir } from './paths.ts';

const log = logger('terminal');

/**
 * Claude Code session ids are UUIDs. This is the belt to the single-quoting's
 * braces: a value that cannot match this never reaches the script at all.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** Scripts older than this are swept on the next call. */
const SCRIPT_TTL_MS = 60 * 60 * 1000;

/**
 * Write the script and ask the OS to open it. Failures come back as `Result`
 * with a distinct code each, so the renderer can say something true rather than
 * flashing a generic error at somebody whose thread simply has not run a turn.
 */
export async function openSessionInTerminal(storage: Storage, key: string): Promise<Result<null>> {
  // Typed as a string in the contract, checked anyway: the one thing that must
  // never happen here is a throw that escapes as a rejected invoke instead of a
  // Result the renderer knows how to show.
  if (typeof key !== 'string') return err('Not a thread key.', 'bad_key');

  // Split on the FIRST colon only: a Slack thread_ts is `1712345678.000100`,
  // so the tail is safe to take whole, and a channel id never contains a colon.
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) return err(`Not a thread key: ${key}`, 'bad_key');
  const channel = key.slice(0, separator);
  const threadTs = key.slice(separator + 1);

  const record = storage.getThread(channel, threadTs);
  if (!record) return err('That thread is no longer in the database, so there is nothing to open.', 'no_thread');

  const sessionId = record.sessionId;
  if (!sessionId) return err('This thread has not run a turn yet, so there is no session to open.', 'no_session');
  if (!SESSION_ID.test(sessionId)) {
    log.warn(`refusing to resume a session id that is not the expected shape: ${sessionId}`);
    return err('The stored session id is not a shape this app will put in a script.', 'bad_session');
  }

  const cwd = record.cwd;
  // Absolute, because `cd` in the script runs from whatever directory the
  // terminal starts in, while statSync here resolves against the main process's
  // cwd. A relative path would therefore verify one directory and open another.
  // existsSync followed by statSync would be two syscalls and still race, so the
  // throw IS the missing-directory answer.
  let isDirectory = false;
  try {
    isDirectory = isAbsolute(cwd) && statSync(cwd).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) return err(`The project directory is not there any more: ${cwd || '(none recorded)'}`, 'no_cwd');

  let file: string;
  try {
    const dir = terminalScriptDir();
    sweep(dir);
    file = join(dir, `resume-${randomBytes(6).toString('hex')}.command`);
    writeFileSync(file, buildScript(cwd, sessionId), { encoding: 'utf8', mode: 0o700 });
    // Terminal will not run a `.command` without the executable bit, and
    // writeFileSync's mode is filtered through the umask.
    chmodSync(file, 0o700);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error), 'write_failed');
  }

  // openPath resolves with an empty string on success and with the failure text
  // otherwise. It does not reject.
  const failure = await shell.openPath(file);
  if (failure) return err(failure, 'open_failed');
  log.info(`opened session ${sessionId.slice(0, 8)} in a terminal at ${cwd}`);
  return ok(null);
}

/**
 * The script itself.
 *
 * The operator's own `claude` on PATH is preferred, because that is the install
 * they know and keep updated; the SDK's bundled CLI is the fallback, and it is
 * the binary that actually produced the session.
 *
 * Whether `command -v claude` finds anything depends on the PATH the shell
 * Terminal starts exports, and that is a measurement rather than a deduction.
 * This is the same hazard `main/env.ts` exists to solve from the other
 * direction: it asks the login shell with `-lic`, login AND interactive,
 * precisely because on zsh both nvm and `brew shellenv` are usually sourced
 * from ~/.zshrc rather than ~/.zprofile. Terminal's shell is both, so the
 * `#!/bin/sh` child should inherit a full PATH, and the fallback line below is
 * what catches the machine where it does not.
 */
function buildScript(cwd: string, sessionId: string): string {
  const binary = locateClaudeBinary();
  const resume = `--resume ${quote(sessionId)}`;
  const lines = [
    '#!/bin/sh',
    '# Written by slack-code so a Slack thread can be opened in the CLI. Safe to delete.',
    `cd ${quote(cwd)} || exit 1`,
    'if command -v claude >/dev/null 2>&1; then',
    `  exec claude ${resume}`,
    'fi',
  ];

  // `problem` is the whole reason locateClaudeBinary returns an object rather
  // than a path: an exec of a file that is missing or not executable flashes
  // the window shut with nothing readable in it, so say why and exit instead.
  if (binary.exists && binary.executable) {
    lines.push(`exec ${quote(binary.path)} ${resume}`);
  } else {
    lines.push(
      `echo ${quote('slack-code: no claude on PATH, and the bundled CLI cannot be used.')} >&2`,
      `echo ${quote(binary.problem ?? 'The Claude Code CLI could not be located.')} >&2`,
      'exit 127',
    );
  }

  return `${lines.join('\n')}\n`;
}

/** POSIX single-quoting: close the quote, escape the quote, open a new one. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Age-based, not "delete everything except the one just written": two fast
 * clicks would then delete the first script before Terminal had opened it.
 */
function sweep(dir: string): void {
  const cutoff = Date.now() - SCRIPT_TTL_MS;
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      } catch {
        // Raced with another sweep, or with the operator deleting it by hand.
      }
    }
  } catch (error) {
    // A directory that cannot be swept is untidy, not broken, so the open goes
    // ahead anyway.
    log.debug('could not sweep the terminal script directory', error);
  }
}
