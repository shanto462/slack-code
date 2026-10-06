/**
 * Steps 2 and 3: the two Slack tokens.
 *
 * Both steps are the same shape, so they are one factory: paste, verify against
 * the real API, and only then hand the value to the secret store. The wizard
 * never sees a stored token again, so a token already in the store is verified
 * by asking main to run the check for us.
 */

import type { SecretsStatus, SetupCheckId, SetupCheckResult, SlackIdentity } from '../../../shared/contract.ts';
import { checkRow } from '../checks-ui.ts';
import { Bag, button, card, el, secretField } from '../ui.ts';
import type { StepContext, StepHandle, StepModule } from './types.ts';

export interface TokenStepSpec {
  id: Extract<SetupCheckId, 'botToken' | 'appToken'>;
  label: string;
  title: string;
  subtitle: string;
  /** The prefix Slack guarantees for this token type. */
  prefix: string;
  fieldLabel: string;
  placeholder: string;
  hint: string;
  /** Where in the Slack admin UI this token is found. */
  where: string[];
  verify(token: string): Promise<SetupCheckResult>;
  /** Called once the token has been stored. Lets the bot step persist the workspace identity. */
  afterStore?(ctx: StepContext, result: SetupCheckResult): Promise<void>;
}

/**
 * Slack tokens are usually pasted, and a paste picks up wrapping quotes from a
 * .env line or a trailing newline from a terminal. Strip that here rather than
 * letting the operator stare at an "invalid_auth" they cannot see the cause of.
 */
function cleanToken(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '').trim();
}

function presenceOf(secrets: SecretsStatus, id: TokenStepSpec['id']): { present: boolean; hint?: string } {
  return id === 'botToken' ? secrets.bot : secrets.app;
}

function isIdentity(value: unknown): value is SlackIdentity {
  return typeof value === 'object' && value !== null && typeof (value as SlackIdentity).botUserId === 'string';
}

