/**
 * The spine of the main process: config, secrets, storage, the service, and the
 * fan-out of everything they produce.
 *
 * The Slack bridge runs HERE, in the main process, rather than in a
 * utilityProcess. safeStorage, app.getPath, powerMonitor, Notification and
 * dialog are all main-only, so a utility process would push both decrypted
 * tokens across an extra boundary and weaken the one property most worth
 * protecting: that the renderer can never read a token.
 */

import { app, powerMonitor } from 'electron';
import { existsSync, statSync } from 'node:fs';
import {
  checkAllowlist,
  checkAppToken,
  checkBotToken,
  checkClaudeAuth,
  checkClaudeBinary,
  checkLegacyDaemon,
  checkProjectDir,
  checkShellPath,
  checkUserIdentity,
} from '../core/checks.ts';
import { normaliseConfig, resolveProject, toRuntimeConfig, validateConfig } from '../core/config.ts';
import { logTail, logger, setDebug, setLogSink } from '../core/log.ts';
import { SlackCodeService } from '../core/service.ts';
import { Slack } from '../core/slack.ts';
import { importLegacyState, openStorage } from '../core/storage.ts';
import {
  DEFAULT_RETENTION,
  IPC_EVENTS,
  err,
  makeProjectId,
  ok,
  validateAlias,
  type AllowlistResolution,
  type DaemonStatus,
  type DeepPartial,
  type LogLine,
  type ProjectConfig,
  type ProjectDraft,
  type ProjectHealth,
  type ProjectId,
  type ResolvedProject,
  type Result,
  type SecretsStatus,
  type SelfTestResult,
  type ServiceEvent,
  type SetupCheckId,
  type SetupCheckResult,
  type Storage,
  type StoredConfig,
} from '../shared/contract.ts';
import { setLoginItem } from './autostart.ts';
import { claudeBinaryPath } from './binary.ts';
import { checkSafeStorage, checkSingleInstance, enrichShellPath } from './diagnostics.ts';
import { HandshakeRunner } from './handshake.ts';
import { appendLogFile, openLogFile } from './logfile.ts';
import { buildConfigFromEnv, findEnvCandidate, legacyStatePathFor, slugifyAlias } from './migrate.ts';
import { Notifier } from './notify.ts';
import { stateDir } from './paths.ts';
import { encryptionAvailable, loadSecrets, saveSecrets, secretsStatus, clearStoredSecrets, type SecretBundle } from './secrets.ts';
import { mergeConfig, readSettings, writeSettings } from './settings.ts';
import { applyAppearanceSettings } from './theme.ts';
import { send, setMenuBarOnly } from './window.ts';

const log = logger('main');

/** Status pushes are coalesced: turn progress can fire many times a second. */
const STATUS_PUSH_MS = 250;

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface BootOptions {
  /**
   * False when another copy already holds it, 'unknown' in the headless modes,
   * which deliberately do not take the lock. Reported as a check, never acted
   * on silently.
   */
  instanceLockHeld: boolean | 'unknown';
  headless: boolean;
}

export class MainApp {
  config: StoredConfig;
  configProblem: string | undefined;
  readonly storage: Storage;
  readonly service: SlackCodeService;
  readonly notifier: Notifier;
  readonly handshake: HandshakeRunner;
  readonly instanceLockHeld: boolean | 'unknown';

  private secrets: SecretBundle;
  private serviceConfigured = false;
  private lastConfigError: string | undefined;
  private readonly claudePath: string | undefined;
  private statusTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private statusListeners: ((status: DaemonStatus) => void)[] = [];
  private legacyImportDone = false;
  private readonly startedAt = Date.now();
  private disposed = false;

