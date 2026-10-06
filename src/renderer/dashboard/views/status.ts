/**
 * Status pane: connection health, live threads, sessions, problems.
 *
 * The structure is built once and only the dynamic sub-containers are patched.
 * A status push can arrive several times a second while a turn runs, and
 * rebuilding whole tables at that rate would drop hover states and make the row
 * buttons unclickable.
 *
 * Active threads and Sessions overlap on purpose. Active threads is the LIVE
 * view, pushed several times a second with busy/queued/current-activity and the
 * Cancel and Reset buttons; Sessions is the HISTORICAL one, a page at a time
 * over every thread the database has ever held. The overlap is what makes the
 * Running pill on a session row possible.
 */

import type {
  ActiveThread,
  DaemonStatus,
  ProjectConfig,
  SessionPage,
  SessionRow,
  SetupCheckResult,
  TurnEvent,
} from '../../../shared/contract.ts';
import {
  button,
  buttonGroup,
  card,
  chip,
  confirmButton,
  dataTable,
  elapsedTime,
  emptyState,
  pill,
  relativeTime,
  select,
  spacer,
  spinner,
  switchControl,
  td,
  tdNum,
  tr,
  type PillKind,
} from '../components.ts';
import { Disposers, fill, h, holdsFocus, on, setVisible, type Child } from '../dom.ts';
import { plural, truncate } from '../format.ts';
import { allProblems, type Problem } from '../state.ts';
import { attempt, type Ctx, type View } from '../types.ts';

/** One page of sessions. Small enough that the whole page fits without scrolling. */
const SESSION_PAGE = 20;
/** A burst of finished turns should cause one refetch, not one per turn. */
const REFRESH_DEBOUNCE_MS = 800;

