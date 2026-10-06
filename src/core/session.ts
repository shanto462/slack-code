import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  REACTIONS,
  redactSecrets,
  type ResolvedProject,
  type Storage,
  type ThreadRecord,
  type TuningSettings,
  type TurnEndInfo,
  type TurnEvent,
} from '../shared/contract.ts';
import { logger } from './log.ts';
import { receiptFooter, sessionErrorMessage, stallMessage, turnFailedMessage } from './messages.ts';
import { slackSystemPrompt } from './prompt.ts';
import { formatDuration, toolLabel } from './render.ts';
import type { Slack } from './slack.ts';

const log = logger('session');

interface QueuedMessage {
  text: string;
  /** ts of the Slack message this came from, so reactions land on the right one. */
  ts: string;
}

export interface SessionDeps {
  /** Fully merged project. The session never sees StoredConfig or the defaults. */
  project: ResolvedProject;
  /**
   * Held by REFERENCE, never copied into fields. The status throttle and the
   * stall watchdog read it fresh on every tick, so a slider change in the app
   * hot-applies to a running session for free.
   */
  tuning: TuningSettings;
  slack: Slack;
  storage: Storage;
  channel: string;
  threadTs: string;
  slackUserId: string;
  /** Resume this Claude Code session instead of starting fresh. */
  resumeSessionId?: string;
  /** Absolute path to the unpacked CLI. Undefined in dev, where the SDK resolves it itself. */
  claudeExecutablePath?: string;
  /** Fires after every completed turn. The session stays warm afterwards. */
  onTurnEnd?: (info: TurnEndInfo) => void;
  /** Fires when the underlying agent stream ends for good. */
  onStreamEnd?: () => void;
  /** Turn lifecycle, for the dashboard and notifications. */
  onEvent?: (event: TurnEvent) => void;
}

/**
 * One Slack thread, one live Claude Code session.
 *
 * Inbound Slack messages are queued and only handed to the agent at a turn
 * boundary, so a message sent mid-turn cannot cut into work already running.
 * The one `query.interrupt()` in this class is the stall watchdog recovering a
 * wedged turn; no user message ever reaches that path.
 */
export class Session {
  private readonly deps: SessionDeps;
  private project: ResolvedProject;
  private pending: QueuedMessage[] = [];
  private wake: (() => void) | null = null;

  /** False while the agent is mid-turn. The input generator refuses to yield until it flips back. */
  private idle = true;
  private closed = false;
  private running = false;

  private handle: Query | null = null;
  /** Only used to abort an in-flight turn on a forced close, so quitting cannot orphan the CLI. */
  private aborter: AbortController | null = null;
  sessionId: string | null = null;

  /** Slack message ids for the batch currently being worked on. */
  private inFlightTs: string[] = [];

  private statusTs: string | null = null;
  private activity: string[] = [];
  private lastStatusAt = 0;
  private statusTimer: NodeJS.Timeout | null = null;
  private turnStartedAt = 0;
  private textBuffer: string[] = [];
  private promptPreview = '';
  /** total_cost_usd is cumulative across a streaming session, so a turn costs the delta. */
  private lastCostUsd = 0;

  /** Last time the agent showed any sign of life this turn. Drives the stall watchdog. */
  private lastProgressAt = 0;
  private stallTimer: NodeJS.Timeout | null = null;
  /** Set when a wedged turn is being abandoned, so the input generator unwinds. */
  private abandoned = false;

