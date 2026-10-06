import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import {
  SLACK_REQUIRED_APP_SCOPES,
  type AllowlistResolution,
  type ClaudeBinaryCheckData,
  type ProjectDirCheckData,
  type ResolvedProject,
  type SetupCheckId,
  type SetupCheckResult,
  type ShellPathCheckData,
  type SlackIdentity,
  type UserIdentityCheckData,
} from '../shared/contract.ts';
import { Slack } from './slack.ts';

/**
 * One implementation of every verification, shared by `--doctor` and by the
 * setup wizard over IPC. No verification logic exists twice, which is the whole
 * reason doctor's inline prints were pulled apart.
 */

const run = promisify(execFile);

function make<T>(
  id: SetupCheckId,
  label: string,
  ok: boolean,
  detail: string,
  extra: { hint?: string; data?: T; severity?: 'error' | 'warning'; durationMs?: number } = {},
): SetupCheckResult<T> {
  const result: SetupCheckResult<T> = {
    id,
    ok,
    label,
    detail,
    severity: extra.severity ?? 'error',
    ranAt: Date.now(),
  };
  if (extra.hint) result.hint = extra.hint;
  if (extra.data !== undefined) result.data = extra.data;
  if (extra.durationMs !== undefined) result.durationMs = extra.durationMs;
  return result;
}