export function createStatusView(ctx: Ctx): View {
  const disposers = new Disposers();

  // -- connection ----------------------------------------------------------
  const connectionBody = h('div', { class: 'stack' });
  const verifyClaude = button('Verify Claude auth', () => void runClaudeCheck(), { variant: 'ghost' });
  const connection = card('Connection', verifyClaude);
  connection.body.appendChild(connectionBody);
  let claudeCheck: SetupCheckResult | null = null;
  let claudeChecking = false;

  // -- active threads ------------------------------------------------------
  // Five columns, not seven. The operator and the turn count ride under the
  // project name, because a row you have to scroll sideways to reach the
  // buttons of is not a glanceable table.
  const threadsTable = dataTable(
    ['Thread', 'State', 'Activity', 'Elapsed', ''],
    'No live threads. A Slack DM with a project alias on the first line starts one.',
  );
  const threadsCount = h('span', { class: 'field-hint' }, '');
  const threads = card('Active threads', threadsCount, { flush: true });
  threads.body.appendChild(threadsTable.el);
  let threadsDirty = false;
  disposers.add(
    on(threadsTable.el, 'focusout', () => {
      // A rebuild deferred because focus was inside the table can run now.
      if (threadsDirty) queueMicrotask(() => renderThreads());
    }),
  );

  // -- sessions ------------------------------------------------------------
  const FAILED_ONLY_TITLE = 'Sessions whose most recent turn ended in an error.';
  const projectFilter = select([{ value: '', label: 'All projects' }], '');
  const failedOnly = switchControl(false, () => void loadSessions({ reset: true }), 'Last turn failed');
  failedOnly.el.title = FAILED_ONLY_TITLE;
  const failedOnlyLabel = h('span', { class: 'field-hint', title: FAILED_ONLY_TITLE }, 'Last turn failed');
  const sessionsTable = dataTable(
    ['Session', 'Last turn', 'Turns', 'Last active', ''],
    'No sessions yet. A Slack DM with a project alias on the first line starts one.',
  );
  const sessionsBusy = spinner('Loading sessions');
  setVisible(sessionsBusy, false);
  const sessions = card(
    'Sessions',
    h(
      'div',
      { class: 'row' },
      sessionsBusy,
      projectFilter,
      failedOnlyLabel,
      failedOnly.el,
      button('Refresh', () => void loadSessions(), { variant: 'ghost' }),
    ),
    { flush: true },
  );
  sessions.body.appendChild(sessionsTable.el);
  // A filter change starts over at page 1. Page 4 of "All projects" is an empty
  // table once the filter leaves only two pages.
  disposers.add(on(projectFilter, 'change', () => void loadSessions({ reset: true })));
  disposers.add(on(failedOnlyLabel, 'click', () => failedOnly.el.click()));
  let projectFilterOptions = '';

  // The paging controls are built ONCE and only patched, never refilled. They
  // sit outside the table so a row rebuild cannot touch them, and keeping their
  // identity means clicking Next does not destroy the button under the cursor.
  const sessionsRange = h('span', { class: 'field-hint' }, '');
  const previousPage = button('Previous', () => void goToPage(-1), { variant: 'ghost', small: true });
  const nextPage = button('Next', () => void goToPage(1), { variant: 'ghost', small: true });
  fill(sessions.footer, sessionsRange, spacer(), buttonGroup(previousPage, nextPage));
  setVisible(sessions.footer, false);

  let sessionsDirty = false;
  disposers.add(
    on(sessionsTable.el, 'focusout', () => {
      // A rebuild deferred because focus was inside the table can run now.
      if (sessionsDirty) queueMicrotask(() => renderSessions());
    }),
  );

  // -- problems ------------------------------------------------------------
  const problemsBody = h('div', { class: 'stack' });
  const problems = card(
    'Problems',
    button('Clear resolved', () => ctx.store.clearIncidents(), { variant: 'ghost', title: 'Removes past incidents. Live faults stay listed.' }),
  );
  problems.body.appendChild(problemsBody);

  const el = h('div', { class: 'stack' }, connection.el, threads.el, sessions.el, problems.el);

  // -- data ----------------------------------------------------------------

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  // Paging state lives in the closure, not in the DOM, so a table rebuild can
  // never lose the page the operator is on.
  let sessionOffset = 0;
  let sessionTotal = 0;
  let sessionRows: SessionRow[] = [];

  async function loadSessions(opts: { reset?: boolean } = {}): Promise<void> {
    if (opts.reset) sessionOffset = 0;
    const failed = failedOnly.el.getAttribute('aria-checked') === 'true';
    const projectId = projectFilter.value;
    setVisible(sessionsBusy, true);
    const page = await attempt<SessionPage>(
      ctx.api.listSessions({
        limit: SESSION_PAGE,
        offset: sessionOffset,
        failedOnly: failed || undefined,
        projectId: projectId || undefined,
      }),
      { rows: [], total: 0, offset: sessionOffset, limit: SESSION_PAGE },
      (message) => ctx.flash(`Could not read session history: ${message}`, 'bad'),
    );
    if (disposed) return;
    setVisible(sessionsBusy, false);

    // The page fell off the end, which happens when retention pruned rows while
    // this pane sat open. Step back to page 1 rather than show an empty table
    // over a non-zero total. Only ever recurses once, since offset is now 0.
    if (page.rows.length === 0 && page.total > 0 && sessionOffset > 0) {
      sessionOffset = 0;
      void loadSessions();
      return;
    }

    sessionRows = page.rows;
    sessionTotal = page.total;
    sessionOffset = page.offset;
    renderSessions();
  }

  function goToPage(direction: -1 | 1): void {
    const next = sessionOffset + direction * SESSION_PAGE;
    if (next < 0 || next >= sessionTotal) return;
    sessionOffset = next;
    void loadSessions();
  }

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      // Deliberately NOT a reset: jumping the operator back to page 1 because
      // an unrelated thread finished a turn is worse than a slightly stale page.
      void loadSessions();
    }, REFRESH_DEBOUNCE_MS);
  }

  async function runClaudeCheck(): Promise<void> {
    if (claudeChecking) return;
    claudeChecking = true;
    verifyClaude.disabled = true;
    renderConnection();
    const result = await attempt<SetupCheckResult | null>(ctx.api.runCheck('claudeAuth'), null, (message) =>
      ctx.flash(`Claude check failed: ${message}`, 'bad'),
    );
    claudeChecking = false;
    verifyClaude.disabled = false;
    if (disposed) return;
    claudeCheck = result;
    if (result) ctx.flash(result.ok ? 'Claude authentication is working.' : result.detail, result.ok ? 'ok' : 'bad');
    renderConnection();
  }

  // -- rendering -----------------------------------------------------------

  function renderConnection(): void {
    const status = ctx.store.get().status;
    if (!status) {
      fill(connectionBody, emptyState('Waiting for the service.'));
      return;
    }

    const slack = slackPill(status);
    const workspace = status.identity
      ? `${status.identity.botName} in ${status.identity.teamName}`
      : 'Workspace not identified yet';

    const claudeRow = claudeChecking
      ? statusRow(spinner('Checking Claude'), 'Claude', [h('span', { class: 'field-hint' }, 'Running the auth probe. It spawns the CLI, so give it a few seconds.')])
      : claudeCheck
        ? statusRow(
            pill(
              claudeCheck.ok ? 'ok' : claudeCheck.severity === 'warning' ? 'warn' : 'bad',
              claudeCheck.ok ? 'Authenticated' : 'Not authenticated',
            ),
            'Claude',
            [h('span', { class: 'field-hint' }, claudeCheck.detail)],
            h('span', { class: 'field-hint' }, 'checked ', relativeTime(claudeCheck.ranAt)),
          )
        : statusRow(pill('idle', 'Not verified'), 'Claude', [
            h(
              'span',
              { class: 'field-hint' },
              status.claudeExecutablePath ? shortPath(status.claudeExecutablePath) : 'Using the SDK default binary.',
            ),
          ]);

    const resolved = status.allowlist.resolved;
    const unresolved = status.allowlist.unresolved;
    const operatorKind: PillKind = resolved.length === 0 ? 'bad' : unresolved.length > 0 ? 'warn' : 'ok';

    fill(
      connectionBody,
      statusRow(
        pill(slack.kind, slack.label),
        'Slack',
        [h('span', { class: 'field-hint' }, workspace), status.detail ? h('span', { class: 'field-hint' }, status.detail) : null],
        h('span', { class: 'field-hint' }, 'since ', relativeTime(status.since)),
      ),
      h('div', { class: 'hairline' }),
      claudeRow,
      h('div', { class: 'hairline' }),
      statusRow(
        pill(operatorKind, resolved.length === 0 ? 'Nobody' : plural(resolved.length, 'operator')),
        'Operators',
        [h('div', { class: 'row row-tight wrap' }, ...resolved.map((user) => chip(user.name, 'ok')), ...unresolved.map((entry) => chip(entry, 'bad')))],
        unresolved.length > 0 ? h('span', { class: 'field-hint' }, `${unresolved.length} did not resolve`) : null,
      ),
      h('div', { class: 'hairline' }),
      h(
        'div',
        { class: 'row spread' },
        h('span', { class: 'field-hint' }, 'Last Slack event ', relativeTime(status.lastEventAt)),
        h(
          'span',
          { class: 'field-hint' },
          'Last catch-up ',
          relativeTime(status.lastCatchupAt),
          status.lastCatchupReplayed !== undefined ? `, replayed ${plural(status.lastCatchupReplayed, 'message')}` : '',
        ),
      ),
    );
  }

  function renderThreads(): void {
    const state = ctx.store.get();
    const status = state.status;
    const list = status?.activeThreads ?? [];
    threadsCount.textContent = list.length === 0 ? '' : plural(list.length, 'thread');

    if (!status) {
      threadsTable.setRows([]);
      return;
    }

    // Rebuilding while focus sits on a row button would steal that focus, so
    // the rebuild waits for focus to leave instead.
    if (holdsFocus(threadsTable.el)) {
      threadsDirty = true;
      return;
    }
    threadsDirty = false;

    const projects = state.config?.projects ?? [];
    threadsTable.setRows(list.map((thread) => threadRow(thread, status, projects)));
  }

  function threadRow(thread: ActiveThread, status: DaemonStatus, projects: ProjectConfig[]): HTMLTableRowElement {
    const project = projects.find((p) => p.id === thread.projectId);
    const stateCell = h(
      'div',
      { class: 'stack stack-tight' },
      thread.busy ? pill('warn', 'Running') : pill('idle', 'Idle'),
      thread.queued > 0 ? chip(`${thread.queued} queued`, 'pending') : null,
    );

    const openInSlack = slackButton(ctx, status, thread.channel, thread.threadTs);
    const reveal = folderButton(ctx, project?.dir);

    const reset = confirmButton('Reset', 'Confirm reset', () => {
      void ctx.api.resetThread(thread.key).then((result) => {
        ctx.flash(result.ok ? 'Thread reset. The next message starts a fresh session.' : result.error, result.ok ? 'ok' : 'bad');
      });
    });
    reset.title = 'Forget the Claude session id so the next message starts fresh.';

    const cancel = button(
      'Cancel',
      () => {
        void ctx.api.cancelQueued(thread.key).then((result) => {
          if (!result.ok) {
            ctx.flash(result.error, 'bad');
            return;
          }
          ctx.flash(`Dropped ${plural(result.value.dropped, 'queued message')}.`);
        });
      },
      {
        variant: 'ghost',
        small: true,
        disabled: thread.queued === 0,
        title: 'Drops messages waiting behind the running turn. The running turn is never interrupted.',
      },
    );

    const who = thread.slackUserName ?? thread.slackUserId;
    return tr(
      td(
        h(
          'div',
          { class: 'stack stack-tight' },
          h(
            'div',
            { class: 'row row-tight' },
            project?.name ?? thread.projectName ?? h('span', { class: 'faint' }, 'unbound'),
            thread.alias ? chip(thread.alias) : null,
          ),
          h('span', { class: 'faint truncate', title: `${who}, ${plural(thread.turns, 'turn')} so far` }, who),
        ),
      ),
      td(stateCell),
      td(h('span', { class: 'truncate' }, thread.currentActivity ? truncate(thread.currentActivity, 32) : '-')),
      tdNum(thread.busy && thread.turnStartedAt ? elapsedTime(thread.turnStartedAt) : relativeTime(thread.lastActiveAt)),
      td(h('div', { class: 'row-actions' }, openInSlack, reveal, cancel, reset)),
    );
  }

  function renderSessions(): void {
    // Same guard as the threads table: rebuilding while focus sits on a row
    // button would steal that focus, and here the refetch lands 800ms after a
    // turn ends with no regard for where the operator's hands are.
    if (holdsFocus(sessionsTable.el)) {
      sessionsDirty = true;
      return;
    }
    sessionsDirty = false;

    const state = ctx.store.get();
    const status = state.status;
    const projects = state.config?.projects ?? [];
    // The live view's own list, read as a set, is what lets a historical row
    // say "Running".
    const running = new Set((status?.activeThreads ?? []).filter((thread) => thread.busy).map((thread) => thread.key));
    sessionsTable.setRows(sessionRows.map((row) => sessionTableRow(row, projects, running, status)));
    renderSessionsFooter();
  }

  function renderSessionsFooter(): void {
    const shown = sessionRows.length;
    const last = sessionOffset + shown;
    sessionsRange.textContent = shown === 0 ? '' : `Showing ${sessionOffset + 1}-${last} of ${sessionTotal}`;
    previousPage.disabled = sessionOffset === 0;
    nextPage.disabled = last >= sessionTotal;
    // Nothing to page through means nothing to say, and an empty footer
    // collapses.
    setVisible(sessions.footer, sessionTotal > 0);
  }

  function sessionTableRow(
    row: SessionRow,
    projects: ProjectConfig[],
    running: Set<string>,
    status: DaemonStatus | null,
  ): HTMLTableRowElement {
    const project = projects.find((p) => p.id === row.projectId);
    const who = operatorName(status, row.slackUserId);
    const hasSession = Boolean(row.sessionId);

    const open = button(
      'Open',
      () => {
        void ctx.api.openSessionInTerminal(row.key).then((result) => {
          if (!result.ok) ctx.flash(result.error, 'bad');
          else ctx.flash('Opening a terminal in the project directory.');
        });
      },
      {
        variant: 'ghost',
        small: true,
        disabled: !hasSession,
        // The tooltip says plainly that this leaves two clients on one
        // transcript. That is inherent to resuming a session the Slack thread
        // will also resume, and hiding it would be worse than saying it.
        title: hasSession
          ? 'Runs claude --resume in a terminal, in the project directory. The Slack thread keeps its own session; both continue the same conversation.'
          : 'This thread has not run a turn yet, so there is no session to open.',
      },
    );

    // Two clicks, in place, the same as Reset on the live table: a dashboard
    // this small does not need a modal to make a delete deliberate.
    const remove = confirmButton(
      'Remove',
      'Confirm remove',
      () => {
        // Focus has to leave the table BEFORE the reload lands, or renderSessions
        // sees holdsFocus() and defers the rebuild, and the row the operator just
        // deleted sits there until they click somewhere else.
        remove.blur();
        void ctx.api.removeSession(row.key).then((result) => {
          if (!result.ok) {
            ctx.flash(result.error, 'bad');
            return;
          }
          ctx.flash(`Removed the session record and ${plural(result.value.turns, 'turn')}.`);
          // Straight back through loadSessions rather than splicing the row out
          // here: removing the last row of the last page leaves the offset past
          // the end, and loadSessions already steps an empty page back to 1.
          void loadSessions();
        });
      },
      { small: true },
    );
    // Says the scope plainly, because it is the one thing an operator could
    // misread: this deletes the app's record, not the conversation.
    remove.title =
      'Deletes what this app records about the thread: its row and its turns. The Claude Code transcript under ~/.claude is untouched, so claude --resume on this session id still works. The Slack thread also stops being bound, so your next reply there has to name a project again. Refused while a turn is running.';

    return tr(
      td(
        h(
          'div',
          { class: 'stack stack-tight' },
          h(
            'div',
            { class: 'row row-tight' },
            project?.name ?? h('span', { class: 'faint' }, 'unbound'),
            row.alias ? chip(row.alias) : null,
            running.has(row.key) ? pill('warn', 'Running') : null,
          ),
          h(
            'div',
            { class: 'row row-tight' },
            h('span', { class: 'faint truncate', title: who }, who),
            row.sessionId
              ? h('span', { class: 'mono faint', title: row.sessionId }, row.sessionId.slice(0, 8))
              : h('span', { class: 'faint' }, 'no session yet'),
          ),
        ),
      ),
      td(
        row.lastTurn
          ? h(
              'div',
              { class: 'row row-tight' },
              row.lastTurn.failed ? pill('bad', row.lastTurn.subtype) : null,
              h('span', { class: 'truncate' }, row.lastTurn.preview ? truncate(row.lastTurn.preview, 56) : '-'),
            )
          : h('span', { class: 'faint' }, '-'),
      ),
      tdNum(String(row.turns)),
      tdNum(relativeTime(row.lastActiveAt)),
      td(
        h(
          'div',
          { class: 'row-actions' },
          open,
          slackButton(ctx, status, row.channel, row.threadTs),
          // The thread's own recorded cwd, not the project's current dir: a
          // project that moved should still reveal where this session ran.
          folderButton(ctx, row.cwd || undefined),
          remove,
        ),
      ),
    );
  }

  function renderProblems(): void {
    const list = allProblems(ctx.store.get());
    if (list.length === 0) {
      fill(problemsBody, h('div', { class: 'row' }, pill('ok', 'All clear'), h('span', {}, 'No problems reported.')));
      return;
    }
    fill(
      problemsBody,
      ...list.flatMap((problem, index) => [index > 0 ? h('div', { class: 'hairline' }) : null, problemRow(problem)]),
    );
  }

  function problemRow(problem: Problem): HTMLElement {
    return h(
      'div',
      { class: 'row spread' },
      h(
        'div',
        { class: 'row' },
        pill(problem.severity === 'bad' ? 'bad' : 'warn', problem.severity === 'bad' ? 'Error' : 'Warning'),
        h(
          'div',
          { class: 'stack' },
          h('strong', {}, problem.count > 1 ? `${problem.title} (x${problem.count})` : problem.title),
          problem.detail ? h('span', { class: 'field-hint' }, problem.detail) : null,
          problem.hint ? h('span', { class: 'field-hint' }, problem.hint) : null,
        ),
      ),
      h('span', { class: 'faint' }, relativeTime(problem.at)),
    );
  }

  function syncProjectFilter(): void {
    const projects = ctx.store.get().config?.projects ?? [];
    const signature = projects.map((p) => `${p.id}:${p.name}`).join('|');
    if (signature === projectFilterOptions) return;
    projectFilterOptions = signature;
    const current = projectFilter.value;
    fill(
      projectFilter,
      h('option', { value: '' }, 'All projects'),
      ...projects.map((p) => h('option', { value: p.id }, p.name)),
    );
    projectFilter.value = projects.some((p) => p.id === current) ? current : '';
  }

  // -- lifecycle -----------------------------------------------------------

  function update(): void {
    syncProjectFilter();
    renderConnection();
    renderThreads();
    // Repainted from the rows already in hand, never refetched: this runs on
    // every status push, and it is what keeps the Running pill honest.
    renderSessions();
    renderProblems();
  }

  update();
  void loadSessions();

  return {
    el,
    title: 'Status',
    update,
    onTurn(event: TurnEvent) {
      if (event.type === 'turn:ended') scheduleRefresh();
    },
    destroy() {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      disposers.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Both tables offer the same two row buttons, so they are built here once. The
 * Active threads row and the Sessions row are otherwise unrelated shapes, which
 * is why these take the four values they need rather than a row object.
 */
function slackButton(ctx: Ctx, status: DaemonStatus | null, channel: string, threadTs: string): HTMLButtonElement {
  return button(
    'Slack',
    () => {
      const team = status?.identity?.teamId;
      if (!team) {
        ctx.flash('The workspace id is not known yet, so the deep link cannot be built.', 'bad');
        return;
      }
      void ctx.api.openExternal(`slack://channel?team=${team}&id=${channel}&message=${threadTs}`);
    },
    { variant: 'ghost', small: true, title: 'Open this thread in Slack' },
  );
}

function folderButton(ctx: Ctx, dir: string | undefined): HTMLButtonElement {
  return button(
    'Folder',
    () => {
      if (dir) void ctx.api.revealPath(dir);
    },
    { variant: 'ghost', small: true, disabled: !dir, title: dir ?? 'This thread is not bound to a project.' },
  );
}

/**
 * A session row carries only the Slack user id, so the display name is looked
 * up in the resolved allowlist and then in the live threads. Falling back to the
 * raw id is fine: it is still the truth, just less readable.
 */
function operatorName(status: DaemonStatus | null, userId: string): string {
  const allowed = status?.allowlist.resolved.find((user) => user.id === userId);
  if (allowed) return allowed.name;
  const live = status?.activeThreads.find((thread) => thread.slackUserId === userId);
  return live?.slackUserName ?? userId;
}

/**
 * One line of the always-relevant status block: a pill, what it is about, the
 * supporting detail, and a timestamp pushed to the right. Three of these read
 * far better in a narrow window than three columns that wrap unpredictably.
 */
function statusRow(badge: HTMLElement, caption: string, details: Child[], trailing?: Child): HTMLElement {
  return h(
    'div',
    { class: 'row spread' },
    h('div', { class: 'row' }, badge, h('strong', {}, caption), ...details),
    trailing ?? null,
  );
}

function slackPill(status: DaemonStatus): { kind: PillKind; label: string } {
  switch (status.state) {
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
      // Stopped is a choice the operator made, not a fault, so it is never red.
      return { kind: 'idle', label: 'Stopped by you' };
  }
}

function shortPath(path: string): string {
  const parts = path.split('/');
  return parts.length <= 4 ? path : `…/${parts.slice(-3).join('/')}`;
}