  private constructor(options: BootOptions) {
    this.instanceLockHeld = options.instanceLockHeld;

    const loaded = readSettings();
    this.config = loaded.config;
    this.configProblem = loaded.problem;

    setDebug(this.config.app.debugLogging);
    openLogFile();

    this.secrets = loadSecrets();
    this.claudePath = claudeBinaryPath();
    this.storage = openStorage(stateDir());

    this.notifier = new Notifier({
      settings: () => this.config.app,
      teamId: () => this.config.slack.workspace?.teamId,
    });

    this.handshake = new HandshakeRunner({
      blockedReason: () =>
        this.service.state === 'stopped' || this.service.state === 'error'
          ? null
          : 'The bridge is connected, and two Socket Mode connections on one app token split the events between them. Stop the bridge, then run the handshake.',
      onResult: (result) => {
        if (result.ok) {
          void this.saveConfig({ slack: { eventsVerifiedAt: new Date().toISOString() } });
        }
        send(IPC_EVENTS.handshake, result);
      },
      onVerified: (channel, ts) => {
        // Seed the cursor to this message so the first catch-up sweep has an
        // explicit baseline instead of replaying whatever history is in the window.
        this.storage.advanceCursor(channel, ts);
      },
    });

    this.service = new SlackCodeService({
      storage: this.storage,
      onEvent: (event) => this.onServiceEvent(event),
      // Read live, not captured. Both are facts only main holds: safeStorage is
      // Electron-only, and "setup complete" is a config field. Without these,
      // every snapshot core builds would claim setup was never finished.
      encryptionAvailable: () => encryptionAvailable(),
      setupComplete: () => Boolean(this.config.setupCompletedAt),
    });

    // One sink, set once: every line reaches the database, the log file and the
    // renderer, already redacted by core.
    setLogSink((line) => this.onLogLine(line));

    if (loaded.problem) log.error(loaded.problem);
    if (loaded.fresh) log.info('no config.json yet, starting from the defaults');
  }

  static async boot(options: BootOptions): Promise<MainApp> {
    const instance = new MainApp(options);
    await instance.applyConfig();

    if (!options.headless) {
      instance.pruneTimer = setInterval(() => instance.prune(), PRUNE_INTERVAL_MS);
      instance.pruneTimer.unref();
      instance.prune();

      // A lid closed for eight hours is exactly the case the catch-up cursor
      // exists for. Socket Mode's own reconnect usually covers it, but the
      // extra sweep costs one API call.
      powerMonitor.on('resume', () => {
        log.info('machine resumed, forcing a catch-up sweep');
        instance.forceCatchUp();
      });
    }

    return instance;
  }

  // --- state ---------------------------------------------------------------

  /**
   * Always answerable, even before the service has ever been configured, so a
   * window opening during setup can paint from one call.
   */
  status(): DaemonStatus {
    let base: DaemonStatus;
    if (this.serviceConfigured) {
      try {
        base = this.service.snapshot();
      } catch (error) {
        log.debug('service.snapshot() failed, falling back', error);
        base = this.fallbackStatus();
      }
    } else {
      base = this.fallbackStatus();
    }

    // Two fields only main can know. Core never touches safeStorage, and
    // "setup complete" is a config fact rather than a service one.
    return {
      ...base,
      encryptionAvailable: encryptionAvailable(),
      setupComplete: Boolean(this.config.setupCompletedAt),
      ...(this.claudePath ? { claudeExecutablePath: this.claudePath } : {}),
    };
  }

  private fallbackStatus(): DaemonStatus {
    const resolved = this.config.slack.allowed.filter((entry) => entry.id);
    const allowlist: AllowlistResolution = {
      resolved: resolved.map((entry) => ({ id: entry.id as string, name: entry.name ?? (entry.id as string) })),
      unresolved: this.config.slack.allowed.filter((entry) => !entry.id).map((entry) => entry.entry),
    };

    const detail = this.lastConfigError
      ? this.lastConfigError
      : !this.secrets.botToken || !this.secrets.appToken
        ? 'Waiting for the Slack tokens.'
        : undefined;

    return {
      state: 'stopped',
      ...(detail ? { detail } : {}),
      since: this.startedAt,
      ...(this.config.slack.workspace ? { identity: this.config.slack.workspace } : {}),
      allowlist,
      projects: this.projectHealth(),
      activeThreads: [],
      encryptionAvailable: encryptionAvailable(),
      setupComplete: Boolean(this.config.setupCompletedAt),
    };
  }

