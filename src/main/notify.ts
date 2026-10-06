/**
 * Native notifications, for the three things worth interrupting someone about:
 * a turn that failed, a turn the watchdog had to reset, and a socket that has
 * been down long enough to be a real outage rather than a blip.
 *
 * Clicking one opens the Slack thread it came from, because the next thing the
 * operator wants is always to look at the conversation.
 */

import { Notification, shell } from 'electron';
import { logger } from '../core/log.ts';
import type { AppSettings } from '../shared/contract.ts';

const log = logger('notify');

/** A reconnect that resolves inside this window is a blip, not an outage. */
const DISCONNECT_GRACE_MS = 60_000;

/** One notification per thread per this long, so a failing loop cannot spam. */
const PER_THREAD_COOLDOWN_MS = 30_000;

export interface NotifyContext {
  settings: () => AppSettings;
  teamId: () => string | undefined;
}

export class Notifier {
  private readonly lastByKey = new Map<string, number>();
  private disconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly context: NotifyContext) {}

  private allowed(key: string): boolean {
    const now = Date.now();
    const previous = this.lastByKey.get(key) ?? 0;
    if (now - previous < PER_THREAD_COOLDOWN_MS) return false;
    this.lastByKey.set(key, now);
    if (this.lastByKey.size > 200) {
      for (const [entry, at] of this.lastByKey) {
        if (now - at > PER_THREAD_COOLDOWN_MS) this.lastByKey.delete(entry);
      }
    }
    return true;
  }

  private show(options: { title: string; body: string; channel?: string; threadTs?: string }): void {
    if (!Notification.isSupported()) return;
    try {
      const notification = new Notification({ title: options.title, body: options.body, silent: false });
      if (options.channel) {
        notification.on('click', () => this.openInSlack(options.channel as string, options.threadTs));
      }
      notification.show();
    } catch (error) {
      log.debug('could not show a notification', error);
    }
  }

  openInSlack(channel: string, messageTs?: string): void {
    const team = this.context.teamId();
    const params = new URLSearchParams();
    if (team) params.set('team', team);
    params.set('id', channel);
    if (messageTs) params.set('message', messageTs);
    void shell.openExternal(`slack://channel?${params.toString()}`).catch((error) => {
      log.debug('could not open the Slack deep link', error);
    });
  }

  turnFailed(input: { channel: string; threadTs: string; projectName: string; detail: string }): void {
    if (!this.context.settings().notifyOnTurnFailure) return;
    if (!this.allowed(`fail:${input.channel}:${input.threadTs}`)) return;
    this.show({
      title: `${input.projectName}: turn failed`,
      body: input.detail,
      channel: input.channel,
      threadTs: input.threadTs,
    });
  }

  stalled(input: { channel: string; threadTs: string; silentMs: number }): void {
    if (!this.context.settings().notifyOnStall) return;
    if (!this.allowed(`stall:${input.channel}:${input.threadTs}`)) return;
    const minutes = Math.round(input.silentMs / 60_000);
    this.show({
      title: 'Turn reset after a stall',
      body: `No output for ${minutes} minute${minutes === 1 ? '' : 's'}. The thread was freed so it can take new messages.`,
      channel: input.channel,
      threadTs: input.threadTs,
    });
  }

  /**
   * Called on every service state change. The grace timer is what stops a
   * routine Socket Mode reconnect from producing a notification.
   */
  connectionChanged(connected: boolean, detail?: string): void {
    if (connected) {
      if (this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      return;
    }
    if (!this.context.settings().notifyOnDisconnect) return;
    if (this.disconnectTimer) return;

    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      this.show({
        title: 'Slack connection lost',
        body: detail ?? 'The bridge has been disconnected for over a minute. Messages sent meanwhile are replayed on reconnect.',
      });
    }, DISCONNECT_GRACE_MS);
    this.disconnectTimer.unref();
  }

  dispose(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }
}
