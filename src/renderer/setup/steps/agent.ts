/**
 * Step 7: model, effort and permission mode.
 *
 * The permission mode is the only real authority grant in this wizard, so
 * nothing is preselected. An absent field in config.json means a hand edit or a
 * truncated write, and that path falls back to the safer value rather than to
 * bypass. The only exception is an imported .env, which carries a mode the
 * operator already chose once.
 */

import type { EffortLevel, PermissionMode } from '../../../shared/contract.ts';
import { EFFORT_LEVELS, PERMISSION_MODES, PERMISSION_MODE_LABELS } from '../../../shared/contract.ts';
import { Bag, card, el, segmented, textField } from '../ui.ts';
import type { StepContext, StepHandle, StepModule } from './types.ts';

const EFFORT_BLURB: Record<EffortLevel, string> = {
  low: 'Fastest and cheapest. Fine for short questions.',
  medium: 'Balanced.',
  high: 'More thinking per turn.',
  xhigh: 'Much more thinking. Slower and dearer.',
  max: 'Everything it has. Best for real work, worst for a quick answer.',
};

export const agentStep: StepModule = {
  id: 'agent',
  label: 'Agent',
  title: 'How the agent runs',
  subtitle: 'Defaults for every project. Any project can override them later in Settings.',

  mount(ctx: StepContext): StepHandle {
    const bag = new Bag();
    const defaults = ctx.state.config.agent;

    let model = defaults.model;
    let effort: EffortLevel = defaults.effort;
    // Nothing is preselected on a fresh setup. An acknowledged step means the
    // operator has already chosen once, here or through the .env import.
    let mode: PermissionMode | null = ctx.state.isAcknowledged('agent') ? defaults.permissionMode : null;
    let bypassConfirmed = mode === 'bypassPermissions';

    const consequencesSlot = el('div', { class: 'stack' });

    function persist(): void {
      void ctx.state.save({
        agent: {
          model,
          effort,
          ...(mode ? { permissionMode: mode } : {}),
        },
      });
    }

    const modelField = textField({
      label: 'Model',
      value: model,
      placeholder: 'claude-opus-5',
      mono: true,
      hint: 'Any model id the Claude Code CLI accepts. The short names opus, sonnet and haiku work too.',
      onInput: (value) => {
        model = value.trim();
        modelField.setError(model ? null : 'A model is required.');
        ctx.refresh();
        persist();
      },
    });
    const suggestions = el('datalist', { id: 'model-suggestions' });
    for (const suggestion of ['claude-opus-5', 'opus', 'sonnet', 'haiku']) suggestions.appendChild(el('option', { value: suggestion }));
    modelField.input.setAttribute('list', 'model-suggestions');
    modelField.wrap.appendChild(suggestions);

    const effortHint = el('p', { class: 'field-hint', text: EFFORT_BLURB[effort] });
    const effortControl = segmented<EffortLevel>({
      label: 'Effort',
      options: EFFORT_LEVELS.map((level) => ({ value: level, label: level })),
      value: effort,
      onChange: (value) => {
        effort = value;
        effortHint.textContent = EFFORT_BLURB[value];
        persist();
      },
    });
    effortControl.wrap.appendChild(effortHint);

    // Permission mode. Native radios, deliberately: six options with a sentence
    // of explanation each will not fit a segmented control, and a radio list is
    // the pattern macOS itself uses for exactly this shape of choice. Native
    // radios are also keyboard reachable with no extra code.
    const modeGroup = el('div', { class: 'field', attrs: { role: 'radiogroup', 'aria-label': 'Permission mode' } });
    modeGroup.appendChild(el('span', { class: 'field-label', text: 'Permission mode' }));
    modeGroup.appendChild(
      el('p', { class: 'field-hint', text: 'Nothing is preselected. This decides what the agent may do in your folders without asking you first.' }),
    );

    for (const candidate of PERMISSION_MODES) {
      const meta = PERMISSION_MODE_LABELS[candidate];
      const input = el('input', {
        type: 'radio',
        name: 'permission-mode',
        value: candidate,
        attrs: { checked: mode === candidate },
        onChange: () => {
          mode = candidate;
          bypassConfirmed = candidate !== 'bypassPermissions' ? true : bypassConfirmed;
          renderConsequences();
          ctx.refresh();
          persist();
        },
      });
      modeGroup.appendChild(
        el(
          'label',
          { class: 'row spread hairline' },
          el(
            'div',
            { class: 'row' },
            input,
            el(
              'div',
              { class: 'stack' },
              el('span', { class: 'field-label', text: meta.title }),
              el('p', { class: 'field-hint', text: meta.blurb }),
            ),
          ),
          meta.risky ? el('span', { class: 'chip chip-bad', text: 'risky' }) : el('span', { class: 'chip', text: candidate }),
        ),
      );
    }

    function renderConsequences(): void {
      if (mode !== 'bypassPermissions') {
        consequencesSlot.replaceChildren();
        return;
      }
      const confirm = el('input', {
        type: 'checkbox',
        attrs: { checked: bypassConfirmed },
        onChange: () => {
          bypassConfirmed = !bypassConfirmed;
          ctx.refresh();
        },
      });
      consequencesSlot.replaceChildren(
        card({
          title: 'Before you pick bypass',
          body: [
            el(
              'ul',
              { class: 'stack' },
              el('li', { text: 'Every tool runs without asking, including Bash, in every project folder you have added.' }),
              el('li', { text: 'Turns start from a Slack DM, so nobody is at the keyboard when a command runs.' }),
              el('li', { text: 'A turn can edit files, delete them, install packages, and reach the network.' }),
              el('li', { text: 'The allowlist is the only thing standing in front of this. Keep it short.' }),
            ),
            el('label', { class: 'row' }, confirm, el('span', { class: 'field-label', text: 'I understand what this grants.' })),
          ],
        }),
      );
    }

    ctx.body.append(
      card({
        title: 'Model and effort',
        body: [modelField.wrap, effortControl.wrap],
      }),
      card({
        title: 'Authority',
        body: [modeGroup],
      }),
      consequencesSlot,
    );

    renderConsequences();

    return {
      destroy: () => bag.dispose(),
      canAdvance: () => Boolean(model) && mode !== null && (mode !== 'bypassPermissions' || bypassConfirmed),
      async beforeNext() {
        if (!mode) return false;
        const saved = await ctx.state.save({
          agent: { model, effort, permissionMode: mode },
        });
        if (!saved.ok) {
          ctx.say(saved.error, 'bad');
          return false;
        }
        ctx.state.acknowledge('agent');
        return true;
      },
    };
  },
};