  private projectHealth(): ProjectHealth[] {
    return this.config.projects.map((project) => {
      let dirOk = false;
      let problem: string | undefined;
      try {
        dirOk = existsSync(project.dir) && statSync(project.dir).isDirectory();
        if (!dirOk) problem = 'The directory is missing or is not a directory.';
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      return {
        id: project.id,
        alias: project.alias,
        name: project.name,
        dir: project.dir,
        enabled: project.enabled,
        dirOk,
        ...(problem ? { problem } : {}),
      };
    });
  }

  // --- config --------------------------------------------------------------

  /**
   * Push the current config into everything that consumes it. Safe to call
   * repeatedly: the service decides internally what actually needs a socket
   * restart.
   */
  async applyConfig(): Promise<void> {
    // Runs exactly once, at the first moment there is a project to bind the old
    // threads to, whichever path created it.
    this.importLegacyThreads();

    setDebug(this.config.app.debugLogging);
    applyAppearanceSettings({
      mode: this.config.app.themeMode,
      vibrancy: this.config.app.vibrancy,
      reduceMotion: this.config.app.reduceMotion,
    });
    setMenuBarOnly(this.config.app.menuBarOnly);

    if (!this.secrets.botToken || !this.secrets.appToken) {
      this.serviceConfigured = false;
      return;
    }

    try {
      const runtime = toRuntimeConfig({
        config: this.config,
        botToken: this.secrets.botToken,
        appToken: this.secrets.appToken,
        stateDir: stateDir(),
        ...(this.claudePath ? { claudeExecutablePath: this.claudePath } : {}),
      });
      await this.service.applyConfig(runtime);
      this.serviceConfigured = true;
      this.lastConfigError = undefined;
    } catch (error) {
      this.serviceConfigured = false;
      this.lastConfigError = error instanceof Error ? error.message : String(error);
      log.error('could not apply the configuration', error);
    }
    this.pushStatus();
  }

  /**
   * VALIDATION REPORTS, IT DOES NOT GATE.
   *
   * `validateConfig` answers "is this configuration ready to run", which is a
   * different question from "may this be written down". It flags an empty
   * allowlist and an empty project list, both of which are the normal state
   * halfway through the wizard, so gating the write on it would make setup
   * unable to save a single answer. It would equally stop the operator deleting
   * their last project from the settings pane.
   *
   * So issues are logged and left to surface where they belong: the renderer
   * calls `validateConfig` directly to light up its own fields, and the service
   * refuses to START on an unusable config while the app keeps running and says
   * why. What is written is always structurally sound regardless, because
   * `normaliseConfig` fills defaults and clamps ranges first.
   */
  async saveConfig(patch: DeepPartial<StoredConfig>): Promise<Result<StoredConfig>> {
    const previous = this.config;
    const candidate = normaliseConfig(mergeConfig(previous, patch));

    const report = validateConfig(candidate);

    this.config = candidate;
    try {
      writeSettings(this.config);
    } catch (error) {
      this.config = previous;
      return err(`Could not write config.json: ${error instanceof Error ? error.message : String(error)}`, 'write_failed');
    }

    for (const clamped of report.clamped) log.warn(`${clamped.field}: ${clamped.message}`);
    for (const issue of report.issues) log.debug(`config not ready to run: ${issue.field}: ${issue.message}`);

    this.reconcileLoginItem(previous);
    await this.applyConfig();
    send(IPC_EVENTS.config, this.config);
    this.pushStatus();
    return ok(this.config);
  }

  /**
   * The login item is real OS state, so the stored flag has to follow what
   * macOS actually did. Registering can land in `requires-approval`, where the
   * app believes it is enabled and macOS will not honour it.
   */
  private reconcileLoginItem(previous: StoredConfig): void {
    if (previous.app.runAtLogin === this.config.app.runAtLogin) return;

    const state = setLoginItem(this.config.app.runAtLogin);
    if (!state.supported || state.enabled === this.config.app.runAtLogin) return;

    this.config = { ...this.config, app: { ...this.config.app, runAtLogin: state.enabled } };
    try {
      writeSettings(this.config);
    } catch (error) {
      log.warn('could not write back the corrected run-at-login flag', error);
    }
  }

  // --- secrets -------------------------------------------------------------

  secretsStatus(): SecretsStatus {
    return secretsStatus(this.secrets);
  }

  async setSecrets(patch: { botToken?: string; appToken?: string }): Promise<Result<SecretsStatus>> {
    const saved = saveSecrets(this.secrets, patch);
    if (!saved.ok) {
      // Encryption being unavailable is not a reason to refuse to run: hold the
      // tokens in memory for this session and tell the operator they will not
      // survive a restart.
      if (saved.code === 'no_encryption') {
        this.secrets = {
          ...this.secrets,
          ...(patch.botToken !== undefined ? { botToken: patch.botToken.trim() || undefined } : {}),
          ...(patch.appToken !== undefined ? { appToken: patch.appToken.trim() || undefined } : {}),
        };
        await this.applyConfig();
      }
      return err(saved.error, saved.code);
    }

    this.secrets = saved.value;
    await this.applyConfig();
    return ok(this.secretsStatus());
  }

  async clearSecrets(): Promise<Result<SecretsStatus>> {
    const cleared = clearStoredSecrets();
    if (!cleared.ok) return err(cleared.error);
    this.secrets = {};
    await this.stopService();
    await this.applyConfig();
    return ok(this.secretsStatus());
  }

  hasTokens(): boolean {
    return Boolean(this.secrets.botToken && this.secrets.appToken);
  }

  botToken(): string | undefined {
    return this.secrets.botToken;
  }

  appToken(): string | undefined {
    return this.secrets.appToken;
  }

  // --- projects ------------------------------------------------------------

  private aliasesTakenBy(exceptId?: ProjectId): string[] {
    return this.config.projects
      .filter((project) => project.id !== exceptId)
      .flatMap((project) => [project.alias, ...project.aliases]);
  }

  async addProject(draft: ProjectDraft): Promise<Result<ProjectConfig>> {
    const built = this.buildProject(draft, undefined);
    if (!built.ok) return err(built.error, built.code);

    const saved = await this.saveConfig({ projects: [...this.config.projects, built.value] });
    if (!saved.ok) return err(saved.error, saved.code);
    log.info(`project added: ${built.value.alias} -> ${built.value.dir}`);
    return ok(built.value);
  }

  async updateProject(draft: ProjectDraft & { id: ProjectId }): Promise<Result<ProjectConfig>> {
    const existing = this.config.projects.find((project) => project.id === draft.id);
    if (!existing) return err(`No project with id ${draft.id}.`, 'not_found');

    const built = this.buildProject(draft, existing);
    if (!built.ok) return err(built.error, built.code);

    const projects = this.config.projects.map((project) => (project.id === draft.id ? built.value : project));
    const saved = await this.saveConfig({ projects });
    if (!saved.ok) return err(saved.error, saved.code);
    return ok(built.value);
  }

  async removeProject(id: ProjectId): Promise<Result<null>> {
    if (!this.config.projects.some((project) => project.id === id)) return err(`No project with id ${id}.`, 'not_found');

    const projects = this.config.projects.filter((project) => project.id !== id);
    const patch: DeepPartial<StoredConfig> = { projects };
    // A removed project must not stay wired up as the routing default, or every
    // unmatched message would resolve to something that no longer exists.
    if (this.config.routing.defaultProjectId === id) {
      patch.routing = { defaultProjectId: undefined };
    }

    const saved = await this.saveConfig(patch);
    if (!saved.ok) return err(saved.error, saved.code);

    const affected = this.storage.threadsForProject(id).length;
    if (affected > 0) {
      log.info(`project ${id} removed; ${affected} thread(s) now point at a project that is gone and will be told once`);
    }
    return ok(null);
  }

  async reorderProjects(ids: ProjectId[]): Promise<Result<ProjectConfig[]>> {
    const byId = new Map(this.config.projects.map((project) => [project.id, project]));
    const ordered: ProjectConfig[] = [];
    for (const id of ids) {
      const project = byId.get(id);
      if (project) {
        ordered.push(project);
        byId.delete(id);
      }
    }
    // Anything the caller did not mention keeps its relative order at the end,
    // so a stale list from the UI cannot silently delete a project.
    for (const project of this.config.projects) if (byId.has(project.id)) ordered.push(project);

    const saved = await this.saveConfig({ projects: ordered });
    if (!saved.ok) return err(saved.error, saved.code);
    return ok(ordered);
  }

  private buildProject(draft: ProjectDraft, existing: ProjectConfig | undefined): Result<ProjectConfig> {
    const dir = (draft.dir ?? '').trim();
    if (!dir) return err('Choose a project directory.', 'bad_dir');
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return err(`${dir} is not a directory.`, 'bad_dir');
    } catch (error) {
      return err(`${dir} could not be read: ${error instanceof Error ? error.message : String(error)}`, 'bad_dir');
    }

    const taken = this.aliasesTakenBy(existing?.id);
    const primary = validateAlias(draft.alias ?? '', taken);
    if (!primary.ok) return err(primary.message ?? 'That alias cannot be used.', 'bad_alias');

    const extras: string[] = [];
    for (const raw of draft.aliases ?? []) {
      const check = validateAlias(raw, [...taken, primary.value, ...extras]);
      if (!check.ok) return err(check.message ?? `"${raw}" cannot be used as an alias.`, 'bad_alias');
      extras.push(check.value);
    }

    const project: ProjectConfig = {
      id: existing?.id ?? draft.id ?? makeProjectId(),
      alias: primary.value,
      aliases: extras,
      name: (draft.name ?? '').trim() || dir.split('/').filter(Boolean).pop() || primary.value,
      dir,
      enabled: draft.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      ...(draft.model?.trim() ? { model: draft.model.trim() } : {}),
      ...(draft.permissionMode ? { permissionMode: draft.permissionMode } : {}),
      ...(draft.effort ? { effort: draft.effort } : {}),
      ...(draft.additionalDirectories?.length ? { additionalDirectories: draft.additionalDirectories } : {}),
    };
    return ok(project);
  }