function slackErrorCode(error: unknown): string {
  const code = (error as { data?: { error?: string } })?.data?.error;
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

/** Map a raw Slack error onto something the operator can actually act on. */
function slackHint(code: string): string {
  switch (code) {
    case 'invalid_auth':
    case 'token_revoked':
      return 'That token was revoked, or it belongs to a different workspace. Reinstall the app and copy the Bot User OAuth Token again.';
    case 'account_inactive':
      return 'The bot user is deactivated. Reinstall the app to the workspace.';
    case 'not_allowed_token_type':
      return 'That is not the right kind of token for this call. The bot token starts with xoxb-, the app-level token with xapp-.';
    case 'missing_scope':
      return 'The app is missing a scope. Add the scopes from the manifest step, then reinstall the app.';
    case 'ratelimited':
      return 'Slack is rate limiting this workspace. Wait a minute and retry.';
    default:
      return `Slack said "${code}".`;
  }
}

function isNetworkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code ?? '';
  return ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

// --- Slack -----------------------------------------------------------------

export async function checkBotToken(token: string): Promise<SetupCheckResult<SlackIdentity>> {
  const trimmed = token.trim();
  if (!trimmed) return make('botToken', 'bot token', false, 'Not set.', { hint: 'Paste the Bot User OAuth Token.' });
  if (!trimmed.startsWith('xoxb-')) {
    return make('botToken', 'bot token', false, 'Does not start with xoxb-.', {
      hint: 'This looks like the app-level token. The bot token is under OAuth & Permissions.',
    });
  }

  const started = Date.now();
  try {
    const identity = await new Slack(trimmed).whoAmI();
    return make('botToken', 'bot token', true, `${identity.botName} in ${identity.teamName}`, {
      data: identity,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    if (isNetworkError(error)) {
      return make('botToken', 'bot token', false, 'Could not reach Slack.', {
        hint: 'Check the network and retry. The token was not rejected, the request never arrived.',
        durationMs: Date.now() - started,
      });
    }
    const code = slackErrorCode(error);
    return make('botToken', 'bot token', false, code, { hint: slackHint(code), durationMs: Date.now() - started });
  }
}

export async function checkAppToken(token: string): Promise<SetupCheckResult<null>> {
  const trimmed = token.trim();
  if (!trimmed) return make('appToken', 'app token', false, 'Not set.', { hint: 'Paste the app-level token.' });
  if (!trimmed.startsWith('xapp-')) {
    return make('appToken', 'app token', false, 'Does not start with xapp-.', {
      hint: `Generate one under Basic Information -> App-Level Tokens with the ${SLACK_REQUIRED_APP_SCOPES.join(', ')} scope.`,
    });
  }

  const started = Date.now();
  try {
    const response = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    const body = (await response.json()) as { ok: boolean; error?: string };
    if (body.ok) {
      return make('appToken', 'app token', true, 'Socket Mode connection ticket issued.', { durationMs: Date.now() - started });
    }
    const code = body.error ?? 'unknown_error';
    return make('appToken', 'app token', false, code, {
      hint:
        code === 'not_allowed_token_type'
          ? 'That is not an app-level token. Generate one under Basic Information -> App-Level Tokens with connections:write.'
          : slackHint(code),
      durationMs: Date.now() - started,
    });
  } catch (error) {
    return make('appToken', 'app token', false, isNetworkError(error) ? 'Could not reach Slack.' : String(error), {
      hint: 'Check the network and retry.',
      durationMs: Date.now() - started,
    });
  }
}

export async function checkAllowlist(token: string, entries: string[]): Promise<SetupCheckResult<AllowlistResolution>> {
  const cleaned = entries.map((entry) => entry.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return make('allowlist', 'operators', false, 'Nobody is on the list.', {
      hint: 'Add at least one Slack user. The service refuses to start if the allowlist resolves to nobody.',
      data: { resolved: [], unresolved: [] },
    });
  }

  const started = Date.now();
  try {
    const resolution = await new Slack(token).resolveUsers(cleaned);
    const ok = resolution.resolved.length > 0;
    const detail = ok
      ? resolution.resolved.map((user) => `${user.name} (${user.id})`).join(', ')
      : 'No entry matched a real Slack user.';
    const check = make('allowlist', 'operators', ok, detail, {
      data: resolution,
      durationMs: Date.now() - started,
      ...(resolution.unresolved.length > 0
        ? { hint: `These matched nobody: ${resolution.unresolved.join(', ')}. Use the exact username, display name, or the Uxxxx id.` }
        : {}),
    });
    // Unmatched entries alongside at least one match is a warning, not a stop.
    if (ok && resolution.unresolved.length > 0) check.severity = 'warning';
    return check;
  } catch (error) {
    const code = slackErrorCode(error);
    return make('allowlist', 'operators', false, code, { hint: slackHint(code), durationMs: Date.now() - started });
  }
}

// --- machine ---------------------------------------------------------------

/**
 * Claude Code resolves its credentials from the macOS login Keychain by USER
 * IDENTITY, not by binary path. A process without HOME, USER and LOGNAME starts
 * cleanly and then fails EVERY turn with "Not logged in". Main repairs these at
 * startup; this reports what the agent will actually inherit.
 */
export function checkUserIdentity(): SetupCheckResult<UserIdentityCheckData> {
  let info: { username: string; homedir: string } | null = null;
  try {
    const os = userInfo();
    info = { username: os.username, homedir: os.homedir };
  } catch {
    info = null;
  }

  const user = process.env.USER ?? '';
  const logname = process.env.LOGNAME ?? '';
  const home = process.env.HOME ?? '';
  const repaired = !user || !logname || !home;

  const data: UserIdentityCheckData = {
    user: user || info?.username || '',
    home: home || info?.homedir || homedir(),
    logname: logname || info?.username || '',
    repaired,
  };

  if (data.user && data.home && data.logname) {
    return make('userIdentity', 'user identity', true, `${data.user} at ${data.home}`, {
      data,
      ...(repaired
        ? { hint: 'One of HOME, USER or LOGNAME was missing and had to be backfilled. That is an app bug, not a setting.' }
        : {}),
      severity: repaired ? 'warning' : 'error',
    });
  }

  return make('userIdentity', 'user identity', false, 'HOME, USER or LOGNAME is unset and could not be recovered.', {
    data,
    hint: 'Claude Code will report "Not logged in" on every turn without these.',
  });
}

/** Resolve a command against a PATH string, the way execvp would. */
export function whichIn(command: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here, try the next directory.
    }
  }
  return null;
}

/**
 * A GUI app launched from Finder or a login item inherits a minimal PATH of
 * roughly /usr/bin:/bin:/usr/sbin:/sbin. The SDK's Bash tool spawns
 * `/bin/bash --noprofile --norc`, so no profile is read and the PATH is never
 * rebuilt: the agent gets a shell with no node, no npm and no rg, and every
 * "run the build and verify" instruction fails with "command not found".
 */
export function checkShellPath(): SetupCheckResult<ShellPathCheckData> {
  const path = process.env.PATH ?? '';
  const systemOnly = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '']);
  const recovered = path.split(delimiter).some((dir) => !systemOnly.has(dir));
  const tools = ['git', 'node', 'npm', 'rg'].map((name) => ({ name, resolved: whichIn(name, path) }));
  const missing = tools.filter((tool) => !tool.resolved).map((tool) => tool.name);
  const data: ShellPathCheckData = { path, recovered, tools };

  if (missing.length === 0) {
    return make('shellPath', 'shell PATH', true, `${tools.length} tools resolved`, { data });
  }
  return make('shellPath', 'shell PATH', false, `not on PATH: ${missing.join(', ')}`, {
    data,
    severity: recovered ? 'warning' : 'error',
    hint: recovered
      ? 'The login shell PATH was recovered but these tools are still missing. Install them, or the agent cannot run them.'
      : 'The app inherited the minimal launchd PATH. Refresh the PATH in Diagnostics, or the agent will fail with "command not found".',
  });
}

