import { SocketModeClient } from '@slack/socket-mode';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import {
  REACTIONS,
  err,
  normaliseAlias,
  ok,
  splitFirstLine,
  threadKey,
  type ActiveThread,
  type AllowlistResolution,
  type DaemonStatus,
  type ProjectHealth,
  type ProjectId,
  type ResolvedProject,
  type Result,
  type Route,
  type RuntimeConfig,
  type SelfTestResult,
  type ServiceEvent,
  type ServiceState,
  type SlackIdentity,
  type Storage,
  type ThreadCommand,
  type ThreadRecord,
  type TuningSettings,
  type TurnEvent,
} from '../shared/contract.ts';
import { asInternalConfig, pausedProjects, type RuntimeConfigInternal } from './config.ts';
import { logger } from './log.ts';
import {
  bindAckMessage,
  cancelMessage,
  filesIgnoredMessage,
  helpMessage,
  missingDirMessage,
  orphanedMessage,
  pausedMessage,
  projectsMessage,
  statusMessage,
  unknownAliasMessage,
} from './messages.ts';
import { route } from './routing.ts';
import { runSelfTest } from './selftest.ts';
import { Session } from './session.ts';
import { Slack, type SlackEventLike } from './slack.ts';

const log = logger('service');

/** Slack message subtypes that are edits/joins/etc rather than something the operator typed. */
const IGNORED_SUBTYPES = new Set([
  'message_changed',
  'message_deleted',
  'message_replied',
  'channel_join',
  'channel_leave',
  'bot_message',
  'thread_broadcast',
]);

const PRUNE_INTERVAL_MS = 3_600_000;

export interface ServiceDeps {
  storage: Storage;
  /** Main fans this out to IPC, the tray and notifications. */
  onEvent: (event: ServiceEvent) => void;
  /** Optional, read live. Main passes safeStorage.isEncryptionAvailable(). */
  encryptionAvailable?: () => boolean;
  /** Optional, read live. True once config.setupCompletedAt is set. */
  setupComplete?: () => boolean;
}

interface MessageContext {
  channel: string;
  ts: string;
  threadTs: string;
  isReply: boolean;
  user: string;
  text: string;
  record: ThreadRecord | undefined;
}

/**
 * The daemon, turned into something that can be started, stopped and
 * reconfigured while the app keeps running.
 *
 * The old `stop()` was written for process exit and leaked state that only
 * matters once a restart is possible. Every one of `catchupRunning`, `allowed`,
 * `handled`, `socket` and `reaper` is reset here, because a stale
 * `catchupRunning` silently disables reconnect catch-up forever, and a stale
 * `allowed` keeps a removed operator authorised.
 */
export class SlackCodeService {
  private readonly storage: Storage;
  private readonly deps: ServiceDeps;

  private config: RuntimeConfigInternal | null = null;
  /**
   * ONE stable tuning object for the life of the service. Sessions hold this by
   * reference, so a slider change in the app hot-applies to running turns.
   * applyConfig copies new values INTO it rather than swapping it out.
   */
  private readonly tuning: TuningSettings = {
    sessionIdleMinutes: 120,
    turnStallMinutes: 10,
    catchupWindowHours: 24,
    statusUpdateMs: 2000,
    streamProgressHeartbeat: true,
  };

  private slack: Slack | null = null;
  private socket: SocketModeClient | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly allowed = new Set<string>();
  private allowlist: AllowlistResolution = { resolved: [], unresolved: [] };
  /** The entries the current `allowed` set was resolved from, so a no-op save does not re-page users.list. */
  private appliedEntries: string[] = [];
  private identity: SlackIdentity | undefined;

  /** Slack ts values already handled, so live events and catch-up cannot double-fire. */
  private readonly handled = new Set<string>();
  private catchupRunning = false;
  private reaper: NodeJS.Timeout | null = null;
  private pruner: NodeJS.Timeout | null = null;
  private stopping = false;

  /** channel -> the binding a bind-only message just made, for the desktop Enter trap. */
  private readonly pendingBinds = new Map<string, { projectId: ProjectId; expiresAt: number }>();