  resolved(projectId: ProjectId): ResolvedProject | undefined {
    const project = this.config.projects.find((entry) => entry.id === projectId);
    return project ? resolveProject(project, this.config.agent) : undefined;
  }

  // --- service -------------------------------------------------------------

  async startService(): Promise<Result<null>> {
    if (!this.hasTokens()) return err('Both Slack tokens are needed before the bridge can start.', 'no_tokens');
    if (this.handshake.active) return err('The setup handshake is using the Socket Mode connection. Finish or cancel it first.', 'socket_busy');

    // Starting is where "ready to run" actually matters, so this is where the
    // validation report becomes a refusal rather than a log line.
    const report = validateConfig(this.config);
    if (!report.ok) {
      return err(report.issues.map((issue) => `${issue.field}: ${issue.message}`).join('\n'), 'invalid_config');
    }

    if (!this.serviceConfigured) await this.applyConfig();
    if (!this.serviceConfigured) return err(this.lastConfigError ?? 'The configuration could not be applied.', 'bad_config');

    const started = await this.service.start();
    this.pushStatus();
    return started;
  }

  async stopService(options: { force?: boolean } = {}): Promise<Result<null>> {
    await this.service.stop(options);
    this.pushStatus();
    return ok(null);
  }

  async restartService(): Promise<Result<null>> {
    if (!this.hasTokens()) return err('Both Slack tokens are needed before the bridge can start.', 'no_tokens');
    const result = await this.service.restart();
    this.pushStatus();
    return result;
  }

