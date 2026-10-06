/**
 * The context bridge.
 *
 * This file is the ONLY route from the renderer to the main process, and it
 * exposes exactly the `Api` interface from the shared contract: no ipcRenderer,
 * no Node, and no way to read a Slack token back. `setSecrets` is write-only;
 * `secretsStatus` returns presence plus a redacted hint. That asymmetry is the
 * main prize of keeping the service in the main process, so do not add a
 * "getSecrets" here for convenience.
 *
 * Built to out/preload/index.cjs. It must stay CommonJS: the window runs with
 * `sandbox: true`, which forbids an ESM preload, and a sandboxed preload cannot
 * be split across files at runtime, so the bundler inlines everything reachable
 * from this entry. That is why the only import outside `electron` is the
 * contract, which has zero runtime imports of its own.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import { IPC, IPC_EVENTS } from '../shared/contract.ts';
import type {
  AppInfo,
  Api,
  DaemonStatus,
  DeepPartial,
  EnvMigrationCandidate,
  HandshakeResult,
  HandshakeSession,
  LogLine,
  LogQuery,
  LogRow,
  LoginItemState,
  ProjectConfig,
  ProjectDraft,
  ProjectId,
  RendererView,
  Result,
  SecretsStatus,
  SelfTestResult,
  SessionPage,
  SessionQuery,
  SetupCheckId,
  SetupCheckResult,
  SlackIdentity,
  SlackWorkspaceUser,
  StoredConfig,
  ThemeMode,
  ThemeState,
  TurnEvent,
  TurnQuery,
  TurnRow,
  Unsubscribe,
  ValidationReport,
  AllowlistResolution,
} from '../shared/contract.ts';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

/**
 * Strips the IpcRendererEvent before the payload reaches renderer code, so no
 * page script can ever touch `event.sender`. The try/catch matters: without it
 * one throwing subscriber would abort Electron's emit loop and silently drop
 * the event for every other subscriber on the same channel.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    try {
      cb(payload);
    } catch (error) {
      console.error(`[api] subscriber for ${channel} threw`, error);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.off(channel, listener);
  };
}

const api: Api = {
  // config
  getConfig: () => invoke<StoredConfig>(IPC.configGet),
  saveConfig: (patch: DeepPartial<StoredConfig>) => invoke<Result<StoredConfig>>(IPC.configSave, patch),
  validateConfig: (candidate: DeepPartial<StoredConfig>) => invoke<ValidationReport>(IPC.configValidate, candidate),

  // secrets (write-only by design)
  secretsStatus: () => invoke<SecretsStatus>(IPC.secretsStatus),
  setSecrets: (input: { botToken?: string; appToken?: string }) => invoke<Result<SecretsStatus>>(IPC.secretsSet, input),
  clearSecrets: () => invoke<Result<SecretsStatus>>(IPC.secretsClear),

  // projects
  addProject: (draft: ProjectDraft) => invoke<Result<ProjectConfig>>(IPC.projectsAdd, draft),
  updateProject: (draft: ProjectDraft & { id: ProjectId }) => invoke<Result<ProjectConfig>>(IPC.projectsUpdate, draft),
  removeProject: (id: ProjectId) => invoke<Result<null>>(IPC.projectsRemove, id),
  reorderProjects: (ids: ProjectId[]) => invoke<Result<ProjectConfig[]>>(IPC.projectsReorder, ids),
  pickDirectory: () => invoke<string | null>(IPC.dialogPickDirectory),

  // slack setup
  verifyBotToken: (token: string) => invoke<SetupCheckResult<SlackIdentity>>(IPC.slackVerifyBotToken, token),
  verifyAppToken: (token: string) => invoke<SetupCheckResult<null>>(IPC.slackVerifyAppToken, token),
  listWorkspaceUsers: () => invoke<Result<SlackWorkspaceUser[]>>(IPC.slackListUsers),
  resolveAllowlist: (entries: string[]) => invoke<SetupCheckResult<AllowlistResolution>>(IPC.slackResolveAllowlist, entries),
  startHandshake: () => invoke<Result<HandshakeSession>>(IPC.slackHandshakeStart),
  cancelHandshake: () => invoke<Result<null>>(IPC.slackHandshakeCancel),
  slackAppManifest: () => invoke<string>(IPC.slackAppManifest),

  // checks
  runAllChecks: () => invoke<SetupCheckResult[]>(IPC.checksRunAll),
  runCheck: (id: SetupCheckId, arg?: { projectId?: ProjectId; dir?: string }) =>
    invoke<SetupCheckResult>(IPC.checksRunOne, id, arg),

  // service
  startService: () => invoke<Result<null>>(IPC.serviceStart),
  stopService: () => invoke<Result<null>>(IPC.serviceStop),
  restartService: () => invoke<Result<null>>(IPC.serviceRestart),
  getStatus: () => invoke<DaemonStatus>(IPC.serviceStatus),
  runSelftest: (projectId: ProjectId) => invoke<Result<SelfTestResult>>(IPC.serviceSelftest, projectId),
  resetThread: (key: string) => invoke<Result<null>>(IPC.serviceResetThread, key),
  cancelQueued: (key: string) => invoke<Result<{ dropped: number }>>(IPC.serviceCancelQueued, key),

  // app
  appInfo: () => invoke<AppInfo>(IPC.appInfo),
  getLoginItem: () => invoke<LoginItemState>(IPC.appGetLoginItem),
  setLoginItem: (enabled: boolean) => invoke<LoginItemState>(IPC.appSetLoginItem, enabled),
  completeSetup: () => invoke<Result<null>>(IPC.appCompleteSetup),
  envCandidate: () => invoke<EnvMigrationCandidate | null>(IPC.appEnvCandidate),
  importEnv: () => invoke<Result<StoredConfig>>(IPC.appImportEnv),
  openExternal: (url: string) => invoke<Result<null>>(IPC.appOpenExternal, url),
  revealPath: (path: string) => invoke<Result<null>>(IPC.appRevealPath, path),
  copyDiagnostics: () => invoke<Result<string>>(IPC.appCopyDiagnostics),
  quit: () => invoke<void>(IPC.appQuit),

  // data, all served from SQLite through the Storage interface in core
  logTail: (limit?: number) => invoke<LogLine[]>(IPC.logsTail, limit),
  queryLogs: (query?: LogQuery) => invoke<LogRow[]>(IPC.logsQuery, query),
  recentTurns: (query?: TurnQuery) => invoke<TurnRow[]>(IPC.turnsRecent, query),
  listSessions: (query?: SessionQuery) => invoke<SessionPage>(IPC.sessionsList, query),
  // The key is the only argument by design. See Api.openSessionInTerminal.
  openSessionInTerminal: (key: string) => invoke<Result<null>>(IPC.sessionsOpen, key),
  removeSession: (key: string) => invoke<Result<{ turns: number }>>(IPC.sessionsRemove, key),

  // appearance
  getTheme: () => invoke<ThemeState>(IPC.themeGet),
  setThemeMode: (mode: ThemeMode) => invoke<ThemeState>(IPC.themeSetMode, mode),

  // subscriptions
  onStatus: (cb: (status: DaemonStatus) => void) => subscribe<DaemonStatus>(IPC_EVENTS.status, cb),
  onLog: (cb: (line: LogLine) => void) => subscribe<LogLine>(IPC_EVENTS.log, cb),
  onTurn: (cb: (event: TurnEvent) => void) => subscribe<TurnEvent>(IPC_EVENTS.turn, cb),
  onConfig: (cb: (config: StoredConfig) => void) => subscribe<StoredConfig>(IPC_EVENTS.config, cb),
  onHandshake: (cb: (result: HandshakeResult) => void) => subscribe<HandshakeResult>(IPC_EVENTS.handshake, cb),
  onNavigate: (cb: (view: RendererView) => void) => subscribe<RendererView>(IPC_EVENTS.navigate, cb),
  onTheme: (cb: (theme: ThemeState) => void) => subscribe<ThemeState>(IPC_EVENTS.theme, cb),
};

try {
  contextBridge.exposeInMainWorld('api', api);
} catch (error) {
  // Reaching here means contextIsolation was turned off, which would also mean
  // the renderer is running with far more authority than this app ever wants.
  // Fail loudly rather than quietly assigning onto `window`.
  console.error('[api] contextBridge.exposeInMainWorld failed. Is contextIsolation enabled?', error);
}