export function tokenStep(spec: TokenStepSpec): StepModule {
  return {
    id: spec.id,
    label: spec.label,
    title: spec.title,
    subtitle: spec.subtitle,

    mount(ctx: StepContext): StepHandle {
      const bag = new Bag();
      let verified = false;
      let busy = false;

      // Not the field label again: the pane header and the field already say it.
      const row = checkRow('Verified with Slack', 'Paste the token, then verify it.');
      const storedSlot = el('div', { class: 'stack' });
      const entrySlot = el('div', { class: 'stack' });

      const verifyButton = button('Verify with Slack', {
        variant: 'primary',
        disabled: true,
        onClick: () => {
          void runVerify();
        },
      });

      const field = secretField({
        label: spec.fieldLabel,
        placeholder: spec.placeholder,
        hint: spec.hint,
        onInput: (value) => {
          const cleaned = cleanToken(value);
          if (cleaned && !cleaned.startsWith(spec.prefix)) {
            field.setError(`That does not start with ${spec.prefix}, so it is a different kind of token.`);
          } else if (/\s/.test(cleaned)) {
            field.setError('There is a space inside the token. Copy it again straight from Slack.');
          } else {
            field.setError(null);
          }
          verifyButton.disabled = cleaned.length < 10 || busy;
        },
        onEnter: () => {
          if (!verifyButton.disabled) void runVerify();
        },
      });

      async function runVerify(): Promise<void> {
        const token = cleanToken(field.input.value);
        if (!token) return;
        busy = true;
        verifyButton.disabled = true;
        row.setRunning();
        ctx.say('Asking Slack…');

        const result = await spec.verify(token);
        row.setResult(result);
        busy = false;

        if (!result.ok) {
          verified = false;
          verifyButton.disabled = false;
          ctx.say(result.detail, 'bad');
          ctx.refresh();
          return;
        }

        // Verified tokens go into the secret store the moment they pass, so a
        // quit here does not lose a token the operator already proved good.
        const stored = await window.api.setSecrets(spec.id === 'botToken' ? { botToken: token } : { appToken: token });
        if (!stored.ok) {
          verified = false;
          verifyButton.disabled = false;
          ctx.say(`Slack accepted the token but it could not be stored: ${stored.error}`, 'bad');
          ctx.refresh();
          return;
        }

        ctx.state.secrets = stored.value;
        await spec.afterStore?.(ctx, result);

        verified = true;
        field.input.value = '';
        field.setError(null);
        ctx.say('Verified and stored.', 'ok');
        renderStored();
        ctx.refresh();
      }

      function renderEntry(): void {
        entrySlot.replaceChildren(
          card({
            title: 'Paste the token',
            body: [field.wrap, row.node],
            footer: [verifyButton],
          }),
        );
        verifyButton.disabled = cleanToken(field.input.value).length < 10;
        field.input.focus();
      }

      function renderStored(): void {
        const presence = presenceOf(ctx.state.secrets, spec.id);
        if (!presence.present) {
          storedSlot.replaceChildren();
          return;
        }
        storedSlot.replaceChildren(
          card({
            title: 'Stored',
            body: [
              el(
                'div',
                { class: 'row spread hairline' },
                el('span', { class: 'field-label', text: 'Token' }),
                el('span', { class: 'code', text: presence.hint ?? 'encrypted' }),
              ),
              el('p', {
                class: 'field-hint',
                text: 'Encrypted with the macOS Keychain. It is never shown in full again and is never sent to this window.',
              }),
            ],
            footer: [
              button('Re-check with Slack', {
                onClick: () => {
                  void checkStored();
                },
              }),
              button('Replace', {
                variant: 'ghost',
                onClick: () => {
                  verified = false;
                  row.setIdle('Paste the replacement, then verify it.');
                  ctx.refresh();
                  field.input.focus();
                },
              }),
            ],
          }),
        );
      }

      /**
       * The wizard cannot read a stored token back, so verifying one means
       * asking main to run the same check against what it holds. Called
       * automatically on arrival, because a token imported from .env has never
       * actually been proved good.
       */
      async function checkStored(): Promise<void> {
        row.setRunning();
        const result = await window.api.runCheck(spec.id);
        row.setResult(result);
        verified = result.ok;
        if (result.ok) {
          await spec.afterStore?.(ctx, result);
          ctx.say('The stored token is good.', 'ok');
        } else {
          ctx.say(result.detail, 'bad');
        }
        ctx.refresh();
      }

      ctx.body.append(
        card({
          title: 'Where to find it',
          body: [
            (() => {
              const list = el('ol', { class: 'stack' });
              for (const line of spec.where) list.appendChild(el('li', { text: line }));
              return list;
            })(),
          ],
          footer: [
            button('Open api.slack.com/apps', {
              onClick: () => {
                void window.api.openExternal('https://api.slack.com/apps');
              },
            }),
          ],
        }),
        storedSlot,
        entrySlot,
      );

      renderEntry();
      renderStored();

      if (presenceOf(ctx.state.secrets, spec.id).present) {
        void checkStored();
      }

      if (!ctx.state.secrets.encryptionAvailable) {
        ctx.body.insertBefore(
          card({
            title: 'The Keychain is not available',
            body: [
              el('p', {
                class: 'field-error',
                text: 'safeStorage reported that encryption is unavailable, so this app will not write your token to disk. Verification still works and the app can run from memory, but the token will be gone when you quit.',
              }),
              el('p', {
                class: 'field-hint',
                text: 'It never falls back to storing the token in plain text. Sign in to the login Keychain and reopen the app to fix this.',
              }),
            ],
          }),
          ctx.body.firstChild,
        );
      }

      return {
        destroy: () => bag.dispose(),
        canAdvance: () => verified,
      };
    },
  };
}

export const botTokenStep = tokenStep({
  id: 'botToken',
  label: 'Bot token',
  title: 'Bot User OAuth Token',
  subtitle: 'The token the app uses to read your DMs and reply in them.',
  prefix: 'xoxb-',
  fieldLabel: 'Bot User OAuth Token',
  placeholder: 'xoxb-…',
  hint: 'Starts with xoxb-. This is the workspace token, not the app-level one.',
  where: [
    'Open your app on api.slack.com/apps.',
    'Go to OAuth & Permissions.',
    'Copy the Bot User OAuth Token from the top of that page.',
    'If the page has no token yet, install the app to the workspace first.',
  ],
  verify: (token) => window.api.verifyBotToken(token),
  async afterStore(ctx, result) {
    if (!isIdentity(result.data)) return;
    // The workspace identity is what makes this step "complete" on a later
    // resume, and the dashboard shows it in the status bar.
    const saved = await ctx.state.save({ slack: { workspace: result.data } });
    if (!saved.ok) ctx.say(`Verified, but the workspace could not be saved: ${saved.error}`, 'bad');
  },
});

export const appTokenStep = tokenStep({
  id: 'appToken',
  label: 'App token',
  title: 'App-Level Token',
  subtitle: 'The token that opens the Socket Mode connection, so no public URL is needed.',
  prefix: 'xapp-',
  fieldLabel: 'App-Level Token',
  placeholder: 'xapp-…',
  hint: 'Starts with xapp- and needs the connections:write scope. It is not the same as the bot token.',
  where: [
    'Open your app on api.slack.com/apps.',
    'Go to Basic Information, then App-Level Tokens.',
    'Generate Token and Scopes, add the connections:write scope, and generate.',
    'Copy the token straight away. Slack does not show it again.',
  ],
  verify: (token) => window.api.verifyAppToken(token),
});
