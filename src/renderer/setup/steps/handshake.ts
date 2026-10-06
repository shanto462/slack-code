/**
 * Step 5: the live Socket Mode handshake.
 *
 * This is the only step that proves the thing nothing else can prove. Both
 * tokens can verify, the socket can connect, the allowlist can resolve, and DMs
 * can still never arrive because the app has no `message.im` event
 * subscription. The Slack API cannot report that, so the only honest test is to
 * open a real socket and wait for a real DM.
 *
 * The temporary connection is closed before setup continues. Leaving it open
 * would put two Socket Mode connections on one app token, and Slack load
 * balances events across connections, so roughly half the operator's messages
 * would land on a socket nobody is reading.
 */

import type { HandshakeResult, HandshakeSession } from '../../../shared/contract.ts';
import { Bag, button, card, copyText, el, flashLabel, pill } from '../ui.ts';
import type { StepContext, StepHandle, StepModule } from './types.ts';

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

export const handshakeStep: StepModule = {
  id: 'handshake',
  label: 'Live test',
  title: 'Send the bot a DM',
  subtitle: 'The one failure the Slack API cannot report: everything verifies and no message ever arrives.',
  skippable: true,

  mount(ctx: StepContext): StepHandle {
    const bag = new Bag();
    let session: HandshakeSession | null = null;
    let verified = Boolean(ctx.state.config.slack.eventsVerifiedAt);
    let running = false;
    let countdown: HTMLElement | null = null;

    const slot = el('div', { class: 'stack' });
    const statusSlot = el('div', { class: 'stack' });

    function renderIdle(): void {
      countdown = null;
      slot.replaceChildren(
        card({
          title: 'Ready when you are',
          body: [
            el('p', {
              class: 'field-hint',
              text: 'This opens a temporary Socket Mode connection, gives you a code word, and waits for you to DM it to the bot. The connection closes again as soon as it succeeds, times out, or you move on.',
            }),
          ],
          footer: [button(verified ? 'Run it again' : 'Start the test', { variant: 'primary', onClick: () => void start() })],
        }),
      );
    }

    function renderWaiting(active: HandshakeSession): void {
      const botName = ctx.state.identity?.botName ?? 'the bot';
      countdown = el('span', { class: 'field-hint', text: `${secondsLeft(active.expiresAt)}s left` });

      const copyButton = button('Copy code word', {
        onClick: () => {
          void (async () => {
            if (await copyText(active.codeWord)) flashLabel(copyButton, 'Copied');
          })();
        },
      });

      slot.replaceChildren(
        card({
          title: 'Waiting for your DM',
          body: [
            el('p', { class: 'field-label', text: `Open Slack, DM @${botName}, and send exactly:` }),
            el('p', { class: 'code', text: active.codeWord }),
            el('div', { class: 'row' }, pill('warn', 'listening'), countdown),
            el('p', {
              class: 'field-hint',
              text: 'Send it as a normal direct message, not in a channel and not as a thread reply. The bot is not in any channel.',
            }),
          ],
          footer: [copyButton, button('Cancel', { variant: 'ghost', onClick: () => void cancel() })],
        }),
      );
    }

    function renderResult(result: HandshakeResult): void {
      statusSlot.replaceChildren(
        card({
          title: result.ok ? 'Events are arriving' : 'Nothing arrived',
          body: [
            el(
              'div',
              { class: 'row' },
              pill(result.ok ? 'ok' : 'bad', result.ok ? 'verified' : 'failed'),
              el('span', { class: 'field-hint', text: result.detail }),
            ),
            result.ok
              ? el('p', {
                  class: 'field-hint',
                  text: 'The catch-up cursor for that conversation is now set to this message, so the first real connection will not replay anything older than it.',
                })
              : el(
                  'ul',
                  { class: 'stack' },
                  el('li', { text: 'Event subscriptions: the app needs the message.im bot event. By far the commonest cause.' }),
                  el('li', { text: 'A scope or event added after installation only takes effect once the app is reinstalled to the workspace.' }),
                  el('li', { text: 'Socket Mode has to be switched on in the app settings, not only implied by having an app-level token.' }),
                  el('li', { text: 'Send a plain DM to the bot, not a message in a channel.' }),
                  el('li', { text: 'If the old headless daemon is still running it takes about half the events. Quit it first.' }),
                ),
          ],
          footer: result.ok ? [] : [button('Try again', { variant: 'primary', onClick: () => void start() })],
        }),
      );
    }

    async function start(): Promise<void> {
      statusSlot.replaceChildren();
      ctx.say('Opening a temporary connection…');
      const result = await window.api.startHandshake();
      if (!result.ok) {
        running = false;
        renderIdle();
        statusSlot.replaceChildren(
          card({
            title: 'Could not open the connection',
            body: [
              el('p', { class: 'field-error', text: result.error }),
              el('p', {
                class: 'field-hint',
                text: 'This is the app-level token or Socket Mode itself, not the bot token. Go back one step and re-check it.',
              }),
            ],
          }),
        );
        ctx.say(result.error, 'bad');
        return;
      }
      session = result.value;
      running = true;
      renderWaiting(session);
      ctx.say('Listening. Send the code word from Slack.');
    }

    async function cancel(): Promise<void> {
      running = false;
      session = null;
      await window.api.cancelHandshake();
      renderIdle();
      ctx.say('Stopped listening.');
      ctx.refresh();
    }

    async function timeout(): Promise<void> {
      running = false;
      session = null;
      await window.api.cancelHandshake();
      renderIdle();
      renderResult({ ok: false, detail: 'Nothing arrived before the code word expired.' });
      ctx.say('Timed out.', 'bad');
      ctx.refresh();
    }

    // One ticker for the whole step, so restarting the test cannot leave a
    // second countdown running behind the first.
    bag.interval(() => {
      if (!running || !session || !countdown) return;
      const left = secondsLeft(session.expiresAt);
      countdown.textContent = `${left}s left`;
      if (left === 0) void timeout();
    }, 1000);

    bag.add(
      window.api.onHandshake((result) => {
        void (async () => {
          running = false;
          session = null;
          renderIdle();
          renderResult(result);
          if (result.ok) {
            verified = true;
            const saved = await ctx.state.save({ slack: { eventsVerifiedAt: new Date().toISOString() } });
            ctx.say(saved.ok ? 'Verified. Events reach this app.' : `Verified, but it could not be recorded: ${saved.error}`, saved.ok ? 'ok' : 'bad');
          } else {
            ctx.say(result.detail, 'bad');
          }
          ctx.refresh();
        })();
      }),
    );

    bag.add(() => {
      // Leaving by Back, by Continue, or by closing the window all end here, and
      // all of them must close the temporary socket.
      if (running) void window.api.cancelHandshake();
    });

    ctx.body.append(slot, statusSlot);
    renderIdle();

    const verifiedAt = ctx.state.config.slack.eventsVerifiedAt;
    if (verifiedAt) renderResult({ ok: true, detail: `Already verified on ${new Date(verifiedAt).toLocaleString()}.` });

    return {
      destroy: () => bag.dispose(),
      canAdvance: () => true,
      get nextLabel() {
        return verified ? 'Continue' : 'Skip the test';
      },
      async beforeNext() {
        if (running) await cancel();
        ctx.state.acknowledge('handshake');
        return true;
      },
    };
  },
};
