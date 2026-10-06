/**
 * Step 8: probe this machine.
 *
 * Everything before this step tested Slack. This step tests the half that
 * actually runs the work, and it covers two failures that only appear once the
 * app is a GUI app:
 *
 *   1. Claude Code resolves credentials from the login Keychain by USER
 *      identity, so a spawned agent without HOME, USER and LOGNAME fails every
 *      turn with "Not logged in".
 *   2. An app launched from Finder or a login item inherits a minimal PATH, and
 *      the agent's Bash tool runs with --noprofile --norc, so it never rebuilds
 *      one. Without a repair the agent has no node, no npm and no rg.
 *
 * The claudeAuth probe spawns the real 317 MB CLI, so it takes seconds. Every
 * check runs in parallel and each row settles on its own.
 */

import type { SetupCheckId, ShellPathCheckData } from '../../../shared/contract.ts';
import { allChecksPassed, checkRow, failureSummary } from '../checks-ui.ts';
import type { CheckRowHandle } from '../checks-ui.ts';
import type { SetupCheckResult } from '../../../shared/contract.ts';
import { Bag, button, card, el } from '../ui.ts';
import type { StepContext, StepHandle, StepModule } from './types.ts';

interface ProbeSpec {
  id: SetupCheckId;
  label: string;
  idle: string;
}

const PROBES: ProbeSpec[] = [
  { id: 'userIdentity', label: 'Keychain identity', idle: 'HOME, USER and LOGNAME reach the agent.' },
  { id: 'shellPath', label: 'Shell PATH', idle: 'The tools the agent will try to run.' },
  { id: 'claudeBinary', label: 'Claude Code binary', idle: 'The CLI the agent actually spawns.' },
  { id: 'claudeAuth', label: 'Claude Code sign-in', idle: 'A real one-turn probe against your first project.' },
  { id: 'legacyDaemon', label: 'Old headless daemon', idle: 'Two copies on one app token split the events.' },
];

function toolTable(data: ShellPathCheckData): HTMLElement {
  const body = el('tbody');
  for (const tool of data.tools) {
    body.appendChild(
      el(
        'tr',
        {},
        el('td', { text: tool.name }),
        el('td', { class: 'code', text: tool.resolved ?? 'not found' }),
      ),
    );
  }
  const table = el(
    'table',
    { class: 'table' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Tool' }), el('th', { text: 'Resolved to' }))),
    body,
  );
  return el(
    'div',
    { class: 'stack' },
    el('div', { style: { 'overflow-x': 'auto' } }, table),
    el('p', { class: 'field-hint', text: `PATH${data.recovered ? ' (recovered from your login shell)' : ''}: ${data.path}` }),
  );
}

export const probeStep: StepModule = {
  id: 'probe',
  label: 'This machine',
  title: 'Check this machine',
  subtitle: 'The half that runs the work: your Keychain sign-in, the PATH the agent will get, and the CLI itself.',
  skippable: true,

  mount(ctx: StepContext): StepHandle {
    const bag = new Bag();
    const rows = new Map<SetupCheckId, CheckRowHandle>();
    const extras = el('div', { class: 'stack' });
    const summary = el('p', { class: 'field-hint', text: 'Not run yet.' });
    let ran = false;

    const runButton = button('Run the checks', {
      variant: 'primary',
      onClick: () => {
        void runAll();
      },
    });

    const rowsSlot = el('div', { class: 'stack' });
    for (const probe of PROBES) {
      const row = checkRow(probe.label, probe.idle);
      rows.set(probe.id, row);
      rowsSlot.appendChild(row.node);
    }

    async function runOne(probe: ProbeSpec): Promise<SetupCheckResult | null> {
      const row = rows.get(probe.id);
      if (!row) return null;

      // claudeAuth needs somewhere real to run. Without a project there is
      // nothing to probe, and saying so beats a confusing failure.
      const project = ctx.state.enabledProjects[0] ?? ctx.state.config.projects[0];
      if (probe.id === 'claudeAuth' && !project) {
        row.setIdle('No project configured, so there is nothing to probe.');
        return null;
      }

      row.setRunning();
      const result = await window.api.runCheck(probe.id, probe.id === 'claudeAuth' && project ? { projectId: project.id } : undefined);
      row.setResult(result);

      if (probe.id === 'shellPath' && result.data) extras.replaceChildren(toolTable(result.data as ShellPathCheckData));
      return result;
    }

    async function runAll(): Promise<void> {
      runButton.disabled = true;
      summary.textContent = 'Running…';
      ctx.say('Probing this machine…');
      const results = (await Promise.all(PROBES.map((probe) => runOne(probe)))).filter(
        (result): result is SetupCheckResult => result !== null,
      );
      ran = true;
      runButton.disabled = false;
      runButton.textContent = 'Run again';
      summary.textContent = failureSummary(results);
      ctx.say(failureSummary(results), allChecksPassed(results) ? 'ok' : 'bad');
      ctx.refresh();
    }

    ctx.body.append(
      card({
        title: 'Checks',
        body: [rowsSlot, summary],
        footer: [runButton],
      }),
      extras,
      card({
        title: 'Why these two in particular',
        body: [
          el('p', {
            class: 'field-hint',
            text: 'Claude Code finds your sign-in in the login Keychain by user identity, not by where the binary lives. A spawned agent missing HOME, USER or LOGNAME fails every single turn with "Not logged in", and the failure looks nothing like its cause.',
          }),
          el('p', {
            class: 'field-hint',
            text: 'An app started from Finder or at login gets a minimal PATH with no Homebrew and no nvm. The agent runs Bash with --noprofile --norc, so it never rebuilds one, and "run the tests" turns into "command not found". This app recovers the PATH from your login shell at startup, and the table above is what the agent will actually see.',
          }),
        ],
      }),
    );

    void runAll();

    return {
      destroy: () => bag.dispose(),
      canAdvance: () => true,
      get nextLabel() {
        return ran ? 'Continue' : 'Skip these checks';
      },
      async beforeNext() {
        ctx.state.acknowledge('probe');
        return true;
      },
    };
  },
};
