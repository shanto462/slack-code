/**
 * Step 1: create the Slack app from a manifest.
 *
 * This is the highest-value screen in the wizard. A missing `message.im` event
 * subscription is the one failure the Slack API structurally cannot report: the
 * tokens verify, the socket connects, the app looks healthy, and DMs simply
 * never arrive. Handing over a manifest with the subscription already in it
 * removes the failure instead of diagnosing it later.
 */

import {
  SLACK_REQUIRED_APP_SCOPES,
  SLACK_REQUIRED_BOT_EVENTS,
  SLACK_REQUIRED_BOT_SCOPES,
} from '../../../shared/contract.ts';
import { Bag, button, card, codeBlock, copyText, el, flashLabel, spinner } from '../ui.ts';
import type { StepContext, StepHandle, StepModule } from './types.ts';

function numbered(items: string[]): HTMLElement {
  const list = el('ol', { class: 'stack' });
  for (const item of items) list.appendChild(el('li', { text: item }));
  return list;
}

function scopeList(title: string, scopes: readonly string[], note?: string): HTMLElement {
  const row = el('div', { class: 'row' });
  for (const scope of scopes) row.appendChild(el('span', { class: 'chip', text: scope }));
  return el(
    'div',
    { class: 'field' },
    el('span', { class: 'field-label', text: title }),
    row,
    note ? el('p', { class: 'field-hint', text: note }) : null,
  );
}

export const slackAppStep: StepModule = {
  id: 'slackApp',
  label: 'Slack app',
  title: 'Create the Slack app',
  subtitle: 'Paste one manifest and every scope and event is already correct.',

  mount(ctx: StepContext): StepHandle {
    const bag = new Bag();
    const manifestSlot = el('div', { class: 'stack' }, spinner('Loading manifest'));

    const copyButton = button('Copy manifest', {
      variant: 'primary',
      onClick: () => {
        void (async () => {
          const copied = await copyText(manifest);
          if (copied) {
            flashLabel(copyButton, 'Copied');
            ctx.say('Manifest copied. Paste it into Slack.', 'ok');
          } else {
            ctx.say('Could not reach the clipboard. Select the text below and copy it by hand.', 'bad');
          }
        })();
      },
    });

    const openButton = button('Open api.slack.com/apps', {
      onClick: () => {
        void window.api.openExternal('https://api.slack.com/apps');
      },
    });

    let manifest = '';

    const steps = card({
      title: 'In Slack',
      body: [
        numbered([
          'Open api.slack.com/apps and choose Create New App, then From an app manifest.',
          'Pick the workspace the bot should live in. This is the workspace it will answer DMs in.',
          'Switch the manifest editor to YAML and replace everything in it with the manifest below.',
          'Create the app, then open Install App and install it to the workspace.',
          'Under Basic Information, App-Level Tokens, generate a token with the connections:write scope. You will need it two steps from now.',
        ]),
        el('p', {
          class: 'field-hint',
          text: 'Already have the app from the old daemon? Open it, go to Settings, App Manifest, and compare it against this one. A scope added after installation only takes effect once you reinstall.',
        }),
      ],
      footer: [copyButton, openButton],
    });

    const requirements = card({
      title: 'What the manifest asks for, and why',
      body: [
        scopeList('Bot token scopes', SLACK_REQUIRED_BOT_SCOPES, 'Read DMs, reply in threads, react, and look up the operator ids in your allowlist.'),
        scopeList(
          'Event subscriptions',
          SLACK_REQUIRED_BOT_EVENTS,
          'The one that matters. Without message.im the app connects, the tokens verify, and no DM ever reaches it. Nothing in the API reports this.',
        ),
        scopeList('App-level token scope', SLACK_REQUIRED_APP_SCOPES, 'Socket Mode, so the app needs no public URL and no tunnel.'),
      ],
    });

    ctx.body.append(steps, manifestSlot, requirements);

    void (async () => {
      try {
        manifest = await window.api.slackAppManifest();
        manifestSlot.replaceChildren(
          card({
            title: 'App manifest',
            subtitle: 'YAML. Paste this over everything in the Slack manifest editor.',
            body: [codeBlock(manifest)],
          }),
        );
      } catch (error) {
        manifestSlot.replaceChildren(
          card({
            title: 'App manifest',
            body: [el('p', { class: 'field-error', text: `Could not build the manifest: ${String(error)}` })],
          }),
        );
      }
    })();

    return {
      destroy: () => bag.dispose(),
      canAdvance: () => true,
      nextLabel: 'I have created the app',
      async beforeNext() {
        ctx.state.acknowledge('slackApp');
        return true;
      },
    };
  },
};