/**
 * The SDK resolves its CLI relative to its own module, which under asar returns
 * a path INSIDE app.asar. existsSync says true there, but spawn cannot execute
 * it, so main passes the unpacked path instead.
 */
export function resolveClaudeBinary(): { path: string; unpacked: boolean } | null {
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
    if (resolved.includes('app.asar') && !resolved.includes('app.asar.unpacked')) {
      return { path: resolved.replace('app.asar', 'app.asar.unpacked'), unpacked: true };
    }
    return { path: resolved, unpacked: false };
  } catch {
    return null;
  }
}

export async function checkClaudeBinary(path?: string): Promise<SetupCheckResult<ClaudeBinaryCheckData>> {
  const resolved = path ? { path, unpacked: path.includes('app.asar.unpacked') } : resolveClaudeBinary();
  if (!resolved) {
    return make('claudeBinary', 'claude binary', false, 'Could not resolve the Claude Code CLI.', {
      hint: `Expected @anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch} to be installed.`,
    });
  }

  const data: ClaudeBinaryCheckData = { path: resolved.path, executable: false, unpacked: resolved.unpacked };
  if (!existsSync(resolved.path)) {
    return make('claudeBinary', 'claude binary', false, `Missing at ${resolved.path}`, {
      data,
      hint: resolved.unpacked ? 'The build did not unpack the CLI out of app.asar. Check asarUnpack.' : 'Reinstall dependencies.',
    });
  }
  try {
    accessSync(resolved.path, constants.X_OK);
    data.executable = true;
  } catch {
    return make('claudeBinary', 'claude binary', false, `Not executable: ${resolved.path}`, {
      data,
      hint: 'Fix the file mode (it should be 0755).',
    });
  }

  const started = Date.now();
  try {
    const { stdout } = await run(resolved.path, ['--version'], { timeout: 15_000 });
    data.version = stdout.trim().split('\n')[0];
  } catch {
    // A version probe that fails is not fatal: the binary is there and runnable.
  }
  return make('claudeBinary', 'claude binary', true, data.version ? `${data.version} at ${resolved.path}` : resolved.path, {
    data,
    durationMs: Date.now() - started,
  });
}

/**
 * The one check that proves the agent can actually authenticate. Slack being
 * reachable says nothing about it. `permissionMode: 'plan'` is what makes this
 * safe to run against a real directory: it reads and reasons, never modifies.
 */
