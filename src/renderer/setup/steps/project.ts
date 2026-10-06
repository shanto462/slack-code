/**
 * Step 6: projects and their aliases.
 *
 * The alias is the whole routing scheme: the first line of the first message in
 * a thread names the project, and every later reply in that thread stays bound
 * to it. So the alias field validates with `validateAlias` from the shared
 * contract, which is the exact function the router uses. The UI can never accept
 * an alias the router would then reject.
 */

import type { ProjectConfig, ProjectDirCheckData, ProjectDraft } from '../../../shared/contract.ts';
import { validateAlias } from '../../../shared/contract.ts';
import { checkRow } from '../checks-ui.ts';
import { Bag, basename, button, card, el, emptyState, slugify, textField } from '../ui.ts';
import type { StepContext, StepHandle, StepModule } from './types.ts';

function takenAliases(projects: ProjectConfig[], exceptId?: string): string[] {
  return projects
    .filter((project) => project.id !== exceptId)
    .flatMap((project) => [project.alias, ...project.aliases])
    .map((alias) => alias.toLowerCase());
}

function dirFacts(data: ProjectDirCheckData): HTMLElement {
  const row = el('div', { class: 'row' });
  row.appendChild(el('span', { class: data.isGitRepo ? 'chip chip-ok' : 'chip', text: data.isGitRepo ? 'git repo' : 'not a git repo' }));
  if (data.hasClaudeSettings) row.appendChild(el('span', { class: 'chip chip-ok', text: '.claude settings' }));
  if (data.hasDenyRules) row.appendChild(el('span', { class: 'chip chip-pending', text: 'has deny rules' }));
  return row;
}

