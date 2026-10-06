/**
 * The checks main owns, plus the "Copy Diagnostics" blob.
 *
 * Everything that can be verified without Electron lives in core, so that
 * `npm run doctor` and the wizard run the same code. What is left here needs
 * something only the main process has: safeStorage, the packaged app identity,
 * and the machine's launchd state.
 */

import { app } from 'electron';
import { checkShellPath } from '../core/checks.ts';
import type {
  AppInfo,
  DaemonStatus,
  LogLine,
  SetupCheckResult,
  ShellPathCheckData,
  StoredConfig,
} from '../shared/contract.ts';
import { environmentReport } from './env.ts';
import { locateClaudeBinary } from './binary.ts';
import { configPath, logDir, stateDir, userDataDir } from './paths.ts';
import { encryptionAvailable } from './secrets.ts';

export function appInfo(): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node ?? '',
    chromeVersion: process.versions.chrome ?? '',
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    userDataPath: userDataDir(),
    stateDir: stateDir(),
    logDir: logDir(),
    configPath: configPath(),
  };
}

export function checkSafeStorage(): SetupCheckResult<null> {
  const available = encryptionAvailable();
  return {
    id: 'safeStorage',
    ok: available,
    label: 'encrypted storage',
    detail: available ? 'Keychain-backed encryption is available' : 'safeStorage reports encryption is unavailable',
    ...(available
      ? {}
      : {
          hint: 'The app will run from tokens held in memory and will not write them to disk. They have to be entered again after every restart.',
        }),
    severity: available ? 'error' : 'warning',
    ranAt: Date.now(),
  };
}

/**
 * `unknown` is a real answer, not a fudge: --doctor deliberately does not take
 * the instance lock, so it cannot tell whether another copy holds it, and
 * printing an unverified green would be worse than saying so.
 */
export function checkSingleInstance(held: boolean | 'unknown'): SetupCheckResult<null> {
  if (held === 'unknown') {
    return {
      id: 'singleInstance',
      ok: true,
      label: 'single instance',
      detail: 'not checked, because this mode does not take the instance lock',
      severity: 'warning',
      ranAt: Date.now(),
    };
  }
  return {
    id: 'singleInstance',
    ok: held,
    label: 'single instance',
    detail: held ? 'this is the only copy of the app running' : 'another copy of the app already holds the instance lock',
    ...(held
      ? {}
      : { hint: 'Quit the other copy. Two copies on one app token each receive every DM and each run it.' }),
    severity: 'error',
    ranAt: Date.now(),
  };
}

/**
 * Core decides whether the PATH is usable; only main knows where that PATH came
 * from, because main is what repaired it. Core infers `recovered` from whether
 * the PATH holds anything beyond the system directories, which is a good proxy
 * but not the truth, so the real provenance is corrected here.
 *
 * Nothing about the check itself is recomputed. The verdict, severity and hint
 * are core's.
 */
export function enrichShellPath(result: SetupCheckResult<ShellPathCheckData>): SetupCheckResult<ShellPathCheckData> {
  const report = environmentReport();
  if (!report || !result.data) return result;

  return {
    ...result,
    detail: `${result.detail} (PATH from: ${report.pathSource})`,
    data: { ...result.data, recovered: report.pathSource === 'login-shell' || report.pathSource === 'cache' },
  };
}

export interface DiagnosticsInput {
  config: StoredConfig;
  status: DaemonStatus;
  checks: SetupCheckResult[];
  logs: LogLine[];
}

/**
 * One pasteable block. Everything here is either non-secret by construction
 * (config.json holds no tokens) or already redacted at the log source.
 */
export function buildDiagnosticsText(input: DiagnosticsInput): string {
  const info = appInfo();
  const env = environmentReport();
  const binary = locateClaudeBinary();
  const lines: string[] = [];

  lines.push('# slack-code diagnostics', '');
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`app: ${info.appVersion} (${info.isPackaged ? 'packaged' : 'dev'})`);
  lines.push(`electron ${info.electronVersion} · node ${info.nodeVersion} · chrome ${info.chromeVersion}`);
  lines.push(`platform: ${info.platform}-${info.arch}`);
  lines.push(`userData: ${info.userDataPath}`);
  lines.push(`logs: ${info.logDir}`);
  lines.push('');

  lines.push('## environment');
  if (env) {
    lines.push(`USER=${env.user} LOGNAME=${env.logname} HOME=${env.home}${env.repaired ? ' (backfilled by the app)' : ''}`);
    lines.push(`PATH source: ${env.pathSource}${env.pathError ? ` (${env.pathError})` : ''}`);
    lines.push(`PATH: ${env.path}`);
  } else {
    lines.push('environment repair had not run when this was generated');
  }
  for (const tool of checkShellPath().data?.tools ?? []) lines.push(`  ${tool.name}: ${tool.resolved ?? 'NOT FOUND'}`);
  lines.push(`claude CLI: ${binary.path || 'unresolved'}${binary.problem ? ` (${binary.problem})` : ''}`);
  lines.push('');

  lines.push('## service');
  lines.push(`state: ${input.status.state}${input.status.detail ? ` (${input.status.detail})` : ''}`);
  lines.push(`workspace: ${input.status.identity ? `${input.status.identity.botName} in ${input.status.identity.teamName}` : 'not connected'}`);
  lines.push(`operators resolved: ${input.status.allowlist.resolved.length}, unresolved: ${input.status.allowlist.unresolved.length}`);
  lines.push(`active threads: ${input.status.activeThreads.length}`);
  lines.push('');

  lines.push('## config');
  lines.push(`setup complete: ${Boolean(input.config.setupCompletedAt)}`);
  lines.push(`model: ${input.config.agent.model} · effort: ${input.config.agent.effort} · permission mode: ${input.config.agent.permissionMode}`);
  lines.push(`projects: ${input.config.projects.length}`);
  for (const project of input.config.projects) {
    lines.push(`  ${project.alias} -> ${project.dir}${project.enabled ? '' : ' (paused)'}`);
  }
  lines.push(
    `routing: default=${input.config.routing.defaultProjectId ?? 'none'} singleFallback=${input.config.routing.singleProjectFallback} pendingBind=${input.config.routing.pendingBindMinutes}m`,
  );
  lines.push(
    `tuning: idle=${input.config.tuning.sessionIdleMinutes}m stall=${input.config.tuning.turnStallMinutes}m catchup=${input.config.tuning.catchupWindowHours}h status=${input.config.tuning.statusUpdateMs}ms heartbeat=${input.config.tuning.streamProgressHeartbeat}`,
  );
  lines.push('');

  lines.push('## checks');
  for (const check of input.checks) {
    lines.push(`${check.ok ? 'ok  ' : check.severity === 'warning' ? 'warn' : 'FAIL'}  ${check.label}: ${check.detail}`);
    if (!check.ok && check.hint) lines.push(`      hint: ${check.hint}`);
  }
  lines.push('');

  lines.push(`## last ${input.logs.length} log lines`);
  for (const line of input.logs) {
    const stamp = new Date(line.at).toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`${stamp} ${line.level.toUpperCase().padEnd(5)} [${line.scope}] ${line.message}`);
  }

  return lines.join('\n');
}