  async selftest(projectId: ProjectId): Promise<Result<SelfTestResult>> {
    if (!this.hasTokens()) return err('Both Slack tokens are needed before the selftest can run.', 'no_tokens');
    if (!this.serviceConfigured) await this.applyConfig();
    if (!this.serviceConfigured) return err(this.lastConfigError ?? 'The configuration could not be applied.', 'bad_config');
    return this.service.selftest(projectId);
  }

  /** Drop the stored session id so the next message in that thread starts fresh. */
  resetThread(key: string): Result<null> {
    const result = this.service.resetThread(key);
    this.pushStatus();
    return result;
  }

  /**
   * Forget one thread: its row and its turns leave the app database. Refused
   * while that thread is running a turn, and the Claude Code transcript under
   * ~/.claude is never touched. See SlackCodeService.removeSession.
   */
  removeSession(key: string): Result<{ turns: number }> {
    const result = this.service.removeSession(key);
    this.pushStatus();
    return result;
  }

  /**
   * Drops queued messages only. It must never touch the running turn:
   * query.interrupt() belongs to the stall watchdog and nothing else.
   */
  cancelQueued(key: string): Result<{ dropped: number }> {
    const result = this.service.cancelQueued(key);
    this.pushStatus();
    return result;
  }

  forceCatchUp(): void {
    void this.service.catchUpNow().catch((error: unknown) => log.warn('forced catch-up failed', error));
  }