  lastActiveAt = Date.now();

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.project = deps.project;
    this.sessionId = deps.resumeSessionId ?? null;
  }

  get isBusy(): boolean {
    return !this.idle || this.pending.length > 0;
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  get currentActivity(): string | undefined {
    return this.activity[this.activity.length - 1];
  }

  get startedAt(): number | undefined {
    return this.idle ? undefined : this.turnStartedAt;
  }

  get projectId(): string {
    return this.project.id;
  }

  /**
   * Hot-apply a changed project. Model and permission mode can be pushed into a
   * live handle; everything else lands on the next turn, since `buildOptions()`
   * runs per stream.
   */
  applyProject(next: ResolvedProject): void {
    const previous = this.project;
    this.project = next;
    if (!this.handle) return;
    if (next.model !== previous.model) void this.handle.setModel(next.model).catch(() => undefined);
    if (next.permissionMode !== previous.permissionMode) {
      void this.handle.setPermissionMode(next.permissionMode).catch(() => undefined);
    }
  }

  /** Accept a Slack message. Always queues; never interrupts. */
  enqueue(text: string, ts: string): void {
    if (this.closed) return;
    this.pending.push({ text, ts });
    this.lastActiveAt = Date.now();
    this.signal();
    if (!this.running) void this.start();
  }

  /** Drop queued work WITHOUT touching the running turn. This is what `!cancel` does. */
  cancelQueued(): number {
    const dropped = this.pending.length;
    this.pending = [];
    return dropped;
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private async waitForWork(): Promise<void> {
    while (!this.closed && !this.abandoned && (this.pending.length === 0 || !this.idle)) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  /**
   * The streaming-input generator. It parks until the previous turn has
   * finished AND something is queued, then hands over everything queued as a
   * single user turn so a burst of Slack messages reads as one instruction.
   */
  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed && !this.abandoned) {
      await this.waitForWork();
      if (this.closed || this.abandoned) return;

      const batch = this.pending.splice(0, this.pending.length);
      if (batch.length === 0) continue;

      this.idle = false;
      this.inFlightTs = batch.map((entry) => entry.ts);
      this.turnStartedAt = Date.now();
      this.activity = [];
      this.textBuffer = [];
      const text = batch.map((entry) => entry.text).join('\n\n');
      this.promptPreview = redactSecrets(text.split('\n')[0] ?? '').slice(0, 200);
      this.startStallWatchdog();
      this.emit({
        type: 'turn:started',
        at: this.turnStartedAt,
        threadTs: this.deps.threadTs,
        channel: this.deps.channel,
        projectId: this.project.id,
      });

      await this.markWorking();

      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        // Belt and braces: even if this reached the CLI mid-turn, it queues.
        priority: 'later',
      };
    }
  }

  private buildOptions(): Options {
    const { tuning, claudeExecutablePath } = this.deps;
    const project = this.project;

    const options: Options = {
      cwd: project.dir,
      permissionMode: project.permissionMode,
      allowDangerouslySkipPermissions: project.permissionMode === 'bypassPermissions',
      // Load CLAUDE.md, project settings, and local settings the way the CLI would.
      settingSources: ['user', 'project', 'local'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: slackSystemPrompt(project),
      },
      // Partial messages refresh the stall watchdog's progress timestamp, so a
      // long extended-thinking block reads as work rather than as silence.
      includePartialMessages: tuning.streamProgressHeartbeat,
      stderr: (data: string) => log.debug(`cli stderr: ${data.trimEnd()}`),
    };

    // NEVER set Options.env. The SDK documents that it REPLACES the subprocess
    // environment entirely, and dropping HOME/USER/LOGNAME is exactly how
    // Claude Code loses its Keychain credentials and fails every turn with
    // "Not logged in". Inheriting process.env cannot silently drop a variable.

    if (project.model) options.model = project.model;
    if (project.effort) options.effort = project.effort;
    if (this.sessionId) options.resume = this.sessionId;
    if (claudeExecutablePath) options.pathToClaudeCodeExecutable = claudeExecutablePath;
    if (project.additionalDirectories?.length) options.additionalDirectories = project.additionalDirectories;

    this.aborter = new AbortController();
    options.abortController = this.aborter;

    return options;
  }

  private async start(): Promise<void> {
    if (this.running || this.closed) return;
    this.running = true;

    try {
      const handle = query({ prompt: this.input(), options: this.buildOptions() });
      this.handle = handle;
      for await (const message of handle) {
        await this.onMessage(message);
      }
      log.info(`[${this.deps.threadTs}] agent stream ended`);
    } catch (error) {
      if (this.closed) {
        log.debug(`[${this.deps.threadTs}] stream ended during shutdown`, error);
      } else {
        log.error(`[${this.deps.threadTs}] session crashed`, error);
        await this.reportFailure(error);
      }
    } finally {
      this.running = false;
      this.handle = null;
      this.aborter = null;
      this.idle = true;
      this.abandoned = false;
      this.stopStatusTimer();
      this.stopStallWatchdog();
      this.signal();
      // A dead stream must not strand queued work: restart if anything is waiting.
      if (!this.closed && this.pending.length > 0) {
        log.info(`[${this.deps.threadTs}] restarting session for ${this.pending.length} queued message(s)`);
        void this.start();
      } else {
        this.deps.onStreamEnd?.();
      }
    }
  }

  private async onMessage(message: SDKMessage): Promise<void> {
    // Any message at all counts as the turn still being alive. This runs before
    // the switch on purpose, so partial stream events refresh the watchdog even
    // though they fall through to `default`.
    this.lastProgressAt = Date.now();

    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.sessionId = message.session_id;
          this.persist({ sessionId: message.session_id });
          log.info(`[${this.deps.threadTs}] session ${message.session_id} on ${message.cwd} (${message.model})`);
        }
        return;

      case 'assistant': {
        for (const block of message.message.content ?? []) {
          if (block.type === 'text' && block.text.trim()) {
            this.textBuffer.push(block.text);
          } else if (block.type === 'tool_use') {
            const label = toolLabel(block.name, (block.input ?? {}) as Record<string, unknown>);
            this.activity.push(label);
            this.emit({
              type: 'turn:progress',
              at: Date.now(),
              threadTs: this.deps.threadTs,
              channel: this.deps.channel,
              tool: label,
              count: this.activity.length,
            });
            this.scheduleStatusUpdate();
          }
        }
        return;
      }

      case 'result':
        await this.onTurnEnd(message);
        return;

      default:
        return;
    }
  }

  private async onTurnEnd(message: Extract<SDKMessage, { type: 'result' }>): Promise<void> {
    const { slack, channel, threadTs } = this.deps;
    this.stopStatusTimer();
    this.stopStallWatchdog();

    const endedAt = Date.now();
    const failed = message.is_error || message.subtype !== 'success';
    // Cumulative across the streaming session, so this turn cost the increment.
    const total = Number.isFinite(message.total_cost_usd) ? message.total_cost_usd : this.lastCostUsd;
    const turnCost = total >= this.lastCostUsd ? total - this.lastCostUsd : total;
    this.lastCostUsd = total;

    const info: TurnEndInfo = {
      failed,
      durationMs: message.duration_ms,
      costUsd: turnCost,
      toolCount: this.activity.length,
      numTurns: message.num_turns,
      subtype: message.subtype,
    };

    const body = message.subtype === 'success' ? message.result.trim() : turnFailedMessage(message.subtype);

    // Drop the live status message and post the answer fresh. Editing the status
    // message in place would read cleaner, but Slack does not push-notify an
    // edit, and being notified when a turn finishes is the point of this bridge.
    await this.clearStatus();

    try {
      await slack.postToThread(channel, threadTs, body, receiptFooter(this.project, info));
    } catch (error) {
      log.error(`[${threadTs}] failed to post result`, error);
    }

    await this.markFinished(failed);

    this.persist({
      lastActiveAt: new Date().toISOString(),
      turns: message.num_turns,
      costUsd: total,
    });
    const errorText = message.subtype === 'success' ? undefined : message.errors.join('; ').slice(0, 500) || message.subtype;
    this.recordTurn(endedAt, info, errorText);

    this.lastActiveAt = endedAt;
    this.idle = true;
    this.signal();

    log.info(`[${threadTs}] turn done in ${formatDuration(info.durationMs)}, ${info.toolCount} tools`);
    this.emit({
      type: 'turn:ended',
      at: endedAt,
      threadTs,
      channel,
      projectId: this.project.id,
      info,
    });
    this.deps.onTurnEnd?.(info);
  }

  private async reportFailure(error: unknown): Promise<void> {
    const { slack, channel, threadTs } = this.deps;
    const detail = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      await slack.postToThread(channel, threadTs, sessionErrorMessage(detail));
    } catch (postError) {
      log.error(`[${threadTs}] could not report failure to Slack`, postError);
    }
    await this.clearStatus();
    await this.markFinished(true);

    const endedAt = Date.now();
    const info: TurnEndInfo = {
      failed: true,
      durationMs: this.turnStartedAt ? endedAt - this.turnStartedAt : 0,
      costUsd: 0,
      toolCount: this.activity.length,
      numTurns: 0,
      subtype: 'error_stream',
    };
    this.recordTurn(endedAt, info, detail.slice(0, 500));
    this.emit({ type: 'turn:ended', at: endedAt, threadTs, channel, projectId: this.project.id, info });
    this.deps.onTurnEnd?.(info);
  }

  private recordTurn(endedAt: number, info: TurnEndInfo, error?: string): void {
    if (!this.turnStartedAt) return;
    try {
      this.deps.storage.recordTurn({
        channel: this.deps.channel,
        threadTs: this.deps.threadTs,
        projectId: this.project.id,
        alias: this.project.alias,
        startedAt: this.turnStartedAt,
        endedAt,
        durationMs: info.durationMs || endedAt - this.turnStartedAt,
        toolCount: info.toolCount,
        costUsd: info.costUsd,
        failed: info.failed,
        subtype: info.subtype,
        ...(error ? { error } : {}),
        preview: this.promptPreview,
      });
    } catch (storageError) {
      log.warn(`[${this.deps.threadTs}] could not record turn`, storageError);
    }
  }

  // --- Slack surface -------------------------------------------------------

  private async markWorking(): Promise<void> {
    const { slack, channel } = this.deps;
    await Promise.all(this.inFlightTs.map((ts) => slack.react(channel, ts, REACTIONS.working)));
  }

  private async markFinished(failed: boolean): Promise<void> {
    const { slack, channel } = this.deps;
    const targets = this.inFlightTs;
    this.inFlightTs = [];
    await Promise.all(
      targets.flatMap((ts) => [
        slack.unreact(channel, ts, REACTIONS.working),
        slack.react(channel, ts, failed ? REACTIONS.failed : REACTIONS.done),
      ]),
    );
  }

  /** Throttled so a tool-heavy turn cannot blow through Slack's chat.update rate limit. */
  private scheduleStatusUpdate(): void {
    const wait = Math.max(0, this.deps.tuning.statusUpdateMs - (Date.now() - this.lastStatusAt));
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      void this.flushStatus();
    }, wait);
  }

  private stopStatusTimer(): void {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
  }

  private statusText(): string {
    const recent = this.activity.slice(-6).map((entry) => `• ${entry}`);
    const hidden = this.activity.length - recent.length;
    const elapsed = formatDuration(Date.now() - this.turnStartedAt);
    const lines = [`_working… ${elapsed}_`];
    if (hidden > 0) lines.push(`_…${hidden} earlier step${hidden === 1 ? '' : 's'}_`);
    lines.push(...recent);
    return lines.join('\n');
  }

  private async flushStatus(): Promise<void> {
    if (this.idle || this.closed) return;
    const { slack, channel, threadTs } = this.deps;
    this.lastStatusAt = Date.now();
    const text = this.statusText();

    if (!this.statusTs) {
      this.statusTs = (await slack.postRaw(channel, threadTs, text)) || null;
    } else {
      await slack.update(channel, this.statusTs, text);
    }
  }

  private async clearStatus(): Promise<void> {
    const { slack, channel } = this.deps;
    const ts = this.statusTs;
    this.statusTs = null;
    if (ts) await slack.deleteMessage(channel, ts);
  }

  // --- stall watchdog ------------------------------------------------------

  private startStallWatchdog(): void {
    this.stopStallWatchdog();
    this.lastProgressAt = Date.now();
    // Poll rather than one long timer, so the deadline slides with real progress
    // and a legitimately long turn is never killed for taking its time.
    this.stallTimer = setInterval(() => {
      if (this.idle || this.closed) return;
      if (Date.now() - this.lastProgressAt < this.deps.tuning.turnStallMinutes * 60_000) return;
      void this.onStall();
    }, 30_000);
    this.stallTimer.unref();
  }

  private stopStallWatchdog(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /**
   * The turn produced nothing for turnStallMinutes. Without this the thread
   * would be deaf forever: `idle` never flips back, so every later message
   * queues behind a turn that will never finish.
   */
  private async onStall(): Promise<void> {
    const { slack, channel, threadTs } = this.deps;
    const silentMs = Date.now() - this.lastProgressAt;
    const silent = formatDuration(silentMs);
    log.warn(`[${threadTs}] turn stalled, no output for ${silent}, resetting session`);

    this.stopStallWatchdog();
    this.stopStatusTimer();
    await this.clearStatus();

    try {
      await slack.postToThread(channel, threadTs, stallMessage(silent));
    } catch (error) {
      log.error(`[${threadTs}] could not post stall notice`, error);
    }

    await this.markFinished(true);

    const endedAt = Date.now();
    this.recordTurn(
      endedAt,
      {
        failed: true,
        durationMs: endedAt - this.turnStartedAt,
        costUsd: 0,
        toolCount: this.activity.length,
        numTurns: 0,
        subtype: 'error_stalled',
      },
      `no output for ${silent}`,
    );
    this.emit({ type: 'turn:stalled', at: endedAt, threadTs, channel, silentMs });

    // Interrupting here is recovery, not preemption. A queued user message never
    // takes this path; only a turn that has stopped responding does.
    try {
      await this.handle?.interrupt();
    } catch {
      // The wedged turn may already be unreachable; the unwind below still frees it.
    }

    this.idle = true;
    this.abandoned = true;
    this.signal();
  }

  private emit(event: TurnEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch (error) {
      log.debug('session event handler threw', error);
    }
  }

  private persist(patch: Partial<ThreadRecord>): void {
    this.deps.storage.patchThread(this.deps.channel, this.deps.threadTs, patch);
  }

  /**
   * Graceful teardown: closes stdin so the CLI exits cleanly. The session id
   * survives in the database, so a reply days later resumes the conversation.
   * `force` also aborts the in-flight turn, which is what stops a quit from
   * orphaning a 317 MB child process that is midway through a turn.
   */
  close(opts: { force?: boolean } = {}): void {
    this.closed = true;
    this.stopStatusTimer();
    this.stopStallWatchdog();
    this.signal();
    if (opts.force) {
      try {
        this.aborter?.abort();
      } catch {
        // Already gone; nothing else to do.
      }
    }
  }
}
