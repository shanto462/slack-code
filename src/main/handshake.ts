/**
 * The wizard's live Socket Mode handshake.
 *
 * This step exists because of one specific failure that no API call can report:
 * if the Slack app does not subscribe to the `message.im` bot event, everything
 * verifies green, the daemon starts cleanly, and DMs simply never arrive. The
 * only way to know is to open a real socket and have the operator send a real
 * message through it.
 *
 * The socket is temporary and is always closed before setup continues. Two
 * Socket Mode connections on the same app token are worse than none: Slack
 * load-balances events across them, so roughly half the DMs would go to the
 * connection that is about to be thrown away.
 */

import { SocketModeClient } from '@slack/socket-mode';
import { Slack, type SlackEventLike } from '../core/slack.ts';
import { logger } from '../core/log.ts';
import { err, ok, type HandshakeResult, type HandshakeSession, type Result } from '../shared/contract.ts';

const log = logger('handshake');

/** Long enough to switch to Slack and type, short enough that a stuck socket does not linger. */
const HANDSHAKE_TTL_MS = 180_000;

const WORDS = [
  'otter', 'anvil', 'cobalt', 'ember', 'fern', 'harbour', 'juniper', 'kettle',
  'lantern', 'meadow', 'nimbus', 'opal', 'pebble', 'quartz', 'ridge', 'saffron',
];

function makeCodeWord(): string {
  const bytes = new Uint8Array(2);
  globalThis.crypto.getRandomValues(bytes);
  const word = WORDS[bytes[0]! % WORDS.length] ?? 'otter';
  const number = 10 + (bytes[1]! % 90);
  return `${word}-${number}`;
}

export interface HandshakeDeps {
  /** Returns a reason string when a temporary socket must not be opened, or null when it may. */
  blockedReason: () => string | null;
  onResult: (result: HandshakeResult) => void;
  /** Called on success so the caller can seed the channel cursor to this message. */
  onVerified: (channel: string, ts: string, userId: string) => void;
}

export class HandshakeRunner {
  private socket: SocketModeClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private session: HandshakeSession | null = null;
  private settled = false;

  constructor(private readonly deps: HandshakeDeps) {}

  get active(): boolean {
    return this.socket !== null;
  }

  async start(input: { appToken: string; botToken: string }): Promise<Result<HandshakeSession>> {
    const blocked = this.deps.blockedReason();
    if (blocked) return err(blocked, 'socket_busy');
    if (this.socket) await this.teardown();

    const session: HandshakeSession = { codeWord: makeCodeWord(), expiresAt: Date.now() + HANDSHAKE_TTL_MS };
    this.session = session;
    this.settled = false;

    const slack = new Slack(input.botToken);
    const socket = new SocketModeClient({ appToken: input.appToken });
    this.socket = socket;

    socket.on('message', async ({ ack, event }: { ack: () => Promise<void>; event: SlackEventLike }) => {
      try {
        await ack();
      } catch (error) {
        log.debug('ack failed during the handshake', error);
      }
      await this.consider(event, session, slack);
    });

    socket.on('disconnected', () => log.debug('handshake socket disconnected'));

    try {
      await socket.start();
    } catch (error) {
      await this.teardown();
      const detail = error instanceof Error ? error.message : String(error);
      return err(
        /invalid_auth|not_allowed_token_type/i.test(detail)
          ? 'Socket Mode refused that app-level token. Generate one under Basic Information with the connections:write scope.'
          : `Could not open a Socket Mode connection: ${detail}`,
        'socket_failed',
      );
    }

    this.timer = setTimeout(() => {
      void this.finish({
        ok: false,
        detail:
          'No message arrived in three minutes. The usual cause is that the Slack app has no "message.im" bot event subscribed, so DMs are never delivered.',
      });
    }, HANDSHAKE_TTL_MS);
    this.timer.unref();

    log.info(`handshake open, waiting for the code word ${session.codeWord}`);
    return ok(session);
  }

  private async consider(event: SlackEventLike, session: HandshakeSession, slack: Slack): Promise<void> {
    if (this.settled) return;
    if (event.channel_type !== 'im') return;
    if (event.bot_id || !event.user || !event.channel || !event.ts) return;

    const text = (event.text ?? '').toLowerCase();
    if (!text.includes(session.codeWord.toLowerCase())) return;

    const channel = event.channel;
    const ts = event.ts;
    const userId = event.user;

    this.deps.onVerified(channel, ts, userId);

    try {
      await slack.react(channel, ts, 'white_check_mark');
      await slack.postRaw(
        channel,
        ts,
        'Received. Event delivery works, so DMs will reach the agent. You can go back to the app and finish setup.',
      );
    } catch (error) {
      // Delivery is what was being proved, and it was. A failed reply only means
      // a missing chat:write or reactions:write scope, which the token checks cover.
      log.warn('handshake reply failed, but the inbound event did arrive', error);
    }

    await this.finish({ ok: true, channel, ts, userId, detail: `Received from ${userId} in ${channel}.` });
  }

  private async finish(result: HandshakeResult): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.teardown();
    log.info(result.ok ? 'handshake verified' : `handshake failed: ${result.detail}`);
    this.deps.onResult(result);
  }

  async cancel(): Promise<Result<null>> {
    if (!this.socket) return ok(null);
    this.settled = true;
    await this.teardown();
    log.info('handshake cancelled');
    return ok(null);
  }

  private async teardown(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.session = null;
    if (!socket) return;
    try {
      await socket.disconnect();
    } catch (error) {
      log.debug('handshake socket did not close cleanly', error);
    }
  }
}