export async function checkClaudeAuth(project: ResolvedProject, executablePath?: string): Promise<SetupCheckResult<null>> {
  const started = Date.now();
  try {
    const probe = query({
      prompt: 'Reply with exactly: OK',
      options: {
        cwd: project.dir,
        maxTurns: 1,
        permissionMode: 'plan',
        model: project.model,
        ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
      },
    });

    let authed = false;
    let detail = 'no result returned';
    for await (const message of probe) {
      if (message.type === 'result') {
        authed = !message.is_error;
        detail = message.subtype === 'success' ? message.result.slice(0, 60) : message.subtype;
        break;
      }
    }
    return make('claudeAuth', 'claude auth', authed, detail, {
      durationMs: Date.now() - started,
      ...(authed
        ? {}
        : { hint: 'Run `claude` in a terminal once and sign in. Credentials come from the login Keychain, keyed by user identity.' }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return make('claudeAuth', 'claude auth', false, message.slice(0, 200), {
      durationMs: Date.now() - started,
      hint: message.includes('Not logged in')
        ? 'The agent process is missing HOME/USER/LOGNAME, or nobody has signed in on this machine.'
        : 'The probe could not complete. Check the claude binary and the project directory.',
    });
  }
}

export function checkProjectDir(dir: string): SetupCheckResult<ProjectDirCheckData> {
  const data: ProjectDirCheckData = {
    dir,
    exists: false,
    isDirectory: false,
    isGitRepo: false,
    hasClaudeSettings: false,
    hasDenyRules: false,
  };

  if (!dir) return make('projectDir', 'project directory', false, 'No directory set.', { data, hint: 'Pick the project folder.' });

  try {
    data.exists = existsSync(dir);
    if (!data.exists) {
      return make('projectDir', 'project directory', false, `Does not exist: ${dir}`, {
        data,
        hint: 'The folder may have moved, or the drive may not be mounted.',
      });
    }
    data.isDirectory = statSync(dir).isDirectory();
    if (!data.isDirectory) {
      return make('projectDir', 'project directory', false, `Not a directory: ${dir}`, { data });
    }
    data.isGitRepo = existsSync(join(dir, '.git'));

    const settingsPath = join(dir, '.claude', 'settings.json');
    data.hasClaudeSettings = existsSync(settingsPath);
    if (data.hasClaudeSettings) {
      try {
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { permissions?: { deny?: unknown[] } };
        data.hasDenyRules = Array.isArray(parsed.permissions?.deny) && parsed.permissions.deny.length > 0;
      } catch {
        // Unreadable settings are the project's problem, not a setup failure.
      }
    }
  } catch (error) {
    return make('projectDir', 'project directory', false, `Cannot read ${dir}: ${String(error)}`, { data });
  }

  const notes = [data.isGitRepo ? 'git repo' : 'not a git repo', data.hasDenyRules ? 'has deny rules' : ''].filter(Boolean);
  return make('projectDir', 'project directory', true, `${dir} (${notes.join(', ')})`, { data });
}

/**
 * The pre-Electron launchd daemon. If it is still loaded, both it and this app
 * connect to Socket Mode, Slack load-balances events across the two
 * connections, and roughly half the DMs vanish into the old process. The
 * single-instance lock cannot catch this: they are different programs.
 */
export async function checkLegacyDaemon(): Promise<SetupCheckResult<{ loaded: boolean }>> {
  if (process.platform !== 'darwin') {
    return make('legacyDaemon', 'legacy daemon', true, 'Not applicable on this platform.', { data: { loaded: false } });
  }
  try {
    const { stdout } = await run('launchctl', ['list'], { timeout: 10_000 });
    const loaded = stdout.includes('com.slackcode.daemon');
    return make('legacyDaemon', 'legacy daemon', !loaded, loaded ? 'com.slackcode.daemon is still loaded.' : 'Not loaded.', {
      data: { loaded },
      ...(loaded
        ? {
            hint: 'Run `launchctl bootout gui/$(id -u)/com.slackcode.daemon`, otherwise the old daemon steals about half the DMs.',
          }
        : {}),
    });
  } catch {
    return make('legacyDaemon', 'legacy daemon', true, 'Could not run launchctl, assuming not loaded.', {
      data: { loaded: false },
      severity: 'warning',
    });
  }
}
