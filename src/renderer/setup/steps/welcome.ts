/**
 * Step 0: welcome, and the one-time `.env` import.
 *
 * The import is offered here rather than buried in settings because this is the
 * only moment the operator is already thinking about the old headless daemon.
 * The source `.env` is never touched: main reads it, and the operator deletes it
 * when they are satisfied.
 */

import type { EnvMigrationCandidate } from '../../../shared/contract.ts';
import { Bag, button, card, el, ellipsis } from '../ui.ts';
import type { StepContext, StepHandle, StepModule } from './types.ts';

/** One feature line: a title and a single supporting sentence, no card chrome. */
function point(title: string, detail: string): HTMLElement {
  return el(
    'div',
    { class: 'wizard-point' },
    el('span', { class: 'wizard-point-title', text: title }),
    el('span', { class: 'wizard-point-detail', text: detail }),
  );
}

function factRow(label: string, value: string): HTMLElement {
  return el(
    'div',
    { class: 'row spread hairline' },
    el('span', { class: 'field-label', text: label }),
    el('span', { class: 'field-hint', text: value }),
  );
}

function describeCandidate(candidate: EnvMigrationCandidate): HTMLElement[] {
  const rows: HTMLElement[] = [
    factRow('File', candidate.envPath),
    factRow('Bot token', candidate.hasBotToken ? 'found, will be encrypted' : 'not in the file'),
    factRow('App token', candidate.hasAppToken ? 'found, will be encrypted' : 'not in the file'),
    factRow(
      'Operators',
      candidate.allowedUsers.length === 0
        ? 'none listed'
        : `${candidate.allowedUsers.length} entry${candidate.allowedUsers.length === 1 ? '' : 'ies'}: ${ellipsis(candidate.allowedUsers.join(', '), 80)}`,
    ),
  ];
  if (candidate.projectDir) rows.push(factRow('Project', `${candidate.projectName ?? ''} ${candidate.projectDir}`.trim()));
  if (candidate.model) rows.push(factRow('Model', candidate.model));
  if (candidate.permissionMode) rows.push(factRow('Permission mode', candidate.permissionMode));
  if (candidate.effort) rows.push(factRow('Effort', candidate.effort));
  if (candidate.legacyStatePath) {
    rows.push(
      factRow(
        'Existing threads',
        `${candidate.legacyThreadCount ?? 0} thread(s) and ${candidate.legacyCursorCount ?? 0} catch-up cursor(s)`,
      ),
    );
  }
  return rows;
}

export const welcomeStep: StepModule = {
  id: 'welcome',
  label: 'Welcome',
  title: 'Set up slack-code',
  subtitle: 'Drive Claude Code from a Slack DM, in projects on this Mac.',

  mount(ctx: StepContext): StepHandle {
    const bag = new Bag();

    // A macOS assistant opens with an identity and a promise, not a spec sheet.
    // The old version led with two bordered cards of prose and a table of file
    // paths, which is reference material: it belongs at the end, not the start.
    const hero = el(
      'div',
      { class: 'wizard-hero' },
      el('div', { class: 'wizard-hero-mark', attrs: { 'aria-hidden': 'true' }, text: '⌘' }),
      el('h1', { class: 'wizard-hero-title', text: 'Set up slack-code' }),
      el('p', {
        class: 'wizard-hero-lede',
        text: 'Message your Slack bot and Claude Code works in a project on this Mac, then answers in the thread.',
      }),
    );

    const points = el(
      'div',
      { class: 'wizard-points' },
      point('Connects over Socket Mode', 'No public URL and no tunnel to run.'),
      point('Keeps your tokens in the Keychain', 'Encrypted by macOS, never written in plain text.'),
      point('Answers only to you', 'You choose which Slack accounts can drive it. Everyone else is ignored.'),
      point('Runs in the folders you pick', 'Each gets a short alias you put on the first line of a message.'),
    );

    const reassurance = el('p', {
      class: 'wizard-footnote',
      text: 'Every answer is checked against the real Slack and Claude Code APIs as you go, so a mistake surfaces here rather than three days later in a silent thread.',
    });

    const importSlot = el('div', { class: 'stack' });

    ctx.body.append(hero, points, importSlot, reassurance);


    async function renderImport(): Promise<void> {
      const candidate = await window.api.envCandidate();
      if (!candidate) return;
      importSlot.replaceChildren(
        card({
          title: 'Import your existing .env',
          subtitle: 'The old headless daemon left settings behind. Import them and check them as you go.',
          body: describeCandidate(candidate),
          footer: [
            button('Import these settings', {
              variant: 'primary',
              onClick: () => {
                void runImport(candidate);
              },
            }),
            el('span', { class: 'field-hint', text: 'Your .env file is left exactly as it is. Delete it yourself once this is working.' }),
          ],
        }),
      );
    }

    async function runImport(candidate: EnvMigrationCandidate): Promise<void> {
      ctx.say('Importing…');
      const result = await window.api.importEnv();
      if (!result.ok) {
        ctx.say(result.error, 'bad');
        return;
      }
      ctx.state.config = result.value;
      await ctx.state.refreshSecrets();

      // An imported permission mode is a deliberate prior choice, so it carries
      // across and the agent step shows it preselected. A fresh setup still gets
      // no preselection at all.
      if (candidate.permissionMode) ctx.state.acknowledge('agent');

      importSlot.replaceChildren(
        card({
          title: 'Imported',
          body: [
            factRow('Projects', String(ctx.state.config.projects.length)),
            factRow('Operators listed', String(ctx.state.config.slack.allowed.length)),
            factRow('Bot token', ctx.state.secrets.bot.present ? `stored (${ctx.state.secrets.bot.hint ?? 'encrypted'})` : 'not stored'),
            factRow('App token', ctx.state.secrets.app.present ? `stored (${ctx.state.secrets.app.hint ?? 'encrypted'})` : 'not stored'),
            el('p', {
              class: 'field-hint',
              text: 'Keep going anyway. The next steps verify each of these against Slack rather than trusting the file.',
            }),
          ],
        }),
      );
      ctx.say('Imported. Every value is still verified on the steps ahead.', 'ok');
      ctx.refresh();
    }

    void renderImport();

    return {
      destroy: () => bag.dispose(),
      canAdvance: () => true,
      nextLabel: 'Get started',
      async beforeNext() {
        ctx.state.acknowledge('welcome');
        return true;
      },
    };
  },
};
