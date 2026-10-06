/**
 * Step 9: review, app behaviour, and finish.
 *
 * Finishing marks setup complete and, when the operator asked for it, connects
 * straight away. It checks the current service state first rather than calling
 * start unconditionally, because main may already have started the service off
 * the back of completing setup and two starts on one app token is the failure
 * this app works hardest to avoid.
 */

import type { LoginItemState, SetupCheckResult } from '../../../shared/contract.ts';
import { PERMISSION_MODE_LABELS } from '../../../shared/contract.ts';
import { allChecksPassed, checkRow, failureSummary } from '../checks-ui.ts';
import { Bag, button, card, el, emptyState, switchControl } from '../ui.ts';
import type { StepContext, StepHandle, StepModule } from './types.ts';

function factRow(label: string, value: string): HTMLElement {
  return el(
    'div',
    { class: 'row spread hairline' },
    el('span', { class: 'field-label', text: label }),
    el('span', { class: 'field-hint', text: value }),
  );
}

export const finishStep: StepModule = {
  id: 'finish',
  label: 'Finish',
  title: 'Review and finish',
  subtitle: 'One last look, then the bridge goes live.',

  mount(ctx: StepContext): StepHandle {
    const bag = new Bag();
    const config = ctx.state.config;
    let loginItem: LoginItemState | null = null;

    // review ------------------------------------------------------------------
    const operators = config.slack.allowed.filter((entry) => entry.id);
    const review = card({
      title: 'What is configured',
      body: [
        factRow('Workspace', config.slack.workspace ? `${config.slack.workspace.teamName}` : 'not verified'),
        factRow('Bot', config.slack.workspace ? `@${config.slack.workspace.botName} (${config.slack.workspace.botUserId})` : 'not verified'),
        factRow('Tokens', `${ctx.state.secrets.bot.hint ?? 'bot missing'} · ${ctx.state.secrets.app.hint ?? 'app missing'}`),
        factRow('Live test', config.slack.eventsVerifiedAt ? `passed ${new Date(config.slack.eventsVerifiedAt).toLocaleString()}` : 'skipped'),
        factRow('Operators', operators.length === 0 ? 'nobody resolved' : operators.map((entry) => entry.name ?? entry.entry).join(', ')),
        factRow(
          'Projects',
          config.projects.length === 0 ? 'none' : config.projects.map((project) => `${project.alias} (${project.name})`).join(', '),
        ),
        factRow('Model', `${config.agent.model} · effort ${config.agent.effort}`),
        factRow('Permission mode', PERMISSION_MODE_LABELS[config.agent.permissionMode].title),
      ],
    });

    // app behaviour -----------------------------------------------------------
    const loginSwitch = switchControl({
      label: 'Start when I log in',
      hint: 'Loading…',
      checked: false,
      disabled: true,
      onChange: (checked) => {
        void (async () => {
          loginItem = await window.api.setLoginItem(checked);
          renderLoginState();
        })();
      },
    });

    const loginNote = el('p', { class: 'field-hint' });

    function renderLoginState(): void {
      if (!loginItem) return;
      loginSwitch.set(loginItem.enabled);
      loginSwitch.setDisabled(!loginItem.supported);
      if (!loginItem.supported) {
        loginNote.textContent =
          'Only available in the packaged app. A development build would register the Electron helper binary instead of this app, so the toggle stays off here.';
      } else if (loginItem.status === 'requires-approval') {
        loginNote.textContent =
          'macOS has the item registered but is waiting for your approval. Open System Settings, Login Items, and allow slack-code, or it will not actually start.';
      } else if (loginItem.enabled) {
        loginNote.textContent = 'It will start in the menu bar with no window, and connect if the switch below is on.';
      } else {
        loginNote.textContent = 'Off. You will start it yourself.';
      }
    }

    const openLoginSettings = button('Open Login Items', {
      variant: 'ghost',
      onClick: () => {
        void window.api.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
      },
    });

    const menuBarSwitch = switchControl({
      label: 'Live in the menu bar',
      hint: 'No Dock icon. The window opens from the menu bar icon and closing it leaves the bridge running.',
      checked: config.app.menuBarOnly,
      onChange: (checked) => {
        void ctx.state.save({ app: { menuBarOnly: checked } });
      },
    });

    const connectSwitch = switchControl({
      label: 'Connect on launch',
      hint: 'Open the Slack connection as soon as the app starts. Turn this off if you would rather press Start yourself.',
      checked: config.app.connectOnLaunch,
      onChange: (checked) => {
        void ctx.state.save({ app: { connectOnLaunch: checked } });
      },
    });

    const behaviour = card({
      title: 'How the app behaves',
      body: [loginSwitch.wrap, loginNote, menuBarSwitch.wrap, connectSwitch.wrap],
      footer: [openLoginSettings],
    });

    // final checks ------------------------------------------------------------
    const checkSlot = el('div', { class: 'stack' }, emptyState('Not run yet.'));
    const checkSummary = el('p', { class: 'field-hint', text: '' });
    const runChecks = button('Run all checks', {
      onClick: () => {
        void (async () => {
          runChecks.disabled = true;
          checkSlot.replaceChildren(el('p', { class: 'field-hint', text: 'Running…' }));
          checkSummary.textContent = '';
          let results: SetupCheckResult[] = [];
          try {
            results = await window.api.runAllChecks();
          } finally {
            runChecks.disabled = false;
          }
          checkSlot.replaceChildren();
          for (const result of results) {
            const row = checkRow(result.label);
            row.setResult(result);
            checkSlot.appendChild(row.node);
          }
          checkSummary.textContent = failureSummary(results);
          ctx.say(failureSummary(results), allChecksPassed(results) ? 'ok' : 'bad');
        })();
      },
    });

    const checks = card({
      title: 'Everything at once',
      subtitle: 'The same checks the app runs from the menu bar and from npm run doctor.',
      body: [checkSlot, checkSummary],
      footer: [runChecks],
    });

    const howToUse = card({
      title: 'Then, in Slack',
      body: [
        el('p', { class: 'field-hint', text: `DM @${config.slack.workspace?.botName ?? 'the bot'} with the alias on the first line:` }),
        el(
          'pre',
          { class: 'code' },
          el('code', { text: `${config.projects[0]?.alias ?? 'alias'}\nwhat changed in the last commit?` }),
        ),
        el('p', { class: 'field-hint', text: 'Later replies in that thread do not need the alias. Send !help in any thread for the rest.' }),
      ],
    });

    ctx.body.append(review, behaviour, checks, howToUse);

    void (async () => {
      loginItem = await window.api.getLoginItem();
      renderLoginState();
    })();

    return {
      destroy: () => bag.dispose(),
      canAdvance: () => true,
      nextLabel: 'Finish setup',
      async beforeNext() {
        const done = await window.api.completeSetup();
        if (!done.ok) {
          ctx.say(done.error, 'bad');
          return false;
        }
        await ctx.state.reload();

        if (ctx.state.config.app.connectOnLaunch) {
          const status = await window.api.getStatus();
          if (status.state === 'stopped') {
            const started = await window.api.startService();
            // A failed start is not a failed setup. The dashboard shows the
            // reason and the operator can fix it there.
            if (!started.ok) ctx.say(`Setup saved, but the connection failed: ${started.error}`, 'bad');
          }
        }
        return true;
      },
    };
  },
};