  private currentState: ServiceState = 'stopped';
  private stateSince = Date.now();
  private detail: string | undefined;
  private lastEventAt: number | undefined;
  private lastCatchupAt: number | undefined;
  private lastCatchupReplayed: number | undefined;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.storage = deps.storage;
  }

  get state(): ServiceState {
    return this.currentState;
  }

  // --- configuration -------------------------------------------------------

  /**
   * Hot-apply configuration. Only a token change forces a socket restart; a
   * settings change must never tear down a session that is mid-turn.
   */
  async applyConfig(next: RuntimeConfig): Promise<void> {
    const previous = this.config;
    const config = asInternalConfig(next);

    // Keep the tuning object identity stable for every session already holding it.
    Object.assign(this.tuning, config.tuning);
    config.tuning = this.tuning;
    this.config = config;

    const running = this.currentState !== 'stopped' && this.currentState !== 'error';
    if (!running) return;

    if (!previous || previous.botToken !== config.botToken || previous.appToken !== config.appToken) {
      log.info('slack credentials changed, restarting the connection');
      await this.restart();
      return;
    }

    const before = this.appliedEntries.slice().sort().join(',');
    const after = config.allowlistEntries.slice().sort().join(',');
    if (before !== after) {
      await this.resolveAllowlist();
    }

    this.syncSessionsToProjects();
    this.clearStaleOrphanFlags();
    this.emitStatus();
  }

  /** Close sessions whose project is gone, hot-apply changes to the rest. */
  private syncSessionsToProjects(): void {
    const config = this.config;
    if (!config) return;

    for (const [key, session] of [...this.sessions]) {
      const project = config.byId.get(session.projectId);
      if (!project) {
        session.close({ force: false });
        this.sessions.delete(key);
        log.info(`closed session ${key}: its project is gone or paused`);
        this.deps.onEvent({ type: 'session:evicted', at: Date.now(), key });
        continue;
      }
      session.applyProject(project);
    }
  }

  /**
   * A project that came back should be able to talk again, so the "told you
   * once" flag is cleared for its threads whenever configuration changes.
   */
  private clearStaleOrphanFlags(): void {
    const config = this.config;
    if (!config) return;
    for (const project of config.projects) {
      for (const { key, record } of this.storage.threadsForProject(project.id)) {
        if (!record.orphanNotifiedAt) continue;
        const split = key.indexOf(':');
        this.storage.patchThread(key.slice(0, split), key.slice(split + 1), { orphanNotifiedAt: undefined });
      }
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async start(): Promise<Result<null>> {
    const config = this.config;
    if (!config) return this.fail('No configuration loaded yet.');
    if (this.currentState === 'starting' || this.currentState === 'connected') return ok(null);

    this.stopping = false;
    this.setState('starting');
    assertAgentEnvironment();

    try {
      this.slack = new Slack(config.botToken);
      this.identity = await this.slack.whoAmI();
      log.info(`connected as ${this.identity.botName} (${this.identity.botUserId}) in ${this.identity.teamName}`);

      await this.resolveAllowlist();
      if (this.allowed.size === 0) {
        // The allowlist is the only thing standing between a workspace member
        // and a shell on this machine. Refuse to SERVE, but stay alive and
        // explain why, rather than exiting the process out from under the UI.
        return this.fail(
          'No allowlist entry resolved to a real Slack user, so nobody could talk to it. Add an operator in Settings.',
        );
      }

      for (const project of config.projects) {
        if (!existsSync(project.dir)) {
          log.warn(`project ${project.alias} points at ${project.dir}, which does not exist right now`);
        }
      }
      log.info(
        `projects: ${config.projects.map((project) => `${project.alias} -> ${project.dir} (${project.permissionMode})`).join(', ') || 'none'}`,
      );

      const socket = new SocketModeClient({ appToken: config.appToken });
      this.socket = socket;

      // Every handler checks that this is still the CURRENT socket. A socket
      // torn down by stop() can still emit, and without the check a late
      // 'disconnected' would drag the state back out of 'stopped'.
      const current = () => this.socket === socket && !this.stopping;

      socket.on('message', async ({ ack, event }: { ack: () => Promise<void>; event: SlackEventLike }) => {
        await ack();
        if (!current()) return;
        try {
          await this.onSlackMessage(event);
        } catch (error) {
          log.error('failed handling message', error);
          this.deps.onEvent({ type: 'error', at: Date.now(), scope: 'message', message: String(error) });
        }
      });

      socket.on('disconnected', () => {
        if (!current()) return;
        log.warn('socket disconnected');
        this.setState('disconnected');
      });
      socket.on('reconnecting', () => {
        if (!current()) return;
        log.info('socket reconnecting');
        this.setState('reconnecting');
      });
      // Socket Mode does not replay events missed while the connection was down,
      // so every (re)connect sweeps for DMs that arrived in the gap.
      socket.on('authenticated', () => {
        if (!current()) return;
        this.setState('connected');
        void this.catchUp();
      });

      await socket.start();
      this.setState('connected');
      log.info('socket mode connected, listening for DMs');
      await this.catchUp();

      this.reaper = setInterval(() => this.reapIdle(), 60_000);
      this.reaper.unref();
      this.pruner = setInterval(() => this.storage.prune(), PRUNE_INTERVAL_MS);
      this.pruner.unref();
      this.storage.prune();

      return ok(null);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  async stop(opts: { force?: boolean } = {}): Promise<void> {
    this.stopping = true;

    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    if (this.pruner) clearInterval(this.pruner);
    this.pruner = null;

    for (const session of this.sessions.values()) session.close(opts);
    this.sessions.clear();

    const socket = this.socket;
    this.socket = null;
    if (socket) await socket.disconnect().catch(() => undefined);

    // Everything below leaks across a restart if it is not reset here. A stale
    // catchupRunning silently disables the catch-up sweep for the rest of the
    // process lifetime, and a stale allowed set keeps removed operators in.
    this.catchupRunning = false;
    this.allowed.clear();
    this.appliedEntries = [];
    this.handled.clear();
    this.pendingBinds.clear();
    this.allowlist = { resolved: [], unresolved: [] };
    this.slack = null;

    this.setState('stopped');
    this.stopping = false;
  }

  async restart(): Promise<Result<null>> {
    await this.stop();
    return this.start();
  }

  private fail(message: string): Result<null> {
    log.error(message);
    this.setState('error', message);
    return err(message);
  }

  private setState(state: ServiceState, detail?: string): void {
    this.currentState = state;
    this.stateSince = Date.now();
    this.detail = detail;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.deps.onEvent({ type: 'status', at: Date.now(), status: this.snapshot() });
  }

  private async resolveAllowlist(): Promise<void> {
    const config = this.config;
    if (!config || !this.slack) return;

    const resolution = await this.slack.resolveUsers(config.allowlistEntries);
    // REPLACE, never merge. The old code only ever added, so tightening the
    // allowlist and restarting left removed users authorised.
    this.allowed.clear();
    for (const user of resolution.resolved) this.allowed.add(user.id);
    this.allowlist = resolution;
    this.appliedEntries = config.allowlistEntries.slice();

    if (resolution.unresolved.length > 0) {
      log.warn(`allowlist entries that matched nobody: ${resolution.unresolved.join(', ')}`);
    }
    log.info(`accepting DMs from: ${resolution.resolved.map((user) => `${user.name} (${user.id})`).join(', ') || 'nobody'}`);
  }

  // --- catch-up ------------------------------------------------------------

  /** Alias of `catchUp()`, kept because it reads better at a call site. */
  async catchUpNow(): Promise<void> {
    await this.catchUp();
  }

  /**
   * Replay DMs that arrived while the socket was down. Slack drops, rather than
   * buffers, events for a disconnected Socket Mode client, so without this a
   * message sent during a reconnect is lost with no error on either side.
   *
   * Public, so main can force a sweep on powerMonitor 'resume': a lid closed
   * for eight hours is exactly the case the cursor exists for.
   */
  async catchUp(): Promise<void> {
    const config = this.config;
    if (!config || !this.slack || this.catchupRunning) return;
    this.catchupRunning = true;

    const windowMs = this.tuning.catchupWindowHours * 3_600_000;
    const now = (Date.now() / 1000).toFixed(6);
    const floor = ((Date.now() - windowMs) / 1000).toFixed(6);
    let replayed = 0;

    try {
      for (const userId of this.allowed) {
        const channel = await this.slack.openDm(userId);
        if (!channel) continue;

        const cursor = this.storage.getCursor(channel);
        if (!cursor) {
          // First sight of this channel. Start the cursor at now rather than
          // replaying whatever history happens to be in the window: those turns
          // already ran, and re-running them under bypassPermissions would be
          // actively harmful.
          this.storage.advanceCursor(channel, now);
          log.info(`catch-up baseline set for ${channel}, no history replayed`);
          continue;
        }

        // Never look further back than the window, however stale the cursor is.
        const oldest = Number(cursor) > Number(floor) ? cursor : floor;

        // New top-level DMs, which each start their own thread.
        for (const message of await this.slack.historySince(channel, oldest)) {
          if (await this.replay(channel, message)) replayed += 1;
        }

        // Replies inside threads we already know about.
        for (const { key } of this.storage.threadsFor(channel, Date.now() - windowMs)) {
          const threadTs = key.slice(key.indexOf(':') + 1);
          for (const message of await this.slack.repliesSince(channel, threadTs, oldest)) {
            if (await this.replay(channel, message)) replayed += 1;
          }
        }
      }
      if (replayed > 0) log.info(`catch-up replayed ${replayed} missed message(s)`);
    } catch (error) {
      log.warn('catch-up sweep failed', error);
    } finally {
      this.catchupRunning = false;
      this.lastCatchupAt = Date.now();
      this.lastCatchupReplayed = replayed;
      this.deps.onEvent({ type: 'catchup', at: Date.now(), replayed });
      this.emitStatus();
    }
  }

  private async replay(channel: string, message: SlackEventLike): Promise<boolean> {
    if (!message.ts || message.bot_id || !message.user) return false;
    if (message.subtype && IGNORED_SUBTYPES.has(message.subtype)) return false;
    if (!this.allowed.has(message.user)) return false;
    if (this.handled.has(message.ts)) return false;

    // Funnelled through the same handler as a live event, so replay inherits
    // routing for free. Do not "optimise" this into a separate path.
    await this.onSlackMessage({
      type: 'message',
      channel,
      channel_type: 'im',
      user: message.user,
      text: message.text,
      ts: message.ts,
      ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
    });
    return true;
  }

  // --- inbound -------------------------------------------------------------

  private async onSlackMessage(event: SlackEventLike): Promise<void> {
    const config = this.config;
    const slack = this.slack;
    if (!config || !slack) return;

    if (event.subtype && IGNORED_SUBTYPES.has(event.subtype)) return;
    if (event.bot_id) return;
    if (!event.user || event.user === slack.selfId) return;
    if (event.channel_type !== 'im') return;

    const channel = event.channel;
    const ts = event.ts;
    if (!channel || !ts) return;

    if (!this.allowed.has(event.user)) {
      log.warn(`ignoring DM from unauthorised user ${event.user}`);
      return;
    }

    // A message can reach here twice: live over the socket, and again from a
    // catch-up sweep that overlapped the reconnect.
    if (this.handled.has(ts)) return;
    this.handled.add(ts);
    if (this.handled.size > 5_000) {
      for (const old of [...this.handled].slice(0, 1_000)) this.handled.delete(old);
    }
    this.lastEventAt = Date.now();

    // The cursor advance stays ABOVE the routing block on purpose. A rejected
    // alias is still a HANDLED message: if the cursor did not move, the next
    // reconnect sweep would replay it and re-post the same error forever.
    this.storage.advanceCursor(channel, ts);

    // Mention stripping happens first, or a leading <@U…> would corrupt the alias.
    const text = (event.text ?? '').replace(/<@[UW][A-Z0-9]+>/g, '').trim();
    if (!text) {
      if (event.files?.length) await slack.postRaw(channel, event.thread_ts ?? ts, filesIgnoredMessage());
      return;
    }

    const threadTs = event.thread_ts ?? ts;
    // Slack reports thread_ts === ts on a parent that has replies, so the only
    // safe reading of "is a reply" is that the two differ.
    const isReply = Boolean(event.thread_ts && event.thread_ts !== ts);
    const record = this.storage.getThread(channel, threadTs);
    const pending = this.pendingBinds.get(channel);

    const decision = route(
      {
        text,
        record,
        isReply,
        ...(pending ? { pendingBind: pending } : {}),
        now: Date.now(),
      },
      config,
    );

    await this.act(decision, { channel, ts, threadTs, isReply, user: event.user, text, record });
  }

  private async act(decision: Route, context: MessageContext): Promise<void> {
    const config = this.config;
    const slack = this.slack;
    if (!config || !slack) return;
    const { channel, ts, threadTs } = context;

    switch (decision.kind) {
      case 'ignore':
        log.debug(`[${threadTs}] ignored: ${decision.why}`);
        return;

      case 'command':
        await this.runCommand(decision.name, context);
        return;

      case 'bound':
        await this.deliver(decision.project, decision.prompt, context);
        return;

      case 'bind': {
        this.bindThread(decision.project, context);
        log.info(`[${threadTs}] bound to ${decision.project.alias}`);
        await this.deliver(decision.project, decision.prompt, context);
        return;
      }

      case 'bindOnly': {
        this.bindThread(decision.project, context);
        // Remember the binding for the desktop Enter trap: the prompt often
        // arrives as a separate TOP-LEVEL message a second later.
        if (this.tuningPendingBindMs() > 0) {
          this.pendingBinds.set(channel, {
            projectId: decision.project.id,
            expiresAt: Date.now() + this.tuningPendingBindMs(),
          });
        }
        await slack.react(channel, ts, REACTIONS.bound);
        await slack.postRaw(channel, threadTs, bindAckMessage(decision.project));
        log.info(`[${threadTs}] bound to ${decision.project.alias}, waiting for the request`);
        return;
      }

      case 'fallback': {
        this.bindThread(decision.project, context);
        if (decision.why === 'pending') this.pendingBinds.delete(channel);
        log.info(`[${threadTs}] no alias, routed to ${decision.project.alias} (${decision.why})`);
        await this.deliver(decision.project, decision.prompt, context);
        return;
      }

      case 'paused': {
        await slack.postRaw(channel, threadTs, pausedMessage(decision.alias, config.projects));
        await slack.react(channel, ts, REACTIONS.unknownAlias);
        log.info(`[${threadTs}] alias ${decision.alias} is paused`);
        return;
      }

      case 'orphaned': {
        await slack.postRaw(channel, threadTs, orphanedMessage(decision.alias, config.projects));
        this.storage.patchThread(channel, threadTs, { orphanNotifiedAt: new Date().toISOString() });
        log.info(`[${threadTs}] bound project is gone, told the thread once`);
        return;
      }

      case 'unknownAlias':
        await this.rejectAlias(decision, context);
        return;
    }
  }

  private tuningPendingBindMs(): number {
    return (this.config?.routing.pendingBindMinutes ?? 0) * 60_000;
  }

  /**
   * Before posting an error on an unbound REPLY, read the thread parent once
   * and try to bind from its first line. One API call, only on this path, and
   * it makes routing survive a lost database.
   */
  private async rejectAlias(decision: Extract<Route, { kind: 'unknownAlias' }>, context: MessageContext): Promise<void> {
    const config = this.config;
    const slack = this.slack;
    if (!config || !slack) return;
    const { channel, ts, threadTs } = context;

    if (decision.isReply && config.routing.recoverBindingFromParent) {
      try {
        const parent = await slack.threadParent(channel, threadTs);
        const head = splitFirstLine((parent?.text ?? '').replace(/<@[UW][A-Z0-9]+>/g, '').trim()).head;
        const project = config.byAlias.get(normaliseAlias(head));
        if (project) {
          this.bindThread(project, context);
          log.info(`[${threadTs}] recovered binding to ${project.alias} from the thread parent`);
          await this.deliver(project, context.text, context);
          return;
        }
      } catch (error) {
        log.debug(`[${threadTs}] could not read the thread parent`, error);
      }
    }

    const now = new Date().toISOString();
    const existing = this.storage.getThread(channel, threadTs);
    if (existing) {
      this.storage.patchThread(channel, threadTs, { alias: normaliseAlias(decision.seen), rejectedNotifiedAt: now });
    } else {
      // The record matters even unbound: the catch-up sweep iterates stored
      // threads, so without it a corrective reply sent during a disconnect
      // would be dropped.
      this.storage.putThread(channel, threadTs, {
        sessionId: '',
        cwd: '',
        slackUserId: context.user,
        createdAt: now,
        lastActiveAt: now,
        turns: 0,
        costUsd: 0,
        projectId: null,
        alias: normaliseAlias(decision.seen),
        rejectedNotifiedAt: now,
      });
    }

    await slack.postRaw(
      channel,
      threadTs,
      unknownAliasMessage(decision.seen, config.projects, decision.isReply, decision.suggestion),
    );
    await slack.react(channel, ts, REACTIONS.unknownAlias);
    log.info(`[${threadTs}] unknown alias "${decision.seen}"`);
    this.deps.onEvent({
      type: 'routing:rejected',
      at: Date.now(),
      channel,
      threadTs,
      alias: decision.seen,
    });
  }

  /**
   * Create or update the thread record, SYNCHRONOUSLY, before anything is
   * enqueued. Messages 2 and 3 of a burst arrive milliseconds later and must
   * find the binding already there, or they would be alias-parsed instead.
   */
  private bindThread(project: ResolvedProject, context: MessageContext): void {
    const { channel, threadTs } = context;
    const now = new Date().toISOString();
    const existing = this.storage.getThread(channel, threadTs);

    if (existing) {
      this.storage.patchThread(channel, threadTs, {
        projectId: project.id,
        alias: project.alias,
        cwd: project.dir,
        lastActiveAt: now,
        rejectedNotifiedAt: undefined,
        orphanNotifiedAt: undefined,
      });
      return;
    }

    this.storage.putThread(channel, threadTs, {
      sessionId: '',
      cwd: project.dir,
      slackUserId: context.user,
      createdAt: now,
      lastActiveAt: now,
      turns: 0,
      costUsd: 0,
      projectId: project.id,
      alias: project.alias,
    });
  }

  /** Hand the prompt to the session for this thread, queued at a turn boundary. */
  private async deliver(project: ResolvedProject, prompt: string, context: MessageContext): Promise<void> {
    const slack = this.slack;
    if (!slack) return;
    const { channel, ts, threadTs } = context;

    if (!existsSync(project.dir)) {
      log.warn(`[${threadTs}] ${project.alias} directory is missing: ${project.dir}`);
      await slack.postRaw(channel, threadTs, missingDirMessage(project));
      await slack.react(channel, ts, REACTIONS.failed);
      return;
    }

    const session = this.sessionFor(slack, project, context);
    const queuedBehindWork = session.isBusy;

    session.enqueue(prompt, ts);
    this.deps.onEvent({
      type: 'turn:queued',
      at: Date.now(),
      threadTs,
      channel,
      projectId: project.id,
      chars: prompt.length,
      behindWork: queuedBehindWork,
    });

    if (queuedBehindWork) {
      // Confirm receipt immediately so the operator knows it landed rather than vanished.
      await slack.react(channel, ts, REACTIONS.queued);
    }
    log.info(
      `[${threadTs}] queued ${prompt.length} chars from ${context.user} for ${project.alias}${queuedBehindWork ? ' (behind running turn)' : ''}`,
    );
    this.emitStatus();
  }

  private sessionFor(slack: Slack, project: ResolvedProject, context: MessageContext): Session {
    const { channel, threadTs } = context;
    const key = threadKey(channel, threadTs);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const record = this.storage.getThread(channel, threadTs);
    if (record?.sessionId) log.info(`[${threadTs}] resuming session ${record.sessionId}`);
    else log.info(`[${threadTs}] new thread on ${project.alias}, fresh session`);

    const session = new Session({
      project,
      tuning: this.tuning,
      slack,
      storage: this.storage,
      channel,
      threadTs,
      slackUserId: context.user,
      ...(record?.sessionId ? { resumeSessionId: record.sessionId } : {}),
      ...(this.config?.claudeExecutablePath ? { claudeExecutablePath: this.config.claudeExecutablePath } : {}),
      onEvent: (event: TurnEvent) => {
        this.deps.onEvent(event);
        if (event.type !== 'turn:progress') this.emitStatus();
      },
      // The session is deliberately kept in the map after a turn so follow-ups
      // reuse it warm. The idle reaper evicts it later.
      onStreamEnd: () => log.info(`[${threadTs}] agent stream closed`),
    });
    this.sessions.set(key, session);
    return session;
  }

  // --- in-thread commands --------------------------------------------------

  private async runCommand(name: ThreadCommand, context: MessageContext): Promise<void> {
    const config = this.config;
    const slack = this.slack;
    if (!config || !slack) return;
    const { channel, threadTs } = context;
    const session = this.sessions.get(threadKey(channel, threadTs));
    const record = this.storage.getThread(channel, threadTs);

    switch (name) {
      case 'help':
        await slack.postRaw(channel, threadTs, helpMessage(config.projects));
        return;

      case 'projects':
        await slack.postRaw(channel, threadTs, projectsMessage(config.projects));
        return;

      case 'status': {
        const project = record?.projectId ? config.byId.get(record.projectId) : undefined;
        await slack.postRaw(
          channel,
          threadTs,
          statusMessage({
            projectName: project?.name ?? record?.alias ?? null,
            busy: session?.isBusy ?? false,
            queued: session?.queuedCount ?? 0,
            ...(session?.currentActivity ? { activity: session.currentActivity } : {}),
            turns: record?.turns ?? 0,
            ...(session?.startedAt ? { elapsedMs: Date.now() - session.startedAt } : {}),
          }),
        );
        return;
      }

      case 'cancel': {
        // Drops QUEUED messages only. The running turn is never interrupted:
        // interrupt() belongs to the stall watchdog and nothing else.
        const dropped = session?.cancelQueued() ?? 0;
        await slack.postRaw(channel, threadTs, cancelMessage(dropped));
        this.emitStatus();
        return;
      }
    }
  }

  // --- maintenance ---------------------------------------------------------

  private reapIdle(): void {
    const cutoff = Date.now() - this.tuning.sessionIdleMinutes * 60_000;
    for (const [key, session] of this.sessions) {
      if (session.isBusy || session.lastActiveAt > cutoff) continue;
      session.close();
      this.sessions.delete(key);
      log.info(`evicted idle session ${key} (session id kept on disk, a reply will resume it)`);
      this.deps.onEvent({ type: 'session:evicted', at: Date.now(), key });
    }

    for (const [channel, pending] of this.pendingBinds) {
      if (pending.expiresAt <= Date.now()) this.pendingBinds.delete(channel);
    }
  }

  // --- dashboard actions ---------------------------------------------------

  resetThread(key: string): Result<null> {
    const split = key.indexOf(':');
    if (split <= 0) return err(`Not a thread key: ${key}`);
    const channel = key.slice(0, split);
    const threadTs = key.slice(split + 1);

    const session = this.sessions.get(key);
    if (session) {
      session.close({ force: true });
      this.sessions.delete(key);
    }
    // Drop the resume id, so the next message starts a fresh Claude session in
    // the same thread. The Slack history stays where it is.
    this.storage.patchThread(channel, threadTs, { sessionId: '' });
    log.info(`reset thread ${key}`);
    this.emitStatus();
    return ok(null);
  }

  /**
   * Forget one thread: close its live session if there is one, then drop the
   * thread row and its turns from the database.
   *
   * The one difference from resetThread above: it REFUSES while a turn is
   * running.
   *
   * NOT because the row would come back. persist() goes through patchThread,
   * which returns early when the row is gone, so a finishing turn cannot
   * resurrect a thread. The reason is simpler: that turn is still going to post
   * its answer into a thread the app has just forgotten, and telling the
   * operator "removed" about a session they can watch still working is a lie.
   *
   * The write a late turn CAN still make is recordTurn, which is an
   * unconditional INSERT. This check cannot cover it on its own, because it only
   * sees sessions still in the map and a graceful stop or a paused project drops
   * a draining one out of it, so that case is guarded in Storage.recordTurn.
   *
   * Cancelling the turn instead is not on the table: query.interrupt() belongs
   * to the stall watchdog and nothing else.
   */
  removeSession(key: string): Result<{ turns: number }> {
    const split = key.indexOf(':');
    if (split <= 0) return err(`Not a thread key: ${key}`);
    const channel = key.slice(0, split);
    const threadTs = key.slice(split + 1);

    const session = this.sessions.get(key);
    if (session?.isBusy) {
      return err('That thread is running a turn right now. Wait for it to finish, then remove it.', 'busy');
    }

    if (session) {
      session.close({ force: true });
      this.sessions.delete(key);
    }
    // The channel cursor survives on purpose. See Storage.deleteSession.
    const { turns } = this.storage.deleteSession(channel, threadTs);
    log.info(`removed session ${key} and ${turns} turn row(s); the channel cursor is untouched`);
    this.emitStatus();
    return ok({ turns });
  }

  cancelQueued(key: string): Result<{ dropped: number }> {
    const session = this.sessions.get(key);
    if (!session) return ok({ dropped: 0 });
    const dropped = session.cancelQueued();
    this.emitStatus();
    return ok({ dropped });
  }

  async selftest(projectId: ProjectId): Promise<Result<SelfTestResult>> {
    const config = this.config;
    if (!config) return err('No configuration loaded yet.');

    const project = config.byId.get(projectId) ?? config.projects[0];
    if (!project) return err('No enabled project to test against.');

    const slack = this.slack ?? new Slack(config.botToken);
    if (!this.slack) await slack.whoAmI();

    const target = this.allowlist.resolved[0] ?? (await slack.resolveUsers(config.allowlistEntries)).resolved[0];
    if (!target) return err('No allowlisted user resolved, so there is nobody to DM.');

    return runSelfTest({
      slack,
      storage: this.storage,
      project,
      tuning: this.tuning,
      userId: target.id,
      ...(config.claudeExecutablePath ? { claudeExecutablePath: config.claudeExecutablePath } : {}),
    });
  }

  // --- status --------------------------------------------------------------

  /** The complete paintable state. A window opening mid-run paints from this alone. */
  snapshot(): DaemonStatus {
    const config = this.config;
    const status: DaemonStatus = {
      state: this.currentState,
      since: this.stateSince,
      allowlist: this.allowlist,
      projects: this.projectHealth(),
      activeThreads: this.activeThreads(),
      encryptionAvailable: this.deps.encryptionAvailable?.() ?? false,
      setupComplete: this.deps.setupComplete?.() ?? false,
    };
    if (this.detail) status.detail = this.detail;
    if (this.identity) status.identity = this.identity;
    if (this.lastEventAt) status.lastEventAt = this.lastEventAt;
    if (this.lastCatchupAt) status.lastCatchupAt = this.lastCatchupAt;
    if (this.lastCatchupReplayed !== undefined) status.lastCatchupReplayed = this.lastCatchupReplayed;
    if (config?.claudeExecutablePath) status.claudeExecutablePath = config.claudeExecutablePath;
    return status;
  }

  private projectHealth(): ProjectHealth[] {
    const config = this.config;
    if (!config) return [];

    const health: ProjectHealth[] = config.projects.map((project) => {
      const dirOk = existsSync(project.dir);
      const entry: ProjectHealth = {
        id: project.id,
        alias: project.alias,
        name: project.name,
        dir: project.dir,
        enabled: true,
        dirOk,
      };
      if (!dirOk) entry.problem = 'Directory is missing or unreadable right now.';
      return entry;
    });

    for (const project of pausedProjects(config)) {
      health.push({
        id: project.id,
        alias: project.alias,
        name: project.name,
        dir: project.dir,
        enabled: false,
        dirOk: existsSync(project.dir),
        problem: 'Paused.',
      });
    }
    return health;
  }

  private activeThreads(): ActiveThread[] {
    const config = this.config;
    const threads: ActiveThread[] = [];

    for (const [key, session] of this.sessions) {
      const split = key.indexOf(':');
      const channel = key.slice(0, split);
      const threadTs = key.slice(split + 1);
      const record = this.storage.getThread(channel, threadTs);
      const project = config?.byId.get(session.projectId);
      const user = this.allowlist.resolved.find((entry) => entry.id === record?.slackUserId);

      const thread: ActiveThread = {
        key,
        channel,
        threadTs,
        projectId: record?.projectId ?? session.projectId,
        alias: record?.alias ?? project?.alias ?? null,
        projectName: project?.name ?? null,
        slackUserId: record?.slackUserId ?? '',
        busy: session.isBusy,
        queued: session.queuedCount,
        turns: record?.turns ?? 0,
        sessionId: session.sessionId,
        lastActiveAt: session.lastActiveAt,
      };
      if (user) thread.slackUserName = user.name;
      if (session.currentActivity) thread.currentActivity = session.currentActivity;
      if (session.startedAt) thread.turnStartedAt = session.startedAt;
      threads.push(thread);
    }

    return threads.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
}

/**
 * Claude Code resolves credentials from the macOS login Keychain by USER
 * IDENTITY, not by binary path, so an agent process without HOME, USER and
 * LOGNAME fails EVERY turn with "Not logged in". Main repairs the environment
 * at startup; this is the last line of defence, and a loud warning here is a
 * far better outcome than every turn failing later.
 *
 * Note what this does NOT do: it never builds an env object for the child.
 * `Options.env` REPLACES the subprocess environment entirely, which is exactly
 * how these variables get dropped. Inheriting process.env cannot lose one.
 */
export function assertAgentEnvironment(): void {
  let fallback: { username: string; homedir: string } | null = null;
  try {
    const info = userInfo();
    fallback = { username: info.username, homedir: info.homedir };
  } catch {
    fallback = null;
  }

  if (!process.env.HOME) {
    process.env.HOME = fallback?.homedir ?? homedir();
    log.warn(`HOME was unset, backfilled to ${process.env.HOME}. That is an app bug, not a user setting.`);
  }
  if (!process.env.USER && fallback?.username) {
    process.env.USER = fallback.username;
    log.warn(`USER was unset, backfilled to ${process.env.USER}. That is an app bug, not a user setting.`);
  }
  if (!process.env.LOGNAME && (fallback?.username || process.env.USER)) {
    process.env.LOGNAME = fallback?.username ?? process.env.USER!;
    log.warn(`LOGNAME was unset, backfilled to ${process.env.LOGNAME}. That is an app bug, not a user setting.`);
  }
  if (!process.env.USER || !process.env.LOGNAME) {
    log.error('USER/LOGNAME are unset and could not be recovered. Every turn will fail with "Not logged in".');
  }
}
