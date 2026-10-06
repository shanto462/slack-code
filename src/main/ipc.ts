/**
 * Every renderer-to-main channel in the contract, and nothing else.
 *
 * Two rules run through the whole file.
 *
 * SENDER. Every handler verifies the sender is this app's own window before it
 * acts. These handlers hold Slack tokens and can start an agent that runs shell
 * commands, so the check matters more here than in a typical app.
 *
 * ERRORS. Failures travel as Result<T>, never as a thrown custom error.
 * contextBridge drops custom Error properties, class prototypes and Symbols, so
 * a rich error object would arrive in the renderer as a bare message with no
 * code. The only things thrown are programmer errors the renderer cannot handle
 * anyway, such as a call from a frame that is not ours.
 */

import { clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { checkAppToken, checkBotToken, checkAllowlist } from '../core/checks.ts';
import { normaliseConfig, validateConfig } from '../core/config.ts';
import { logger } from '../core/log.ts';
import {
  IPC,
  err,
  ok,
  type DeepPartial,
  type LogQuery,
  type ProjectDraft,
  type ProjectId,
  type SessionQuery,
  type SetupCheckId,
  type StoredConfig,
  type ThemeMode,
  type TurnQuery,
} from '../shared/contract.ts';
import type { MainApp } from './app.ts';
import { loginItemState } from './autostart.ts';
import { appInfo, buildDiagnosticsText } from './diagnostics.ts';
import { slackAppManifest } from './manifest.ts';
import { mergeConfig } from './settings.ts';
import { openSessionInTerminal } from './terminal.ts';
import { currentTheme } from './theme.ts';
import { mainWindow } from './window.ts';

const log = logger('ipc');

/** Schemes the renderer is allowed to hand to the OS. */
const OPENABLE = new Set(['https:', 'http:', 'slack:', 'mailto:']);

export interface IpcDeps {
  quit: () => void;
}

function assertOwnWindow(event: IpcMainInvokeEvent): void {
  const target = mainWindow();
  if (target && event.sender === target.webContents) return;
  log.warn('rejected an IPC call from a sender that is not the app window');
  throw new Error('This message did not come from the slack-code window.');
}

export function registerIpc(instance: MainApp, deps: IpcDeps): void {
  const handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      assertOwnWindow(event);
      return handler(event, ...(args as never[]));
    });
  };

  // --- config --------------------------------------------------------------

  handle(IPC.configGet, () => instance.config);

  handle(IPC.configSave, (_event, patch: DeepPartial<StoredConfig>) => instance.saveConfig(patch ?? {}));

  handle(IPC.configValidate, (_event, candidate: DeepPartial<StoredConfig>) =>
    validateConfig(normaliseConfig(mergeConfig(instance.config, candidate ?? {}))),
  );

  // --- secrets (write only) ------------------------------------------------

  handle(IPC.secretsStatus, () => instance.secretsStatus());

  handle(IPC.secretsSet, (_event, input: { botToken?: string; appToken?: string }) => instance.setSecrets(input ?? {}));

  handle(IPC.secretsClear, () => instance.clearSecrets());

  // --- projects ------------------------------------------------------------

  handle(IPC.projectsAdd, (_event, draft: ProjectDraft) => instance.addProject(draft));

  handle(IPC.projectsUpdate, (_event, draft: ProjectDraft & { id: ProjectId }) => instance.updateProject(draft));

  handle(IPC.projectsRemove, (_event, id: ProjectId) => instance.removeProject(id));

  handle(IPC.projectsReorder, (_event, ids: ProjectId[]) => instance.reorderProjects(ids ?? []));

  handle(IPC.dialogPickDirectory, async () => {
    const parent = mainWindow();
    const options = {
      title: 'Choose a project directory',
      properties: ['openDirectory' as const, 'createDirectory' as const],
      buttonLabel: 'Use this folder',
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  // --- slack setup ---------------------------------------------------------

  handle(IPC.slackVerifyBotToken, (_event, token: string) => checkBotToken((token ?? '').trim()));

  handle(IPC.slackVerifyAppToken, (_event, token: string) => checkAppToken((token ?? '').trim()));

  handle(IPC.slackListUsers, async () => {
    const slack = instance.slackClient();
    if (!slack) return err('Save the bot token first, then the workspace can be listed.', 'no_token');
    try {
      return ok(await slack.listWorkspaceUsers());
    } catch (error) {
      return err(describeSlackError(error), 'slack_failed');
    }
  });

  handle(IPC.slackResolveAllowlist, (_event, entries: string[]) => {
    const token = instance.botToken();
    if (!token) {
      return {
        id: 'allowlist' as SetupCheckId,
        ok: false,
        label: 'operators',
        detail: 'A bot token is needed before Slack names can be resolved.',
        severity: 'error' as const,
        ranAt: Date.now(),
      };
    }
    return checkAllowlist(token, entries ?? []);
  });

  handle(IPC.slackHandshakeStart, () => {
    const botToken = instance.botToken();
    const appToken = instance.appToken();
    if (!botToken || !appToken) return err('Both tokens are needed before the handshake can run.', 'no_tokens');
    return instance.handshake.start({ botToken, appToken });
  });

  handle(IPC.slackHandshakeCancel, () => instance.handshake.cancel());

  handle(IPC.slackAppManifest, () => slackAppManifest());

  // --- checks --------------------------------------------------------------

  handle(IPC.checksRunAll, () => instance.runAllChecks());

  handle(IPC.checksRunOne, (_event, id: SetupCheckId, arg?: { projectId?: ProjectId; dir?: string }) =>
    instance.runCheck(id, arg),
  );

  // --- service -------------------------------------------------------------

  handle(IPC.serviceStart, () => instance.startService());

  handle(IPC.serviceStop, () => instance.stopService());

  handle(IPC.serviceRestart, () => instance.restartService());

  handle(IPC.serviceStatus, () => instance.status());

  handle(IPC.serviceSelftest, (_event, projectId: ProjectId) => instance.selftest(projectId));

  handle(IPC.serviceResetThread, (_event, key: string) => instance.resetThread(key));

  handle(IPC.serviceCancelQueued, (_event, key: string) => instance.cancelQueued(key));

  // --- app -----------------------------------------------------------------

  handle(IPC.appInfo, () => appInfo());

  handle(IPC.appGetLoginItem, () => loginItemState());

  handle(IPC.appSetLoginItem, async (_event, enabled: boolean) => {
    // One path only: the setting is saved, and saving is what talks to macOS
    // and writes back whatever macOS actually did.
    await instance.saveConfig({ app: { runAtLogin: Boolean(enabled) } });
    return loginItemState();
  });

  handle(IPC.appCompleteSetup, async () => {
    if (!instance.hasTokens()) return err('Both Slack tokens are needed before setup can be completed.', 'no_tokens');
    if (instance.config.projects.length === 0) return err('Add at least one project before finishing setup.', 'no_projects');

    const saved = await instance.saveConfig({ setupCompletedAt: new Date().toISOString() });
    if (!saved.ok) return err(saved.error, saved.code);

    if (instance.config.app.connectOnLaunch) {
      const started = await instance.startService();
      // Setup itself succeeded even if the first connection did not, so the
      // wizard finishes and the dashboard shows why the bridge is not up.
      if (!started.ok) log.warn(`setup completed, but the bridge did not start: ${started.error}`);
    }
    return ok(null);
  });

  handle(IPC.appEnvCandidate, () => instance.envCandidate());

  handle(IPC.appImportEnv, () => instance.importEnv());

  handle(IPC.appOpenExternal, async (_event, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return err(`Not a URL: ${url}`, 'bad_url');
    }
    if (!OPENABLE.has(parsed.protocol)) return err(`Refusing to open a ${parsed.protocol} URL.`, 'bad_scheme');
    try {
      await shell.openExternal(parsed.toString());
      return ok(null);
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error), 'open_failed');
    }
  });

  handle(IPC.appRevealPath, (_event, path: string) => {
    if (!path) return err('No path given.', 'bad_path');
    shell.showItemInFolder(path);
    return ok(null);
  });

  handle(IPC.appCopyDiagnostics, async () => {
    try {
      const text = buildDiagnosticsText({
        config: instance.config,
        status: instance.status(),
        checks: await instance.runAllChecks(),
        logs: instance.logTail(200),
      });
      clipboard.writeText(text);
      return ok(text);
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error), 'diagnostics_failed');
    }
  });

  handle(IPC.appQuit, () => {
    deps.quit();
  });

  // --- data ----------------------------------------------------------------

  handle(IPC.logsTail, (_event, limit?: number) => instance.logTail(limit));

  handle(IPC.logsQuery, (_event, query?: LogQuery) => instance.storage.queryLogs(query));

  handle(IPC.turnsRecent, (_event, query?: TurnQuery) => instance.storage.recentTurns(query));

  handle(IPC.sessionsList, (_event, query?: SessionQuery) => instance.storage.sessions(query));

  // A key, and nothing else. The session id and the project directory are read
  // from SQLite inside terminal.ts, because what it does with them is write a
  // shell script and hand it to the OS to execute. See the header of that file.
  handle(IPC.sessionsOpen, (_event, key: string) => openSessionInTerminal(instance.storage, key ?? ''));

  // Deletes rows, so it goes through the service rather than straight to
  // storage: the service is what owns the live Session for this thread and what
  // refuses while a turn is running.
  handle(IPC.sessionsRemove, (_event, key: string) => instance.removeSession(key ?? ''));

  // --- appearance ----------------------------------------------------------

  handle(IPC.themeGet, () => currentTheme());

  handle(IPC.themeSetMode, async (_event, mode: ThemeMode) => {
    await instance.saveConfig({ app: { themeMode: mode } });
    return currentTheme();
  });

  log.debug(`registered ${Object.keys(IPC).length} IPC handlers`);
}

export function unregisterIpc(): void {
  for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel);
}

/** Slack hangs the useful part of an API failure off `data.error`. */
function describeSlackError(error: unknown): string {
  const code = (error as { data?: { error?: string } })?.data?.error;
  if (code === 'missing_scope') return 'The bot token is missing the users:read scope. Add it and reinstall the app.';
  if (code === 'invalid_auth') return 'Slack rejected that bot token. It may have been revoked or belong to another workspace.';
  if (code) return `Slack returned ${code}.`;
  return error instanceof Error ? error.message : String(error);
}
