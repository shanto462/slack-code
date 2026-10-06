/**
 * Logs pane: a live tail with filters.
 *
 * Two sources, deliberately. With no filter set the pane shows the in-memory
 * ring buffer and appends new lines as they arrive, which is instant and costs
 * nothing. The moment a filter is set it queries SQLite instead, because the
 * ring only holds the last couple of thousand lines and the interesting line is
 * usually older than that.
 *
 * Every line is already redacted at the source, in core's logger, so nothing
 * here has to think about secrets.
 */

import type { LogLevel, LogLine, LogQuery, LogRow, Result } from '../../../shared/contract.ts';
import { button, card, emptyState, select, spinner, switchControl, textInput } from '../components.ts';
import { Disposers, fill, h, on, setVisible } from '../dom.ts';
import { formatClock } from '../format.ts';
import { attempt, type Ctx, type View } from '../types.ts';

/** Lines kept in the DOM. Beyond this the oldest are dropped from the top. */
const MAX_ROWS = 1500;
const BACKFILL = 500;
const QUERY_LIMIT = 1000;
const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function createLogsView(ctx: Ctx): View {
  const disposers = new Disposers();

  const levelSelect = select(
    [{ value: '', label: 'All levels' }, ...LEVELS.map((level) => ({ value: level, label: level }))],
    '',
  );
  const scopeInput = textInput('', { mono: true, placeholder: 'scope' });
  const searchInput = textInput('', { placeholder: 'search text' });
  // Switching Live back on reloads, so the lines missed while it was off are
  // not silently absent from the tail.
  const live = switchControl(
    true,
    (enabled) => {
      if (enabled) void reload();
    },
    'Live tail',
  );
  const liveLabel = h('span', { class: 'field-hint' }, 'Live');
  const busy = spinner('Loading logs');
  setVisible(busy, false);

  const list = h('div', { class: 'stack stack-tight' });

  // The filters live in the PANE header, which sits outside .detail-body and so
  // never scrolls away. A live tail is pinned to the bottom of a very long list,
  // so filters inside the card would be permanently off screen.
  //
  // The row must not wrap: `.input` is `inline-size: 100%` by design, so in a
  // wrapping row each control claims its own line. Unwrapped they shrink to fit
  // and the buttons, which never shrink, keep their labels.
  const actions = h(
    'div',
    { class: 'row' },
    busy,
    levelSelect,
    scopeInput,
    searchInput,
    liveLabel,
    live.el,
    button(
      'Clear',
      () => {
        levelSelect.value = '';
        scopeInput.value = '';
        searchInput.value = '';
        void reload();
      },
      { variant: 'ghost', title: 'Clear every filter and go back to the live tail.' },
    ),
    button('Copy', () => void copyDiagnostics(), { variant: 'ghost', title: 'Copy the check results and the last redacted log lines.' }),
  );
  const parts = card(undefined, undefined, { flush: true });
  parts.body.appendChild(list);

  const el = h('div', { class: 'stack' }, parts.el);

  let disposed = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  disposers.add(on(levelSelect, 'change', () => void reload()));
  disposers.add(on(liveLabel, 'click', () => live.el.click()));
  for (const input of [scopeInput, searchInput]) {
    disposers.add(
      on(input, 'input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => void reload(), 250);
      }),
    );
  }

  // -- filtering -----------------------------------------------------------

  function currentQuery(): LogQuery {
    const query: LogQuery = { limit: QUERY_LIMIT };
    const level = levelSelect.value as LogLevel | '';
    if (level) query.level = level;
    const scope = scopeInput.value.trim();
    if (scope) query.scope = scope;
    const search = searchInput.value.trim();
    if (search) query.search = search;
    return query;
  }

  function isFiltered(): boolean {
    return Boolean(levelSelect.value || scopeInput.value.trim() || searchInput.value.trim());
  }

  /** The same predicate the SQLite query applies, for lines arriving live. */
  function passes(line: LogLine): boolean {
    const level = levelSelect.value as LogLevel | '';
    if (level && line.level !== level) return false;
    const scope = scopeInput.value.trim().toLowerCase();
    if (scope && !line.scope.toLowerCase().includes(scope)) return false;
    const search = searchInput.value.trim().toLowerCase();
    if (search && !line.message.toLowerCase().includes(search)) return false;
    return true;
  }

  // -- loading -------------------------------------------------------------

  async function reload(): Promise<void> {
    setVisible(busy, true);
    const filtered = isFiltered();
    const lines: LogLine[] = filtered
      ? await attempt<LogRow[]>(ctx.api.queryLogs(currentQuery()), [], (m) => ctx.flash(m, 'bad'))
      : await attempt<LogLine[]>(ctx.api.logTail(BACKFILL), [], (m) => ctx.flash(m, 'bad'));
    if (disposed) return;
    setVisible(busy, false);

    // Both sources are read newest-first; a tail reads oldest at the top.
    const ordered = [...lines].sort((a, b) => a.at - b.at);
    if (ordered.length === 0) {
      fill(
        list,
        emptyState(
          filtered ? 'No log lines match that filter.' : 'No log lines yet.',
          filtered ? 'Clear the filters to see the live tail again.' : 'Start the service and send a Slack message.',
        ),
      );
      return;
    }
    fill(list, ...ordered.map(logRow));
    scrollToLatest();
  }

  async function copyDiagnostics(): Promise<void> {
    const result = await attempt<Result<string> | null>(ctx.api.copyDiagnostics(), null, (m) => ctx.flash(m, 'bad'));
    if (!result) return;
    ctx.flash(result.ok ? 'Diagnostics copied to the clipboard.' : result.error, result.ok ? 'ok' : 'bad');
  }

  // -- rendering -----------------------------------------------------------

  function logRow(line: LogLine): HTMLElement {
    return h(
      'div',
      { class: `log-line log-level-${line.level}` },
      h('span', { class: 'log-time' }, formatClock(line.at)),
      h('span', { class: 'log-scope', title: line.scope }, line.scope),
      h('span', { class: 'log-message' }, line.message),
    );
  }

  function scrollToLatest(): void {
    const last = list.lastElementChild;
    if (last instanceof HTMLElement) last.scrollIntoView({ block: 'nearest' });
  }

  function append(line: LogLine): void {
    // A filtered view is a database query, not a tail, so live lines would
    // interleave with older results and lie about what matched.
    if (isFiltered()) return;
    if (live.el.getAttribute('aria-checked') !== 'true') return;
    if (!passes(line)) return;

    if (list.firstElementChild?.classList.contains('empty-state')) fill(list);
    list.appendChild(logRow(line));
    while (list.childElementCount > MAX_ROWS) list.removeChild(list.firstChild!);
    scrollToLatest();
  }

  // -- lifecycle -----------------------------------------------------------

  void reload();

  return {
    el,
    title: 'Logs',
    actions,
    update() {
      // Log content comes from its own subscription, not from shared state.
    },
    onLog(line: LogLine) {
      append(line);
    },
    destroy() {
      disposed = true;
      if (searchTimer) clearTimeout(searchTimer);
      disposers.dispose();
    },
  };
}