export const projectStep: StepModule = {
  id: 'project',
  label: 'Projects',
  title: 'Add a project',
  subtitle: 'Each project is a folder plus a short alias. The alias is how a Slack message picks the project.',

  mount(ctx: StepContext): StepHandle {
    const bag = new Bag();
    let dir = '';
    let aliasTouched = false;
    let nameTouched = false;
    let dirData: ProjectDirCheckData | null = null;

    const listSlot = el('div', { class: 'stack' });
    const dirLine = el('p', { class: 'code', text: 'No folder chosen yet.' });
    const dirCheck = checkRow('Folder', 'Choose a folder to check it.');

    const aliasField = textField({
      label: 'Alias',
      placeholder: 'writings',
      hint: 'Lowercase letters, numbers, and - or _ inside. No dots: Slack turns anything domain-shaped into a link, and a link can never match.',
      mono: true,
      onInput: () => {
        aliasTouched = true;
        validate();
      },
    });

    const nameField = textField({
      label: 'Display name',
      placeholder: 'My Project',
      hint: 'Shown in the app and in the receipt line under every answer.',
      onInput: () => {
        nameTouched = true;
      },
    });

    const addButton = button('Add project', {
      variant: 'primary',
      disabled: true,
      onClick: () => {
        void add();
      },
    });

    function validate(): boolean {
      const alias = aliasField.input.value;
      if (!alias.trim()) {
        aliasField.setError(null);
        addButton.disabled = true;
        return false;
      }
      const result = validateAlias(alias, takenAliases(ctx.state.config.projects));
      aliasField.setError(result.ok ? null : (result.message ?? 'Not a usable alias.'));
      const usable = result.ok && dir.length > 0;
      addButton.disabled = !usable;
      return usable;
    }

    async function chooseDir(): Promise<void> {
      const picked = await window.api.pickDirectory();
      if (!picked) return;
      dir = picked;
      dirLine.textContent = picked;
      if (!aliasTouched || !aliasField.input.value.trim()) aliasField.input.value = slugify(basename(picked));
      if (!nameTouched || !nameField.input.value.trim()) nameField.input.value = basename(picked);
      validate();
      await checkDir();
    }

    async function checkDir(): Promise<void> {
      if (!dir) return;
      dirCheck.setRunning();
      const result = await window.api.runCheck('projectDir', { dir });
      dirCheck.setResult(result);
      dirData = (result.data as ProjectDirCheckData | undefined) ?? null;
      renderDirFacts();
      if (!result.ok) addButton.disabled = true;
      else validate();
    }

    const factsSlot = el('div', { class: 'stack' });
    function renderDirFacts(): void {
      factsSlot.replaceChildren(dirData ? dirFacts(dirData) : el('span'));
    }

    async function add(): Promise<void> {
      if (!validate()) return;
      const draft: ProjectDraft = {
        alias: validateAlias(aliasField.input.value).value,
        name: nameField.input.value.trim() || basename(dir),
        dir,
        enabled: true,
      };
      addButton.disabled = true;
      const result = await window.api.addProject(draft);
      if (!result.ok) {
        aliasField.setError(result.error);
        addButton.disabled = false;
        ctx.say(result.error, 'bad');
        return;
      }
      await ctx.state.reload();
      reset();
      renderList();
      ctx.say(`Added ${result.value.name} as ${result.value.alias}.`, 'ok');
      ctx.refresh();
    }

    function reset(): void {
      dir = '';
      dirData = null;
      aliasTouched = false;
      nameTouched = false;
      aliasField.input.value = '';
      nameField.input.value = '';
      aliasField.setError(null);
      dirLine.textContent = 'No folder chosen yet.';
      dirCheck.setIdle('Choose a folder to check it.');
      renderDirFacts();
      addButton.disabled = true;
    }

    async function remove(project: ProjectConfig): Promise<void> {
      const result = await window.api.removeProject(project.id);
      if (!result.ok) {
        ctx.say(result.error, 'bad');
        return;
      }
      await ctx.state.reload();
      renderList();
      validate();
      ctx.refresh();
    }

    function renderList(): void {
      const projects = ctx.state.config.projects;
      if (projects.length === 0) {
        listSlot.replaceChildren(card({ title: 'Your projects', body: [emptyState('No projects yet. Add the first one below.')] }));
        return;
      }
      const rows = projects.map((project) =>
        el(
          'div',
          { class: 'row spread hairline' },
          el(
            'div',
            { class: 'stack' },
            el(
              'div',
              { class: 'row' },
              el('span', { class: 'chip chip-ok', text: project.alias }),
              el('span', { class: 'field-label', text: project.name }),
              ...project.aliases.map((extra) => el('span', { class: 'chip', text: extra })),
            ),
            el('span', { class: 'field-hint', text: project.dir }),
          ),
          button('Remove', {
            variant: 'ghost',
            onClick: () => {
              void remove(project);
            },
          }),
        ),
      );
      listSlot.replaceChildren(
        card({ title: 'Your projects', subtitle: `${projects.length} configured. You can add more later in Settings.`, body: rows }),
      );
    }

    ctx.body.append(
      listSlot,
      card({
        title: 'Add a project',
        body: [
          el(
            'div',
            { class: 'field' },
            el('span', { class: 'field-label', text: 'Folder' }),
            dirLine,
            el('p', { class: 'field-hint', text: 'The agent runs with this as its working directory, exactly as if you had opened a terminal there.' }),
          ),
          factsSlot,
          dirCheck.node,
          aliasField.wrap,
          nameField.wrap,
        ],
        footer: [
          button('Choose folder…', {
            onClick: () => {
              void chooseDir();
            },
          }),
          addButton,
        ],
      }),
      card({
        title: 'How a message picks the project',
        body: [
          el('p', { class: 'field-hint', text: 'Put the alias on its own first line of the first message in a thread. Everything after it is the prompt.' }),
          el('pre', { class: 'code' }, el('code', { text: 'writings\nsummarise what changed in the last commit' })),
          el('p', {
            class: 'field-hint',
            text: 'Only the first message of a thread needs the alias. Every reply in that thread stays bound to the same project, and a reply whose first line happens to match an alias is treated as prose, not as a switch.',
          }),
          el('p', {
            class: 'field-hint',
            text: 'On Slack desktop, Enter sends and Shift+Enter makes the line break. If you do send the alias on its own by accident, the bot pins the thread to that project and waits for the prompt.',
          }),
          el('p', {
            class: 'field-hint',
            text: 'An alias that matches nothing is answered with the list of valid aliases. It never guesses.',
          }),
        ],
      }),
    );

    renderList();
    renderDirFacts();

    return {
      destroy: () => bag.dispose(),
      canAdvance: () => ctx.state.config.projects.length > 0,
      async beforeNext() {
        // A filled-in but unsubmitted form is almost always an operator who
        // expected Continue to mean "add this and move on".
        if (dir && validate()) await add();
        return ctx.state.config.projects.length > 0;
      },
    };
  },
};