  // --- events --------------------------------------------------------------

  private onServiceEvent(event: ServiceEvent): void {
    // IPC_EVENTS.turn carries TurnEvent and nothing else, because that is what
    // the renderer's onTurn is typed as. The rest of the service events reach
    // the UI as a status refresh and as log lines, which is what the problems
    // feed reads anyway.
    if (event.type.startsWith('turn:')) send(IPC_EVENTS.turn, event);

    switch (event.type) {
      case 'status': {
        const connected = event.status.state === 'connected';
        this.notifier.connectionChanged(connected, event.status.detail);
        break;
      }
      case 'turn:ended': {
        if (event.info.failed) {
          const project = event.projectId ? this.config.projects.find((entry) => entry.id === event.projectId) : undefined;
          this.notifier.turnFailed({
            channel: event.channel,
            threadTs: event.threadTs,
            projectName: project?.name ?? 'slack-code',
            detail: event.info.subtype === 'success' ? 'The turn ended with an error.' : `Ended as ${event.info.subtype}.`,
          });
        }
        break;
      }
      case 'turn:stalled': {
        this.notifier.stalled({ channel: event.channel, threadTs: event.threadTs, silentMs: event.silentMs });
        break;
      }
      default:
        break;
    }

    this.pushStatus();
  }

  private onLogLine(line: LogLine): void {
    appendLogFile(line);
    try {
      this.storage.appendLog(line);
    } catch {
      // Never log from inside the log sink.
    }
    send(IPC_EVENTS.log, line);
  }

  /** The tray subscribes here so it can relabel itself without polling. */
  onStatus(listener: (status: DaemonStatus) => void): void {
    this.statusListeners.push(listener);
  }

