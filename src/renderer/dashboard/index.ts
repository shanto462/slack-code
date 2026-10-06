/**
 * The dashboard shell: title bar, sidebar, and the five panes.
 *
 * `mountDashboard` renders into the element it is given and returns the
 * teardown, matching `mountSetup` so the renderer shell can swap between them
 * without knowing anything about either.
 *
 * Every IPC subscription is owned here and fanned out to the active pane. A
 * pane never subscribes to main directly, so unmounting one cannot leave a
 * listener behind.
 */

import type {
  DaemonStatus,
  LogLine,
  RendererView,
  Result,
  ServiceState,
  StoredConfig,
  TurnEvent,
} from '../../shared/contract.ts';
import { button, pill, startTicker, type PillKind } from './components.ts';
import { Disposers, fill, h, on } from './dom.ts';
import { Store, problemFromLog, problemFromTurn } from './state.ts';
import { attempt, type Ctx, type View } from './types.ts';
import { createDiagnosticsView } from './views/diagnostics.ts';
import { createLogsView } from './views/logs.ts';
import { createProjectsView } from './views/projects.ts';
import { createSettingsView } from './views/settings.ts';
import { createStatusView } from './views/status.ts';

/**
 * A status push can arrive several times a second while a turn is running.
 * Repainting at that rate drops hover states and steals focus, so updates are
 * throttled with a leading edge and a trailing catch-up.
 */
const UPDATE_THROTTLE_MS = 400;
const FLASH_MS = 5000;

interface NavEntry {
  view: RendererView;
  label: string;
  hint: string;
}

const NAV: NavEntry[] = [
  { view: 'dashboard', label: 'Status', hint: 'Connection, live threads, sessions and problems' },
  { view: 'projects', label: 'Projects', hint: 'Directories and their aliases' },
  { view: 'logs', label: 'Logs', hint: 'Live tail and search' },
  { view: 'diagnostics', label: 'Diagnostics', hint: 'Checks and where things live' },
  { view: 'settings', label: 'Settings', hint: 'Operators, tokens, tuning and startup' },
];

