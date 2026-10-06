/**
 * Projects pane: add, edit, reorder, pause and remove the directories the bot
 * can drive, each behind the alias that routes a Slack thread to it.
 *
 * There is no modal anywhere in this app. Editing opens an inline form above
 * the list and destructive buttons ask twice in place, which keeps the whole
 * pane inside the shared CSS contract.
 */

import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  normaliseAlias,
  validateAlias,
  type EffortLevel,
  type PermissionMode,
  type ProjectConfig,
  type ProjectDraft,
  type ProjectHealth,
  type ProjectId,
  type Result,
  type SelfTestResult,
} from '../../../shared/contract.ts';
import {
  button,
  buttonGroup,
  card,
  chip,
  code,
  confirmButton,
  emptyState,
  field,
  pill,
  select,
  switchControl,
  spacer,
  textInput,
  textarea,
} from '../components.ts';
import { Disposers, fill, h, holdsFocus, on, setVisible } from '../dom.ts';
import { attempt, type Ctx, type View } from '../types.ts';

export function createProjectsView(ctx: Ctx): View {
  const disposers = new Disposers();
  const editorSlot = h('div', {});
  const listSlot = h('div', { class: 'stack' });
  const el = h('div', { class: 'stack' }, editorSlot, listSlot);

  const addButton = button('Add project', () => openEditor(null), { variant: 'primary' });
  const actions = h('div', { class: 'row wrap' }, addButton);

  /** Self-test output, kept out of the DOM so a list rebuild does not lose it. */
  const selftestResults = new Map<ProjectId, { ok: boolean; text: string }>();
  /** Listeners belonging to the open editor only, torn down when it closes. */
  let editorDisposers = new Disposers();
  let editing: ProjectId | 'new' | null = null;
  let listDirty = false;

  disposers.add(
    on(listSlot, 'focusout', () => {
      if (listDirty) queueMicrotask(() => renderList());
    }),
  );

  // -- list ----------------------------------------------------------------

  function renderList(): void {
    const state = ctx.store.get();
    const projects = state.config?.projects ?? [];

    if (holdsFocus(listSlot)) {
      listDirty = true;
      return;
    }
    listDirty = false;

    if (projects.length === 0) {
      fill(
        listSlot,
        emptyState(
          'No projects yet.',
          'Add one and give it a short alias. The alias goes on the first line of the Slack message, the prompt goes underneath.',
        ),
      );
      return;
    }

    const health = new Map((state.status?.projects ?? []).map((p: ProjectHealth) => [p.id, p]));
    fill(listSlot, ...projects.map((project, index) => projectCard(project, index, projects, health.get(project.id))));
  }

  function projectCard(
    project: ProjectConfig,
    index: number,
    all: ProjectConfig[],
    health: ProjectHealth | undefined,
  ): HTMLElement {
    const enabled = switchControl(project.enabled, (next) => void save(draftFrom(project, { enabled: next }), project.id), 'Enabled');
    const statusPill = !project.enabled
      ? pill('idle', 'Paused')
      : health && !health.dirOk
        ? pill('bad', 'Directory missing')
        : pill('ok', 'Ready');

    const parts = card(
      project.name,
      h('div', { class: 'row' }, statusPill, enabled.el),
    );

    const aliasChips = h(
      'div',
      { class: 'row row-tight wrap' },
      chip(project.alias, 'ok'),
      ...project.aliases.map((alias) => chip(alias)),
    );

    const overrides: string[] = [];
    if (project.model) overrides.push(`model ${project.model}`);
    if (project.permissionMode) overrides.push(`permissions ${PERMISSION_MODE_LABELS[project.permissionMode].title.toLowerCase()}`);
    if (project.effort) overrides.push(`effort ${project.effort}`);
    if (project.additionalDirectories?.length) overrides.push(`${project.additionalDirectories.length} extra directories`);

    const selftest = selftestResults.get(project.id);

    fill(
      parts.body,
      aliasChips,
      h('div', { class: 'scroll-x' }, code(project.dir)),
      health && !health.dirOk && health.problem ? h('div', { class: 'field-error' }, health.problem) : null,
      h('span', { class: 'field-hint' }, overrides.length > 0 ? `Overrides: ${overrides.join(', ')}` : 'Uses the agent defaults from Settings.'),
      selftest ? h('div', { class: selftest.ok ? 'field-hint' : 'field-error' }, selftest.text) : null,
    );

    fill(
      parts.footer,
      buttonGroup(
        button('Edit', () => openEditor(project.id), { small: true }),
        button('Reveal', () => void ctx.api.revealPath(project.dir), { variant: 'ghost', small: true }),
        button('Self test', () => void runSelftest(project), {
          variant: 'ghost',
          small: true,
          title: 'Sends a real message through Slack and back.',
        }),
        button('Move up', () => void reorder(all, index, -1), { variant: 'ghost', small: true, disabled: index === 0 }),
        button('Move down', () => void reorder(all, index, 1), {
          variant: 'ghost',
          small: true,
          disabled: index === all.length - 1,
        }),
        confirmButton('Remove', 'Confirm remove', () => void remove(project), { small: true }),
      ),
    );

    return parts.el;
  }

  // -- mutations -----------------------------------------------------------

  async function save(draft: ProjectDraft, id: ProjectId | null): Promise<boolean> {
    const call = id ? ctx.api.updateProject({ ...draft, id }) : ctx.api.addProject(draft);
    const result = await attempt<Result<ProjectConfig> | null>(call, null, (m) => ctx.flash(m, 'bad'));
    if (!result) return false;
    if (!result.ok) {
      ctx.flash(result.error, 'bad');
      return false;
    }
    ctx.flash(id ? `Saved ${result.value.name}.` : `Added ${result.value.name}.`);
    await ctx.refreshConfig();
    return true;
  }

  async function remove(project: ProjectConfig): Promise<void> {
    const result = await attempt<Result<null> | null>(ctx.api.removeProject(project.id), null, (m) => ctx.flash(m, 'bad'));
    if (!result) return;
    if (!result.ok) {
      ctx.flash(result.error, 'bad');
      return;
    }
    selftestResults.delete(project.id);
    if (editing === project.id) closeEditor();
    ctx.flash(`Removed ${project.name}. Threads bound to it now answer with the orphaned message.`);
    await ctx.refreshConfig();
  }

  async function reorder(all: ProjectConfig[], index: number, step: number): Promise<void> {
    const next = all.map((p) => p.id);
    const target = index + step;
    if (target < 0 || target >= next.length) return;
    const moved = next[index]!;
    next[index] = next[target]!;
    next[target] = moved;
    const result = await attempt<Result<ProjectConfig[]> | null>(ctx.api.reorderProjects(next), null, (m) => ctx.flash(m, 'bad'));
    if (result && !result.ok) ctx.flash(result.error, 'bad');
    await ctx.refreshConfig();
  }

  async function runSelftest(project: ProjectConfig): Promise<void> {
    selftestResults.set(project.id, { ok: true, text: 'Self test running, this posts a real Slack message.' });
    renderList();
    const result = await attempt<Result<SelfTestResult> | null>(ctx.api.runSelftest(project.id), null, (m) => ctx.flash(m, 'bad'));
    if (!result) {
      selftestResults.delete(project.id);
      renderList();
      return;
    }
    if (!result.ok) {
      selftestResults.set(project.id, { ok: false, text: result.error });
    } else {
      const value = result.value;
      selftestResults.set(project.id, {
        ok: value.ok,
        text: `${value.ok ? 'Self test passed' : 'Self test failed'} in ${Math.round(value.durationMs / 100) / 10}s: ${value.detail}`,
      });
    }
    renderList();
  }

  // -- editor --------------------------------------------------------------

  function openEditor(id: ProjectId | null): void {
    editing = id ?? 'new';
    renderEditor();
    editorSlot.querySelector<HTMLElement>('input')?.focus();
    editorSlot.scrollIntoView({ block: 'nearest' });
  }

  function closeEditor(): void {
    editing = null;
    editorDisposers.dispose();
    fill(editorSlot);
    addButton.disabled = false;
  }

  function renderEditor(): void {
    editorDisposers.dispose();
    editorDisposers = new Disposers();
    if (editing === null) {
      fill(editorSlot);
      addButton.disabled = false;
      return;
    }
    addButton.disabled = true;

    const state = ctx.store.get();
    const projects = state.config?.projects ?? [];
    const defaults = state.config?.agent;
    const existing = editing === 'new' ? undefined : projects.find((p) => p.id === editing);
    if (editing !== 'new' && !existing) {
      closeEditor();
      return;
    }

    const taken = projects
      .filter((p) => p.id !== existing?.id)
      .flatMap((p) => [p.alias, ...p.aliases])
      .map((a) => a.toLowerCase());

    const parts = card(existing ? `Edit ${existing.name}` : 'New project');

    const aliasInput = textInput(existing?.alias ?? '', { mono: true, placeholder: 'writings' });
    const aliasField = field({
      label: 'Alias',
      hint: 'The first line of the first Slack message in a thread. Lowercase letters, numbers, - and _.',
      control: aliasInput,
    });

    const extraInput = textInput(existing?.aliases.join(', ') ?? '', { mono: true, placeholder: 'w, notes' });
    const extraField = field({
      label: 'Extra aliases',
      hint: 'Optional shorthand, comma separated. Any of them routes to this project.',
      control: extraInput,
    });

    const nameInput = textInput(existing?.name ?? '', { placeholder: 'My Project' });
    const nameField = field({ label: 'Display name', hint: 'Shown in the app and in every Slack receipt footer.', control: nameInput });

    const dirInput = textInput(existing?.dir ?? '', { mono: true, placeholder: '/Users/you/Projects/my-project' });
    const pick = button('Choose…', () => {
      void ctx.api.pickDirectory().then((chosen) => {
        if (!chosen) return;
        dirInput.value = chosen;
        if (!nameInput.value.trim()) nameInput.value = basename(chosen);
        if (!aliasInput.value.trim()) {
          aliasInput.value = normaliseAlias(basename(chosen).replace(/[^a-zA-Z0-9_-]+/g, '-'));
        }
        touched = true;
        validate();
      });
    });
    const dirField = field({
      label: 'Directory',
      hint: 'The agent runs here. It must exist and be readable.',
      control: h('div', { class: 'row' }, dirInput, pick),
    });

    const enabledSwitch = switchControl(existing?.enabled ?? true, () => undefined, 'Enabled');
    const enabledField = field({
      label: 'Enabled',
      hint: 'A paused project answers with a distinct message instead of running.',
      control: enabledSwitch.el,
      inline: true,
    });

    const modelInput = textInput(existing?.model ?? '', {
      mono: true,
      placeholder: defaults ? `Inherit default (${defaults.model})` : 'Inherit default',
    });
    const modelField = field({ label: 'Model override', hint: 'Leave empty to use the default from Settings.', control: modelInput });

    const permissionSelect = select(
      [
        { value: '', label: defaults ? `Inherit default (${PERMISSION_MODE_LABELS[defaults.permissionMode].title})` : 'Inherit default' },
        ...PERMISSION_MODES.map((mode) => ({ value: mode, label: PERMISSION_MODE_LABELS[mode].title })),
      ],
      existing?.permissionMode ?? '',
    );
    const permissionField = field({ label: 'Permission mode', control: permissionSelect });
    const syncPermissionHint = () => {
      const value = permissionSelect.value as PermissionMode | '';
      if (!value) {
        permissionField.setHint('Uses the default from Settings.');
        permissionField.setError(undefined);
        return;
      }
      const label = PERMISSION_MODE_LABELS[value];
      permissionField.setHint(label.blurb);
      permissionField.setError(
        label.risky
          ? 'This grants unrestricted tool use, including Bash, in this directory with nobody watching.'
          : undefined,
      );
    };
    editorDisposers.add(on(permissionSelect, 'change', syncPermissionHint));
    syncPermissionHint();

    const effortSelect = select(
      [{ value: '', label: defaults ? `Inherit default (${defaults.effort})` : 'Inherit default' }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: e }))],
      existing?.effort ?? '',
    );
    const effortField = field({ label: 'Effort', control: effortSelect });

    const extraDirsInput = textarea((existing?.additionalDirectories ?? []).join('\n'), 3, '/Users/you/Projects/shared-lib');
    const extraDirsField = field({
      label: 'Additional directories',
      hint: 'One absolute path per line. The agent may read and write these as well as the project directory.',
      control: extraDirsInput,
    });

    // Deliberately not "Add project": that is the header button's label, and
    // two identical primary buttons on screen at once is a coin toss.
    const saveButton = button(existing ? 'Save changes' : 'Create project', () => void commit(), { variant: 'primary' });
    const formError = h('div', { class: 'field-error', role: 'alert' });
    setVisible(formError, false);

    // An empty form should not open covered in red. Errors appear once a field
    // has been touched, or when Save is pressed.
    let touched = existing !== undefined;

    function validate(): boolean {
      const aliasResult = validateAlias(aliasInput.value, taken);
      aliasField.setError(touched && !aliasResult.ok ? aliasResult.message : undefined);

      const extras = splitList(extraInput.value);
      const seen = new Set<string>([aliasResult.value]);
      let extraError: string | undefined;
      for (const raw of extras) {
        const check = validateAlias(raw, taken);
        if (!check.ok) {
          extraError = check.message;
          break;
        }
        if (seen.has(check.value)) {
          extraError = `\`${check.value}\` is listed twice.`;
          break;
        }
        seen.add(check.value);
      }
      extraField.setError(touched ? extraError : undefined);

      const dirOk = dirInput.value.trim().startsWith('/');
      dirField.setError(touched && !dirOk ? 'Give an absolute path, starting with /.' : undefined);

      const ok = aliasResult.ok && !extraError && dirOk;
      saveButton.disabled = !ok;
      return ok;
    }

    async function commit(): Promise<void> {
      touched = true;
      if (!validate()) return;
      const aliasResult = validateAlias(aliasInput.value, taken);
      // Strip a trailing slash. The thread record stores the cwd at bind time
      // and compares it against the project directory to spot a moved project,
      // so "/x/y" and "/x/y/" being different strings would raise a false alarm.
      const dir = dirInput.value.trim().replace(/(?!^)\/+$/, '');
      const draft: ProjectDraft = {
        alias: aliasResult.value,
        aliases: splitList(extraInput.value).map((a) => normaliseAlias(a)),
        name: nameInput.value.trim() || basename(dir),
        dir,
        enabled: enabledSwitch.el.getAttribute('aria-checked') === 'true',
        model: modelInput.value.trim() || undefined,
        permissionMode: (permissionSelect.value || undefined) as PermissionMode | undefined,
        effort: (effortSelect.value || undefined) as EffortLevel | undefined,
        additionalDirectories: splitLines(extraDirsInput.value),
      };
      saveButton.disabled = true;
      const done = await save(draft, existing?.id ?? null);
      saveButton.disabled = false;
      if (done) closeEditor();
      else {
        formError.textContent = 'The change was not saved. See the message above.';
        setVisible(formError, true);
      }
    }

    for (const input of [aliasInput, extraInput, dirInput]) {
      editorDisposers.add(
        on(input, 'input', () => {
          touched = true;
          validate();
        }),
      );
    }

    fill(
      parts.body,
      aliasField.el,
      extraField.el,
      nameField.el,
      dirField.el,
      enabledField.el,
      h('div', { class: 'hairline' }),
      modelField.el,
      permissionField.el,
      effortField.el,
      extraDirsField.el,
      formError,
    );
    fill(parts.footer, spacer(), buttonGroup(button('Cancel', () => closeEditor(), { variant: 'ghost' }), saveButton));
    fill(editorSlot, parts.el);
    validate();
  }

  // -- lifecycle -----------------------------------------------------------

  function update(): void {
    renderList();
    // A project removed from under an open editor closes it, and nothing else
    // in the editor depends on shared state, so it is otherwise left alone.
    if (editing !== null && editing !== 'new') {
      const still = (ctx.store.get().config?.projects ?? []).some((p) => p.id === editing);
      if (!still) closeEditor();
    }
  }

  update();

  return {
    el,
    title: 'Projects',
    actions,
    update,
    destroy() {
      disposers.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function draftFrom(project: ProjectConfig, patch: Partial<ProjectDraft>): ProjectDraft {
  return {
    alias: project.alias,
    aliases: project.aliases,
    name: project.name,
    dir: project.dir,
    enabled: project.enabled,
    model: project.model,
    permissionMode: project.permissionMode,
    effort: project.effort,
    additionalDirectories: project.additionalDirectories,
    ...patch,
  };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function basename(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || dir;
}
