/**
 * Settings pane: operators, tokens, agent defaults, routing, tuning, the app
 * itself and appearance.
 *
 * Settings save on change, as macOS System Settings does, rather than behind a
 * Save button. Text and number fields commit on blur or Enter, not on every
 * keystroke, so a half-typed value never reaches the service.
 */

import {
  DEFAULT_CONFIG,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  TUNING_RANGES,
  clampToRange,
  type AllowedUser,
  type AllowlistResolution,
  type DeepPartial,
  type EffortLevel,
  type LoginItemState,
  type PermissionMode,
  type Result,
  type SecretsStatus,
  type SetupCheckResult,
  type SlackWorkspaceUser,
  type StoredConfig,
  type ThemeMode,
  type ThemeState,
} from '../../../shared/contract.ts';
import {
  button,
  buttonGroup,
  card,
  chip,
  confirmButton,
  field,
  numberInput,
  pill,
  relativeTime,
  segmented,
  select,
  spinner,
  switchControl,
  switchField,
  textInput,
} from '../components.ts';
import { Disposers, fill, h, holdsFocus, on } from '../dom.ts';
import { attempt, type Ctx, type View } from '../types.ts';

export function createSettingsView(ctx: Ctx): View {
  const disposers = new Disposers();
  let sectionDisposers = new Disposers();
  const el = h('div', { class: 'stack' });

  let secrets: SecretsStatus | null = null;
  let loginItem: LoginItemState | null = null;
  let workspaceUsers: SlackWorkspaceUser[] | null = null;
  let loadingUsers = false;
  /** What the pane was last painted from, so an echo of our own save is a no-op. */
  let painted = '';
  let dirty = false;

  disposers.add(
    on(el, 'focusout', () => {
      if (dirty) queueMicrotask(() => render());
    }),
  );

  void (async () => {
    const [secretsResult, loginResult] = await Promise.all([
      attempt<SecretsStatus | null>(ctx.api.secretsStatus(), null),
      attempt<LoginItemState | null>(ctx.api.getLoginItem(), null),
    ]);
    secrets = secretsResult;
    loginItem = loginResult;
    render();
  })();

  // -- persistence ---------------------------------------------------------

  async function persist(patch: DeepPartial<StoredConfig>, note: string): Promise<void> {
    const result = await attempt<Result<StoredConfig> | null>(ctx.api.saveConfig(patch), null, (m) => ctx.flash(m, 'bad'));
    if (!result) return;
    if (!result.ok) {
      ctx.flash(result.error, 'bad');
      await ctx.refreshConfig();
      return;
    }
    ctx.store.patch({ config: result.value });
    ctx.flash(note);
  }

  // -- rendering -----------------------------------------------------------

  function render(): void {
    const config = ctx.store.get().config;
    if (!config) {
      fill(el, h('div', { class: 'card glass' }, h('div', { class: 'card-body' }, spinner('Loading settings'))));
      return;
    }
    const signature = JSON.stringify([config, secrets, loginItem, workspaceUsers?.length ?? null, loadingUsers]);
    if (signature === painted) return;
    if (holdsFocus(el)) {
      dirty = true;
      return;
    }
    dirty = false;
    painted = signature;

    sectionDisposers.dispose();
    sectionDisposers = new Disposers();

    fill(
      el,
      operatorsCard(config),
      tokensCard(),
      agentCard(config),
      routingCard(config),
      tuningCard(config),
      applicationCard(config),
      appearanceCard(config),
    );
  }

  /** Commit a text or number field on blur and on Enter, never per keystroke. */
  function commitOn(input: HTMLInputElement, commit: () => void): void {
    sectionDisposers.add(on(input, 'change', commit));
    sectionDisposers.add(
      on(input, 'keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          event.preventDefault();
          input.blur();
        }
      }),
    );
  }

  // -- operators -----------------------------------------------------------

  function operatorsCard(config: StoredConfig): HTMLElement {
    const parts = card(
      'Operators',
      h(
        'div',
        { class: 'row wrap' },
        button('Re-resolve', () => void reresolve(config), { variant: 'ghost', title: 'Look every entry up in Slack again.' }),
        button(
          workspaceUsers ? 'Reload people' : 'Pick from workspace',
          () => void loadWorkspaceUsers(),
          { variant: 'ghost', disabled: loadingUsers },
        ),
      ),
    );

    const allowed = config.slack.allowed;
    const rows =
      allowed.length === 0
        ? [h('div', { class: 'field-error' }, 'Nobody is allowed to drive the bot, so the service will refuse to start.')]
        : allowed.map((user) =>
            h(
              'div',
              { class: 'row spread' },
              h(
                'div',
                { class: 'row' },
                user.id ? chip(user.name ?? user.id, 'ok') : chip(user.entry, 'bad'),
                h('span', { class: 'field-hint' }, user.id ? `${user.entry} → ${user.id}` : 'did not resolve'),
                user.resolvedAt ? h('span', { class: 'field-hint' }, relativeTime(Date.parse(user.resolvedAt))) : null,
              ),
              confirmButton('Remove', 'Confirm', () => {
                const next = allowed.filter((candidate) => candidate.entry !== user.entry);
                void persist({ slack: { allowed: next } }, `Removed ${user.name ?? user.entry}.`);
              }),
            ),
          );

    const entryInput = textInput('', { mono: true, placeholder: 'U012ABC3DEF, @name, or an email' });
    const add = () => {
      const entry = entryInput.value.trim();
      if (!entry) return;
      if (allowed.some((candidate) => candidate.entry.toLowerCase() === entry.toLowerCase())) {
        ctx.flash('That entry is already on the list.', 'bad');
        return;
      }
      entryInput.value = '';
      void persist({ slack: { allowed: [...allowed, { entry }] } }, `Added ${entry}. Press Re-resolve to look it up.`);
    };
    sectionDisposers.add(
      on(entryInput, 'keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          event.preventDefault();
          add();
        }
      }),
    );

    const picker = workspaceUsers
      ? (() => {
          const candidates = workspaceUsers
            .filter((user) => !user.isBot && !user.deleted && !allowed.some((a) => a.id === user.id || a.entry === user.id))
            .sort((a, b) => (a.realName || a.name).localeCompare(b.realName || b.name));
          if (candidates.length === 0) return h('span', { class: 'field-hint' }, 'Everyone in the workspace is already listed.');
          const picked = select(
            candidates.map((user) => ({ value: user.id, label: `${user.realName || user.displayName || user.name} (${user.id})` })),
            candidates[0]!.id,
          );
          return h(
            'div',
            { class: 'row' },
            picked,
            button('Add person', () => {
              const user = candidates.find((candidate) => candidate.id === picked.value);
              if (!user) return;
              const next: AllowedUser[] = [
                ...allowed,
                {
                  entry: user.id,
                  id: user.id,
                  name: user.realName || user.displayName || user.name,
                  resolvedAt: new Date().toISOString(),
                },
              ];
              void persist({ slack: { allowed: next } }, `Added ${user.realName || user.name}.`);
            }),
          );
        })()
      : null;

    fill(
      parts.body,
      h('span', { class: 'field-hint' }, 'Only these Slack users can drive the bot. Everything from anyone else is ignored before it reaches the agent.'),
      ...rows,
      h('div', { class: 'hairline' }),
      field({
        label: 'Add by id, name or email',
        hint: 'A user id is the reliable form. Names and emails are looked up when you press Re-resolve.',
        control: h('div', { class: 'row' }, entryInput, button('Add', add)),
      }).el,
      loadingUsers ? spinner('Loading people') : null,
      picker,
    );
    return parts.el;
  }

  async function reresolve(config: StoredConfig): Promise<void> {
    const entries = config.slack.allowed.map((user) => user.entry);
    if (entries.length === 0) return;
    const result = await attempt<SetupCheckResult<AllowlistResolution> | null>(
      ctx.api.resolveAllowlist(entries),
      null,
      (m) => ctx.flash(m, 'bad'),
    );
    if (!result) return;
    const resolution = result.data;
    if (!resolution) {
      ctx.flash(result.detail, 'bad');
      return;
    }
    const merged = mergeAllowlist(entries, resolution);
    await persist(
      { slack: { allowed: merged } },
      resolution.unresolved.length === 0
        ? `Resolved all ${entries.length} operators.`
        : `${resolution.unresolved.length} entries still do not resolve.`,
    );
  }

  async function loadWorkspaceUsers(): Promise<void> {
    loadingUsers = true;
    painted = '';
    render();
    const result = await attempt<Result<SlackWorkspaceUser[]> | null>(ctx.api.listWorkspaceUsers(), null, (m) => ctx.flash(m, 'bad'));
    loadingUsers = false;
    if (result && result.ok) workspaceUsers = result.value;
    else if (result) ctx.flash(result.error, 'bad');
    painted = '';
    render();
  }

  // -- tokens --------------------------------------------------------------

  function tokensCard(): HTMLElement {
    const parts = card('Slack tokens');
    if (!secrets) {
      fill(parts.body, spinner('Reading the token store'));
      return parts.el;
    }

    const botInput = textInput('', { mono: true, placeholder: 'xoxb-…', type: 'password' });
    const appInput = textInput('', { mono: true, placeholder: 'xapp-…', type: 'password' });

    const saveTokens = button(
      'Save tokens',
      () => {
        const input: { botToken?: string; appToken?: string } = {};
        if (botInput.value.trim()) input.botToken = botInput.value.trim();
        if (appInput.value.trim()) input.appToken = appInput.value.trim();
        if (!input.botToken && !input.appToken) {
          ctx.flash('Nothing to save.', 'bad');
          return;
        }
        void (async () => {
          const result = await attempt<Result<SecretsStatus> | null>(ctx.api.setSecrets(input), null, (m) => ctx.flash(m, 'bad'));
          if (!result) return;
          if (!result.ok) {
            ctx.flash(result.error, 'bad');
            return;
          }
          botInput.value = '';
          appInput.value = '';
          secrets = result.value;
          painted = '';
          render();
          ctx.flash('Tokens saved. Restart the service for a new bot token to take effect.');
        })();
      },
      { variant: 'primary', disabled: !secrets.writable },
    );

    fill(
      parts.body,
      h(
        'div',
        { class: 'row wrap' },
        secrets.bot.present ? pill('ok', 'Bot token stored') : pill('bad', 'No bot token'),
        h('span', { class: 'field-hint' }, secrets.bot.hint ?? 'Not set'),
        secrets.app.present ? pill('ok', 'App token stored') : pill('bad', 'No app token'),
        h('span', { class: 'field-hint' }, secrets.app.hint ?? 'Not set'),
      ),
      !secrets.encryptionAvailable
        ? h(
            'div',
            { class: 'field-error' },
            'Keychain encryption is unavailable on this machine, so tokens cannot be written to disk. The app refuses to store them in plain text.',
          )
        : null,
      h('div', { class: 'hairline' }),
      h('span', { class: 'field-hint' }, 'Tokens are encrypted with the macOS Keychain and are never sent back to this window. Leave a box empty to keep the stored value.'),
      field({ label: 'Bot user OAuth token', hint: 'Starts with xoxb-. Changing it reconnects the socket.', control: botInput }).el,
      field({ label: 'App-level token', hint: 'Starts with xapp-, needs the connections:write scope.', control: appInput }).el,
    );
    fill(
      parts.footer,
      buttonGroup(
        saveTokens,
        confirmButton('Clear stored tokens', 'Confirm clear', () => {
        void (async () => {
          const result = await attempt<Result<SecretsStatus> | null>(ctx.api.clearSecrets(), null, (m) => ctx.flash(m, 'bad'));
          if (!result || !result.ok) {
            if (result) ctx.flash(result.error, 'bad');
            return;
          }
          secrets = result.value;
          painted = '';
          render();
          ctx.flash('Tokens cleared. The service cannot connect until they are entered again.');
        })();
        }),
      ),
    );
    return parts.el;
  }

  // -- agent defaults ------------------------------------------------------

  function agentCard(config: StoredConfig): HTMLElement {
    const parts = card('Agent defaults', h('span', { class: 'field-hint' }, 'A project can override any of these.'));

    const modelInput = textInput(config.agent.model, { mono: true, placeholder: DEFAULT_CONFIG.agent.model });
    commitOn(modelInput, () => {
      const value = modelInput.value.trim() || DEFAULT_CONFIG.agent.model;
      modelInput.value = value;
      void persist({ agent: { model: value } }, 'Model saved.');
    });

    const effort = segmented(
      EFFORT_LEVELS.map((level) => ({ value: level, label: level })),
      config.agent.effort,
      (next) => void persist({ agent: { effort: next as EffortLevel } }, `Effort set to ${next}.`),
      'Effort',
    );

    const permission = select(
      PERMISSION_MODES.map((mode) => ({ value: mode, label: PERMISSION_MODE_LABELS[mode].title })),
      config.agent.permissionMode,
    );
    const permissionField = field({
      label: 'Permission mode',
      hint: PERMISSION_MODE_LABELS[config.agent.permissionMode].blurb,
      error: PERMISSION_MODE_LABELS[config.agent.permissionMode].risky
        ? 'Unrestricted tool use, including Bash, in every project directory, with nobody watching.'
        : undefined,
      control: permission,
    });
    sectionDisposers.add(
      on(permission, 'change', () => {
        const mode = permission.value as PermissionMode;
        permissionField.setHint(PERMISSION_MODE_LABELS[mode].blurb);
        permissionField.setError(
          PERMISSION_MODE_LABELS[mode].risky
            ? 'Unrestricted tool use, including Bash, in every project directory, with nobody watching.'
            : undefined,
        );
        void persist({ agent: { permissionMode: mode } }, `Permission mode set to ${PERMISSION_MODE_LABELS[mode].title}.`);
      }),
    );

    fill(
      parts.body,
      field({ label: 'Model', hint: 'The model id passed to every session.', control: modelInput }).el,
      field({ label: 'Effort', hint: 'Higher effort thinks longer and costs more.', control: effort.el }).el,
      permissionField.el,
    );
    return parts.el;
  }

  // -- routing -------------------------------------------------------------

  function routingCard(config: StoredConfig): HTMLElement {
    const parts = card('Routing');

    const defaultProject = select(
      [
        { value: '', label: 'None, reply with the list of aliases' },
        ...config.projects.map((project) => ({ value: project.id, label: `${project.name} (${project.alias})` })),
      ],
      config.routing.defaultProjectId ?? '',
    );
    sectionDisposers.add(
      on(defaultProject, 'change', () => {
        void persist(
          { routing: { defaultProjectId: defaultProject.value || undefined } },
          defaultProject.value ? 'Default project saved.' : 'Unknown aliases now get the alias list.',
        );
      }),
    );

    const pending = numberInput(config.routing.pendingBindMinutes, TUNING_RANGES.pendingBindMinutes);
    commitOn(pending, () => {
      const value = clampToRange(Number(pending.value) || 0, TUNING_RANGES.pendingBindMinutes);
      pending.value = String(value);
      void persist({ routing: { pendingBindMinutes: value } }, value === 0 ? 'Pending bind disabled.' : 'Pending bind window saved.');
    });

    fill(
      parts.body,
      h(
        'span',
        { class: 'field-hint' },
        'The first line of the first message in a thread names the project. Later replies in that thread stay bound to it.',
      ),
      field({
        label: 'Default project',
        hint: 'Used when the first line matches no alias. Leave unset to get an explicit error instead.',
        control: defaultProject,
      }).el,
      switchField(
        'Single project fallback',
        'When exactly one project is enabled, route unrecognised first lines to it instead of erroring.',
        config.routing.singleProjectFallback,
        (next) => void persist({ routing: { singleProjectFallback: next } }, next ? 'Single project fallback on.' : 'Single project fallback off.'),
      ).el,
      field({
        label: 'Pending bind window, minutes',
        hint: 'Slack desktop sends on Enter, so the alias and the prompt often arrive as two messages. 0 disables the heuristic.',
        control: pending,
      }).el,
      switchField(
        'Recover a lost binding from the thread parent',
        'On an unbound reply, read the parent message once and bind from its first line.',
        config.routing.recoverBindingFromParent,
        (next) => void persist({ routing: { recoverBindingFromParent: next } }, 'Saved.'),
      ).el,
    );
    return parts.el;
  }

  // -- tuning --------------------------------------------------------------

  function tuningCard(config: StoredConfig): HTMLElement {
    const parts = card('Tuning');

    const idle = numberInput(config.tuning.sessionIdleMinutes, TUNING_RANGES.sessionIdleMinutes);
    commitOn(idle, () => {
      const value = clampToRange(Number(idle.value) || 0, TUNING_RANGES.sessionIdleMinutes);
      idle.value = String(value);
      void persist({ tuning: { sessionIdleMinutes: value } }, 'Idle timeout saved.');
    });

    const stall = numberInput(config.tuning.turnStallMinutes, TUNING_RANGES.turnStallMinutes);
    commitOn(stall, () => {
      const value = clampToRange(Number(stall.value) || 0, TUNING_RANGES.turnStallMinutes);
      stall.value = String(value);
      void persist({ tuning: { turnStallMinutes: value } }, 'Stall watchdog saved.');
    });

    const catchup = numberInput(config.tuning.catchupWindowHours, TUNING_RANGES.catchupWindowHours);
    commitOn(catchup, () => {
      const value = clampToRange(Number(catchup.value) || 0, TUNING_RANGES.catchupWindowHours);
      catchup.value = String(value);
      void persist({ tuning: { catchupWindowHours: value } }, 'Catch-up window saved.');
    });

    const statusMs = numberInput(config.tuning.statusUpdateMs, TUNING_RANGES.statusUpdateMs, 100);
    commitOn(statusMs, () => {
      const value = clampToRange(Number(statusMs.value) || 0, TUNING_RANGES.statusUpdateMs);
      statusMs.value = String(value);
      void persist({ tuning: { statusUpdateMs: value } }, 'Status update interval saved.');
    });

    fill(
      parts.body,
      field({
        label: 'Session idle timeout, minutes',
        hint: `An idle session is evicted after this long. ${range(TUNING_RANGES.sessionIdleMinutes)}`,
        control: idle,
      }).el,
      field({
        label: 'Stall watchdog, minutes',
        hint: `A turn silent for this long is reset so the thread is not left deaf. ${range(TUNING_RANGES.turnStallMinutes)}`,
        control: stall,
      }).el,
      field({
        label: 'Catch-up window, hours',
        hint: `How far back a reconnect replays missed DMs, bounded by the stored per-channel cursor. ${range(TUNING_RANGES.catchupWindowHours)}`,
        control: catchup,
      }).el,
      field({
        label: 'Status update interval, ms',
        hint: `How often the live status message in Slack is edited. The floor is Slack's rate limit. ${range(TUNING_RANGES.statusUpdateMs)}`,
        control: statusMs,
      }).el,
      switchField(
        'Stream progress heartbeat',
        'Counts streamed partial output as progress, so a long thinking block does not read as a stall.',
        config.tuning.streamProgressHeartbeat,
        (next) => void persist({ tuning: { streamProgressHeartbeat: next } }, 'Saved.'),
      ).el,
    );
    return parts.el;
  }

  // -- application ---------------------------------------------------------

  function applicationCard(config: StoredConfig): HTMLElement {
    const parts = card('Application');

    const loginSwitch = switchControl(
      loginItem?.enabled ?? config.app.runAtLogin,
      (next) => {
        void (async () => {
          const state = await attempt<LoginItemState | null>(ctx.api.setLoginItem(next), null, (m) => ctx.flash(m, 'bad'));
          if (!state) return;
          loginItem = state;
          // Persist what macOS actually agreed to, not what was asked for.
          await persist({ app: { runAtLogin: state.enabled } }, state.enabled ? 'slack-code will start at login.' : 'Login item removed.');
          painted = '';
          render();
        })();
      },
      'Run at login',
    );
    const loginField = field({
      label: 'Run at login',
      hint: loginHint(loginItem),
      error: loginItem?.status === 'requires-approval' ? 'macOS is holding this back. Approve slack-code in System Settings, General, Login Items.' : undefined,
      control: loginSwitch.el,
      inline: true,
    });
    if (loginItem && !loginItem.supported) loginSwitch.setDisabled(true, 'Only available in a packaged build.');

    fill(
      parts.body,
      loginField.el,
      switchField(
        'Connect on launch',
        'Start the Slack socket as soon as the app opens.',
        config.app.connectOnLaunch,
        (next) => void persist({ app: { connectOnLaunch: next } }, 'Saved.'),
      ).el,
      switchField(
        'Menu bar only',
        'Keep slack-code out of the Dock and live in the menu bar. The window still opens from the tray.',
        config.app.menuBarOnly,
        (next) => void persist({ app: { menuBarOnly: next } }, 'Saved.'),
      ).el,
      h('div', { class: 'hairline' }),
      switchField(
        'Notify on a failed turn',
        undefined,
        config.app.notifyOnTurnFailure,
        (next) => void persist({ app: { notifyOnTurnFailure: next } }, 'Saved.'),
      ).el,
      switchField(
        'Notify on a disconnect',
        'Only after the socket has been down for a minute.',
        config.app.notifyOnDisconnect,
        (next) => void persist({ app: { notifyOnDisconnect: next } }, 'Saved.'),
      ).el,
      switchField(
        'Notify when the stall watchdog fires',
        undefined,
        config.app.notifyOnStall,
        (next) => void persist({ app: { notifyOnStall: next } }, 'Saved.'),
      ).el,
      h('div', { class: 'hairline' }),
      switchField(
        'Debug logging',
        'Verbose lines in the log pane. Secrets are redacted either way.',
        config.app.debugLogging,
        (next) => void persist({ app: { debugLogging: next } }, next ? 'Debug logging on.' : 'Debug logging off.'),
      ).el,
    );
    // The hint goes first: the stylesheet gives a footer .btn an auto margin,
    // which pushes whatever button follows to the trailing edge.
    fill(
      parts.footer,
      h('span', { class: 'field-hint' }, 'Quitting stops answering Slack until the app is opened again.'),
      confirmButton('Quit slack-code', 'Confirm quit', () => void ctx.api.quit(), { variant: 'danger' }),
    );
    return parts.el;
  }

  // -- appearance ----------------------------------------------------------

  function appearanceCard(config: StoredConfig): HTMLElement {
    const parts = card('Appearance');

    const theme = segmented(
      [
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
      config.app.themeMode,
      (next) => {
        void (async () => {
          await attempt<ThemeState | null>(ctx.api.setThemeMode(next as ThemeMode), null, (m) => ctx.flash(m, 'bad'));
          await persist({ app: { themeMode: next as ThemeMode } }, 'Appearance saved.');
        })();
      },
      'Theme',
    );

    fill(
      parts.body,
      field({ label: 'Theme', control: theme.el }).el,
      switchField(
        'Window translucency',
        'Native macOS vibrancy behind the window. Turn it off for an opaque window if it ever hurts legibility.',
        config.app.vibrancy,
        (next) => void persist({ app: { vibrancy: next } }, 'Saved. Reopen the window to apply it.'),
      ).el,
      switchField(
        'Reduce motion',
        'Removes every transition. The system setting is honoured as well, so this only ever adds restraint.',
        config.app.reduceMotion,
        (next) => void persist({ app: { reduceMotion: next } }, 'Saved.'),
      ).el,
    );
    return parts.el;
  }

  // -- lifecycle -----------------------------------------------------------

  render();

  return {
    el,
    title: 'Settings',
    update: render,
    destroy() {
      sectionDisposers.dispose();
      disposers.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function range(bounds: readonly [number, number]): string {
  return `Allowed ${bounds[0]} to ${bounds[1]}.`;
}

function loginHint(state: LoginItemState | null): string {
  if (!state) return 'Reading the login item.';
  if (!state.supported) return 'Only available in a packaged build. In dev this would register the Electron helper, not the app.';
  if (state.status === 'requires-approval') return 'Registered, but macOS has not approved it yet.';
  return 'Starts quietly in the menu bar, with no window, unless setup is incomplete.';
}

/**
 * Rebuild the stored allowlist from a fresh resolution.
 *
 * `AllowlistResolution` reports resolved users and unresolved entries as two
 * flat lists without saying which entry produced which user, so match on id and
 * name first and fall back to position over the entries that did resolve.
 */
export function mergeAllowlist(entries: string[], resolution: AllowlistResolution): AllowedUser[] {
  const unresolved = new Set(resolution.unresolved.map((entry) => entry.toLowerCase()));
  const pool = [...resolution.resolved];
  const now = new Date().toISOString();

  return entries.map((entry) => {
    if (unresolved.has(entry.toLowerCase())) return { entry };
    const needle = entry.replace(/^@/, '').toLowerCase();
    let index = pool.findIndex((user) => user.id.toLowerCase() === needle || user.name.toLowerCase() === needle);
    if (index === -1) index = 0;
    const user = pool[index];
    if (!user) return { entry };
    pool.splice(index, 1);
    return { entry, id: user.id, name: user.name, resolvedAt: now };
  });
}