export function mountDashboard(root: HTMLElement, initialView: RendererView = 'dashboard'): () => void {
  const api = window.api;
  const store = new Store();
  const disposers = new Disposers();

  // -- chrome --------------------------------------------------------------

  const statePill = pill('idle', 'Stopped');
  const stateDetail = h('span', { class: 'field-hint' }, '');
  const serviceButton = button('Start', () => void toggleService(), { variant: 'primary' });
  const restartButton = button('Restart', () => void restartService(), { variant: 'ghost' });

  const titlebar = h(
    'header',
    { class: 'titlebar spread' },
    h('div', { class: 'row' }, h('strong', {}, 'slack-code'), statePill, stateDetail),
    h('div', { class: 'titlebar-actions row' }, restartButton, serviceButton),
  );

  const navItems = NAV.map((entry) =>
    h(
      'button',
      { type: 'button', class: 'nav-item', 'data-view': entry.view, title: entry.hint },
      entry.label,
    ),
  );
  const workspaceLine = h('span', { class: 'field-hint' }, '');
  const sidebar = h(
    'nav',
    { class: 'sidebar stack', 'aria-label': 'Sections' },
    h('div', { class: 'sidebar-nav stack' }, ...navItems),
    workspaceLine,
  );

  const detailTitle = h('h1', {}, 'Status');
  // `truncate` on the element that holds the text, not on a wrapper, and it
  // is re-applied by flash() because that rewrites className.
  const flashEl = h('span', { class: 'field-hint truncate' }, '');
  // `grow` so the pane's own controls get the width left over after the title,
  // and no `wrap`: `.input` is `inline-size: 100%`, so a wrapping row of them
  // gives every control its own line.
  const detailActions = h('div', { class: 'row grow' });
  const detailHeader = h(
    'div',
    { class: 'detail-header' },
    detailTitle,
    flashEl,
    detailActions,
  );
  const detailBody = h('div', { class: 'detail-body' });
  const detail = h('main', { class: 'detail' }, detailHeader, detailBody);

  const shell = h('div', { class: 'app-shell' }, titlebar, sidebar, detail);
  fill(root, shell);

  // -- flash ---------------------------------------------------------------

  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function flash(message: string, kind: 'ok' | 'bad' = 'ok'): void {
    flashEl.textContent = message;
    flashEl.className = kind === 'bad' ? 'field-error truncate' : 'field-hint truncate';
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashEl.textContent = '';
    }, FLASH_MS);
  }

  // -- data ----------------------------------------------------------------

  async function refreshStatus(): Promise<void> {
    const status = await attempt<DaemonStatus | null>(api.getStatus(), null);
    if (status) store.patch({ status });
  }

  async function refreshConfig(): Promise<void> {
    const config = await attempt<StoredConfig | null>(api.getConfig(), null);
    if (config) store.patch({ config });
  }

  async function toggleService(): Promise<void> {
    const state = store.get().status?.state ?? 'stopped';
    const running = state !== 'stopped' && state !== 'error';
    store.patch({ serviceBusy: true });
    const result = await attempt<Result<null> | null>(running ? api.stopService() : api.startService(), null, (m) =>
      flash(m, 'bad'),
    );
    store.patch({ serviceBusy: false });
    if (result && !result.ok) flash(result.error, 'bad');
    else if (result) flash(running ? 'Stopped. Slack messages are not being answered.' : 'Started.');
    await refreshStatus();
  }

  async function restartService(): Promise<void> {
    store.patch({ serviceBusy: true });
    const result = await attempt<Result<null> | null>(api.restartService(), null, (m) => flash(m, 'bad'));
    store.patch({ serviceBusy: false });
    if (result && !result.ok) flash(result.error, 'bad');
    else if (result) flash('Restarted.');
    await refreshStatus();
  }

  /** Best-effort label for a thread mentioned by an event, for the problems feed. */
  function aliasFor(channel: string, threadTs: string): string {
    const status = store.get().status;
    const thread = status?.activeThreads.find((candidate) => candidate.channel === channel && candidate.threadTs === threadTs);
    return thread?.projectName ?? thread?.alias ?? `${channel}:${threadTs}`;
  }

  const ctx: Ctx = { api, store, flash, navigate: setView, refreshConfig, refreshStatus };

  // -- views ---------------------------------------------------------------

  let current: View | null = null;
  let currentView: RendererView = 'dashboard';

  function createView(view: RendererView): View {
    switch (view) {
      case 'projects':
        return createProjectsView(ctx);
      case 'logs':
        return createLogsView(ctx);
      case 'diagnostics':
        return createDiagnosticsView(ctx);
      case 'settings':
        return createSettingsView(ctx);
      default:
        return createStatusView(ctx);
    }
  }

  function setView(view: RendererView): void {
    // 'setup' belongs to the wizard, which the renderer shell mounts instead
    // of this whole module, so it is not a destination from in here.
    const target: RendererView = view === 'setup' ? 'dashboard' : view;
    if (current && target === currentView) return;
    current?.destroy();
    currentView = target;
    current = createView(target);
    detailTitle.textContent = current.title;
    fill(detailActions, current.actions ?? null);
    fill(detailBody, current.el);
    detailBody.scrollTop = 0;
    for (const item of navItems) {
      const selected = item.dataset.view === target;
      if (selected) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    store.patch({ view: target });
  }

  for (const item of navItems) {
    disposers.add(
      on(item, 'click', () => {
        const view = item.dataset.view as RendererView | undefined;
        if (view) setView(view);
      }),
    );
  }

  // -- chrome updates ------------------------------------------------------

  function paintChrome(): void {
    const state = store.get();
    const status = state.status;
    const serviceState: ServiceState = status?.state ?? 'stopped';
    const look = chromeFor(serviceState);
    statePill.className = `pill pill-${look.kind}`;
    statePill.textContent = look.label;
    stateDetail.textContent = status?.detail ?? '';

    const running = serviceState !== 'stopped' && serviceState !== 'error';
    serviceButton.textContent = state.serviceBusy ? 'Working…' : running ? 'Stop' : 'Start';
    // Deliberately still enabled while 'starting': a start that hangs is
    // exactly when the operator needs to be able to stop it.
    serviceButton.disabled = state.serviceBusy;
    restartButton.disabled = state.serviceBusy || !running;

    workspaceLine.textContent = status?.identity ? `${status.identity.botName} · ${status.identity.teamName}` : '';
  }

  // -- throttled repaint ---------------------------------------------------

  let throttleTimer: ReturnType<typeof setTimeout> | undefined;
  let trailing = false;

  function runUpdate(): void {
    paintChrome();
    current?.update();
  }

  function scheduleUpdate(): void {
    if (throttleTimer !== undefined) {
      trailing = true;
      return;
    }
    runUpdate();
    throttleTimer = setTimeout(() => {
      throttleTimer = undefined;
      if (trailing) {
        trailing = false;
        scheduleUpdate();
      }
    }, UPDATE_THROTTLE_MS);
  }

  disposers.add(store.subscribe(scheduleUpdate));

  // -- subscriptions -------------------------------------------------------

  disposers.add(api.onStatus((status: DaemonStatus) => store.patch({ status })));
  disposers.add(api.onConfig((config: StoredConfig) => store.patch({ config })));
  disposers.add(
    api.onTurn((event: TurnEvent) => {
      const problem = problemFromTurn(event, aliasFor);
      if (problem) store.addIncident(problem);
      current?.onTurn?.(event);
    }),
  );
  disposers.add(
    api.onLog((line: LogLine) => {
      const problem = problemFromLog(line);
      if (problem) store.addIncident(problem);
      current?.onLog?.(line);
    }),
  );
  disposers.add(api.onNavigate((view: RendererView) => setView(view)));

  // Cmd+1 to Cmd+5 jump between panes, the way a native utility app does.
  disposers.add(
    on(window, 'keydown', ((event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      const index = Number(event.key) - 1;
      const entry = NAV[index];
      if (!entry) return;
      event.preventDefault();
      setView(entry.view);
    }) as EventListener),
  );

  disposers.add(startTicker(shell));

  // -- start ---------------------------------------------------------------

  setView(initialView);
  paintChrome();
  void refreshStatus();
  void refreshConfig();

  return () => {
    if (flashTimer) clearTimeout(flashTimer);
    if (throttleTimer) clearTimeout(throttleTimer);
    current?.destroy();
    current = null;
    disposers.dispose();
    fill(root);
  };
}

function chromeFor(state: ServiceState): { kind: PillKind; label: string } {
  switch (state) {
    case 'connected':
      return { kind: 'ok', label: 'Connected' };
    case 'starting':
      return { kind: 'warn', label: 'Starting' };
    case 'reconnecting':
      return { kind: 'warn', label: 'Reconnecting' };
    case 'disconnected':
      return { kind: 'bad', label: 'Disconnected' };
    case 'error':
      return { kind: 'bad', label: 'Error' };
    case 'stopped':
    default:
      return { kind: 'idle', label: 'Stopped' };
  }
}
