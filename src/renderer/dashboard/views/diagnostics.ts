/**
 * Diagnostics pane: the same checks `npm run doctor` runs, plus where
 * everything lives on disk.
 *
 * The checks come from core, so the app and the terminal can never disagree
 * about what is healthy. The Claude auth probe spawns the real CLI and takes
 * seconds, which is why every check reports its own duration and the pane
 * shows a spinner rather than freezing.
 */

import type { AppInfo, ProjectConfig, Result, SelfTestResult, SetupCheckResult } from '../../../shared/contract.ts';
import {
  button,
  card,
  code,
  dataTable,
  emptyState,
  pill,
  relativeTime,
  select,
  spinner,
  td,
  tr,
  type PillKind,
} from '../components.ts';
import { fill, h, setVisible } from '../dom.ts';
import { formatDuration, plural } from '../format.ts';
import { attempt, type Ctx, type View } from '../types.ts';

export function createDiagnosticsView(ctx: Ctx): View {
  let checks: SetupCheckResult[] = [];
  let running = false;
  let info: AppInfo | null = null;
  let selftest: { text: string; ok: boolean } | null = null;
  let selftestRunning = false;
  let selftestSignature = '';
  let disposed = false;

  const checksBody = h('div', { class: 'stack' });
  const runAll = button('Run all checks', () => void run(), { variant: 'primary' });
  const checksBusy = spinner('Running checks');
  setVisible(checksBusy, false);
  const checksCard = card('Checks', h('div', { class: 'row' }, checksBusy, runAll));
  checksCard.body.appendChild(checksBody);

  const selftestBody = h('div', { class: 'stack' });
  const selftestCard = card('End to end self test');
  selftestCard.body.appendChild(selftestBody);

  const envBody = h('div', { class: 'stack' });
  const envCard = card(
    'Where everything lives',
    button('Copy diagnostics', () => void copyDiagnostics(), { variant: 'ghost' }),
  );
  envCard.body.appendChild(envBody);

  const el = h('div', { class: 'stack' }, checksCard.el, selftestCard.el, envCard.el);

  void (async () => {
    info = await attempt<AppInfo | null>(ctx.api.appInfo(), null);
    if (!disposed) renderEnv();
  })();

  // -- checks --------------------------------------------------------------

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    runAll.disabled = true;
    setVisible(checksBusy, true);
    renderChecks();
    const results = await attempt<SetupCheckResult[]>(ctx.api.runAllChecks(), [], (m) => ctx.flash(m, 'bad'));
    running = false;
    runAll.disabled = false;
    setVisible(checksBusy, false);
    if (disposed) return;
    checks = results;
    renderChecks();
    const failures = results.filter((result) => !result.ok && result.severity === 'error').length;
    ctx.flash(failures === 0 ? 'All checks passed.' : `${plural(failures, 'check')} failed.`, failures === 0 ? 'ok' : 'bad');
  }

  function renderChecks(): void {
    if (checks.length === 0) {
      fill(
        checksBody,
        running
          ? h('span', { class: 'field-hint' }, 'Running. The Claude auth check spawns the CLI, so give it a few seconds.')
          : emptyState('No checks run yet.', 'These are the same checks as npm run doctor, run inside the app.'),
      );
      return;
    }

    const table = dataTable(['', 'Check', 'Result', 'Took'], 'No checks run yet.');
    table.setRows(
      checks.map((check) => {
        const kind: PillKind = check.ok ? 'ok' : check.severity === 'warning' ? 'warn' : 'bad';
        return tr(
          td(pill(kind, check.ok ? 'ok' : check.severity === 'warning' ? 'warn' : 'fail')),
          td(check.label, h('div', { class: 'field-hint' }, relativeTime(check.ranAt))),
          td(
            h(
              'div',
              { class: 'stack' },
              h('span', {}, check.detail),
              check.hint && !check.ok ? h('span', { class: 'field-hint' }, check.hint) : null,
            ),
          ),
          td(check.durationMs === undefined ? '-' : formatDuration(check.durationMs)),
        );
      }),
    );
    fill(checksBody, table.el);
  }

  // -- self test -----------------------------------------------------------

  function renderSelftest(force = true): void {
    const projects = ctx.store.get().config?.projects ?? [];
    const enabled = projects.filter((project: ProjectConfig) => project.enabled);
    // Rebuilding on every status push would reset the picker under the cursor,
    // so a background refresh only repaints when the choices actually changed.
    const signature = `${enabled.map((p) => p.id).join(',')}|${selftestRunning}|${selftest?.text ?? ''}`;
    if (!force && signature === selftestSignature) return;
    selftestSignature = signature;

    if (enabled.length === 0) {
      fill(selftestBody, emptyState('No enabled project to test.', 'Add or enable one under Projects.'));
      return;
    }

    const picker = select(
      enabled.map((project) => ({ value: project.id, label: `${project.name} (${project.alias})` })),
      enabled[0]!.id,
    );

    fill(
      selftestBody,
      h(
        'span',
        { class: 'field-hint' },
        'Posts a real message into Slack, runs one turn against the project, and reads the answer back. It proves the whole path, not just the parts.',
      ),
      h(
        'div',
        { class: 'row' },
        picker,
        button('Run self test', () => void runSelftest(picker.value), { disabled: selftestRunning }),
        selftestRunning ? spinner('Running self test') : null,
      ),
      selftest ? h('div', { class: selftest.ok ? 'field-hint' : 'field-error' }, selftest.text) : null,
    );
  }

  async function runSelftest(projectId: string): Promise<void> {
    if (selftestRunning) return;
    selftestRunning = true;
    selftest = null;
    renderSelftest();
    const result = await attempt<Result<SelfTestResult> | null>(ctx.api.runSelftest(projectId), null, (m) => ctx.flash(m, 'bad'));
    selftestRunning = false;
    if (disposed) return;
    if (!result) {
      renderSelftest();
      return;
    }
    if (!result.ok) selftest = { ok: false, text: result.error };
    else selftest = { ok: result.value.ok, text: `${result.value.detail} (${formatDuration(result.value.durationMs)})` };
    renderSelftest();
  }

  // -- environment ---------------------------------------------------------

  function renderEnv(): void {
    if (!info) {
      fill(envBody, spinner('Reading app info'));
      return;
    }
    const status = ctx.store.get().status;

    const paths: { label: string; value: string; reveal: boolean }[] = [
      { label: 'Application data', value: info.userDataPath, reveal: true },
      { label: 'Database and state', value: info.stateDir, reveal: true },
      { label: 'Settings file', value: info.configPath, reveal: true },
      { label: 'Logs', value: info.logDir, reveal: true },
    ];
    if (status?.claudeExecutablePath) {
      paths.push({ label: 'Claude binary', value: status.claudeExecutablePath, reveal: true });
    }

    fill(
      envBody,
      h(
        'div',
        { class: 'row wrap' },
        h('span', { class: 'field-hint' }, `slack-code ${info.appVersion}`),
        h('span', { class: 'field-hint' }, `Electron ${info.electronVersion}`),
        h('span', { class: 'field-hint' }, `Node ${info.nodeVersion}`),
        h('span', { class: 'field-hint' }, `Chromium ${info.chromeVersion}`),
        h('span', { class: 'field-hint' }, `${info.platform} ${info.arch}`),
        info.isPackaged ? pill('ok', 'packaged') : pill('idle', 'development build'),
      ),
      h('div', { class: 'hairline' }),
      ...paths.map((entry) =>
        h(
          'div',
          { class: 'row spread' },
          h('div', { class: 'stack' }, h('span', { class: 'field-hint' }, entry.label), code(entry.value)),
          entry.reveal ? button('Reveal', () => void ctx.api.revealPath(entry.value), { variant: 'ghost' }) : null,
        ),
      ),
    );
  }

  async function copyDiagnostics(): Promise<void> {
    const result = await attempt<Result<string> | null>(ctx.api.copyDiagnostics(), null, (m) => ctx.flash(m, 'bad'));
    if (!result) return;
    ctx.flash(result.ok ? 'Diagnostics copied to the clipboard.' : result.error, result.ok ? 'ok' : 'bad');
  }

  // -- lifecycle -----------------------------------------------------------

  renderChecks();
  renderSelftest();
  renderEnv();

  return {
    el,
    title: 'Diagnostics',
    update() {
      renderSelftest(false);
      renderEnv();
    },
    destroy() {
      disposed = true;
    },
  };
}