  /** Coalesced, because turn progress fires far faster than anything needs to repaint. */
  pushStatus(): void {
    if (this.statusTimer || this.disposed) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      const status = this.status();
      send(IPC_EVENTS.status, status);
      for (const listener of this.statusListeners) {
        try {
          listener(status);
        } catch (error) {
          log.debug('a status listener threw', error);
        }
      }
    }, STATUS_PUSH_MS);
    this.statusTimer.unref();
  }

  // --- migrations ----------------------------------------------------------

  /**
   * Idempotent by design: core skips the whole thing if the threads table has
   * rows. It is deliberately NOT run at boot on a fresh install, because it
   * binds each imported thread by matching its stored cwd against a configured
   * project directory. Running it before any project exists would import all
   * seven threads unbound and then never get a second chance, so it waits until
   * the first moment there is something to bind them to.
   */
  private importLegacyThreads(): void {
    if (this.legacyImportDone || this.config.projects.length === 0) return;
    this.legacyImportDone = true;

    const candidate = findEnvCandidate();
    const path = candidate ? legacyStatePathFor(candidate.envPath) : undefined;
    if (!path) return;
    try {
      const report = importLegacyState(this.storage, path, this.config.projects);
      if (report.imported) {
        log.info(
          `imported ${report.threads} thread(s) and ${report.cursors} cursor(s) from ${report.sourcePath} (${report.bound} bound by directory, ${report.unbound} left unbound)`,
        );
      }
    } catch (error) {
      log.warn(`could not import ${path}`, error);
    }
  }

  envCandidate() {
    return findEnvCandidate();
  }

  async importEnv(): Promise<Result<StoredConfig>> {
    const candidate = findEnvCandidate();
    if (!candidate) return err('No .env file was found to import.', 'not_found');

    let built: ReturnType<typeof buildConfigFromEnv>;
    try {
      built = buildConfigFromEnv(this.config, candidate);
    } catch (error) {
      return err(`Could not read ${candidate.envPath}: ${error instanceof Error ? error.message : String(error)}`, 'read_failed');
    }

    if (built.botToken || built.appToken) {
      const stored = await this.setSecrets({
        ...(built.botToken ? { botToken: built.botToken } : {}),
        ...(built.appToken ? { appToken: built.appToken } : {}),
      });
      if (!stored.ok && stored.code !== 'no_encryption') return err(stored.error, stored.code);
    }

    // saveConfig applies the new config, and applying it is what triggers the
    // legacy thread import now that a project exists to bind them to.
    const saved = await this.saveConfig(built.config as DeepPartial<StoredConfig>);
    if (!saved.ok) return saved;

    for (const note of built.notes) log.info(note);
    return ok(this.config);
  }

  /** Used by the wizard when it needs a suggested alias for a picked directory. */
  suggestAlias(dir: string): string {
    return slugifyAlias(dir.split('/').filter(Boolean).pop() ?? 'project', this.aliasesTakenBy());
  }

  // --- checks --------------------------------------------------------------

  /**
   * Everything at once, run in parallel because the claudeAuth probe spawns the
   * 317 MB CLI and takes seconds. Nothing here is allowed to reject: a check
   * that throws becomes a failed check, so one broken probe cannot blank the
   * whole panel.
   */
  async runAllChecks(): Promise<SetupCheckResult[]> {
    const immediate: SetupCheckResult[] = [
      checkSafeStorage(),
      checkSingleInstance(this.instanceLockHeld),
      checkUserIdentity(),
      enrichShellPath(checkShellPath()),
      this.eventsCheck(),
    ];

    const guard = (id: SetupCheckId, promise: Promise<SetupCheckResult>): Promise<SetupCheckResult> =>
      promise.catch((error: unknown) => failedCheck(id, error));

    const slow: Promise<SetupCheckResult>[] = [
      guard('claudeBinary', checkClaudeBinary(this.claudePath)),
      guard('legacyDaemon', checkLegacyDaemon()),
    ];

    const botToken = this.secrets.botToken;
    const appToken = this.secrets.appToken;
    if (botToken) slow.push(guard('botToken', checkBotToken(botToken)));
    if (appToken) slow.push(guard('appToken', checkAppToken(appToken)));
    if (botToken && this.config.slack.allowed.length > 0) {
      slow.push(guard('allowlist', checkAllowlist(botToken, this.config.slack.allowed.map((entry) => entry.entry))));
    }

    const firstProject = this.config.projects.find((project) => project.enabled) ?? this.config.projects[0];
    if (firstProject) {
      immediate.push(this.projectDirCheck());
      slow.push(guard('claudeAuth', checkClaudeAuth(resolveProject(firstProject, this.config.agent), this.claudePath)));
    }

    return [...immediate, ...(await Promise.all(slow))];
  }

  async runCheck(id: SetupCheckId, arg?: { projectId?: ProjectId; dir?: string }): Promise<SetupCheckResult> {
    try {
      switch (id) {
        case 'safeStorage':
          return checkSafeStorage();
        case 'singleInstance':
          return checkSingleInstance(this.instanceLockHeld);
        case 'legacyDaemon':
          return await checkLegacyDaemon();
        case 'userIdentity':
          return checkUserIdentity();
        case 'shellPath':
          return enrichShellPath(checkShellPath());
        case 'claudeBinary':
          return await checkClaudeBinary(this.claudePath);
        case 'events':
          return this.eventsCheck();
        case 'botToken': {
          const token = this.secrets.botToken;
          if (!token) return missingCheck('botToken', 'bot token', 'No bot token is stored yet.');
          return await checkBotToken(token);
        }
        case 'appToken': {
          const token = this.secrets.appToken;
          if (!token) return missingCheck('appToken', 'app token', 'No app-level token is stored yet.');
          return await checkAppToken(token);
        }
        case 'allowlist': {
          const token = this.secrets.botToken;
          if (!token) return missingCheck('allowlist', 'operators', 'A bot token is needed before names can be resolved.');
          return await checkAllowlist(token, this.config.slack.allowed.map((entry) => entry.entry));
        }
        case 'projectDir': {
          if (arg?.dir) return checkProjectDir(arg.dir);
          if (arg?.projectId) {
            const project = this.config.projects.find((entry) => entry.id === arg.projectId);
            if (!project) return missingCheck('projectDir', 'project directory', `No project with id ${arg.projectId}.`);
            return checkProjectDir(project.dir);
          }
          return this.projectDirCheck();
        }
        case 'claudeAuth': {
          const project = arg?.projectId
            ? this.config.projects.find((entry) => entry.id === arg.projectId)
            : (this.config.projects.find((entry) => entry.enabled) ?? this.config.projects[0]);
          if (!project) return missingCheck('claudeAuth', 'claude auth', 'Add a project first: the probe runs inside one.');
          return await checkClaudeAuth(resolveProject(project, this.config.agent), this.claudePath);
        }
        default:
          return missingCheck(id, id, 'That check does not exist.');
      }
    } catch (error) {
      return failedCheck(id, error);
    }
  }

  /**
   * One result covering every configured project. Running the check per project
   * would produce several results sharing the id 'projectDir', which the UI
   * keys on.
   */
  private projectDirCheck(): SetupCheckResult {
    const health = this.projectHealth();
    if (health.length === 0) return missingCheck('projectDir', 'project directory', 'No projects are configured yet.');

    const broken = health.filter((project) => !project.dirOk);
    return {
      id: 'projectDir',
      ok: broken.length === 0,
      label: 'project directories',
      detail:
        broken.length === 0
          ? `${health.length} project${health.length === 1 ? '' : 's'}, every directory readable`
          : `missing: ${broken.map((project) => `${project.alias} (${project.dir})`).join(', ')}`,
      ...(broken.length === 0 ? {} : { hint: 'A project whose directory has gone is skipped rather than being fatal. Fix the path or remove the project.' }),
      severity: 'error',
      ranAt: Date.now(),
    };
  }

  private eventsCheck(): SetupCheckResult {
    const verifiedAt = this.config.slack.eventsVerifiedAt;
    return {
      id: 'events',
      ok: Boolean(verifiedAt),
      label: 'event delivery',
      detail: verifiedAt ? `a DM reached the app on ${new Date(verifiedAt).toLocaleString()}` : 'never verified with a real message',
      ...(verifiedAt
        ? {}
        : {
            hint: 'Run the handshake step. If the Slack app has no "message.im" bot event, everything else passes and DMs still never arrive.',
          }),
      severity: 'warning',
      ranAt: Date.now(),
    };
  }

  // --- slack helpers used by the wizard ------------------------------------

  slackClient(): Slack | null {
    return this.secrets.botToken ? new Slack(this.secrets.botToken) : null;
  }

  // --- lifecycle -----------------------------------------------------------

  private prune(): void {
    try {
      this.storage.prune(DEFAULT_RETENTION);
    } catch (error) {
      log.warn('pruning old rows failed', error);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.statusTimer = null;
    this.pruneTimer = null;

    setLogSink(null);
    this.notifier.dispose();
    await this.handshake.cancel().catch(() => undefined);
    // force, so an in-flight turn is aborted rather than leaving a 317 MB child
    // process running after the app is gone.
    await this.service.stop({ force: true }).catch((error: unknown) => log.warn('service did not stop cleanly', error));
    try {
      this.storage.close();
    } catch (error) {
      log.warn('closing the database failed', error);
    }
  }

  logTail(limit?: number): LogLine[] {
    return logTail(limit);
  }

  appVersion(): string {
    return app.getVersion();
  }
}

function failedCheck(id: SetupCheckId, error: unknown): SetupCheckResult {
  return {
    id,
    ok: false,
    label: id,
    detail: error instanceof Error ? error.message : String(error),
    severity: 'error',
    ranAt: Date.now(),
  };
}

function missingCheck(id: SetupCheckId, label: string, detail: string): SetupCheckResult {
  return { id, ok: false, label, detail, severity: 'warning', ranAt: Date.now() };
}
