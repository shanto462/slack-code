/**
 * The setup wizard shell.
 *
 * Owns the rail, the header, the footer and navigation. It owns nothing inside
 * a step: a step renders into the body it is handed, says whether Continue may
 * light up, and returns one destroy(). That split is what keeps ten steps
 * readable.
 *
 * Two rules the shell enforces on behalf of the product:
 *
 *   1. A step in SETUP_BLOCKING_STEPS cannot be passed without a green check.
 *      The others can be skipped, and say so on the button.
 *   2. A resumed wizard opens at the first step that is not satisfied, worked
 *      out from the real config and the real secret store rather than from a
 *      remembered position, so a token stored in a previous run counts.
 */

import { SETUP_BLOCKING_STEPS } from '../../shared/contract.ts';
import type { SetupStepId, StoredConfig } from '../../shared/contract.ts';
import { STEP_MODULES } from './steps/index.ts';
import type { StepContext, StepHandle } from './steps/types.ts';
import { Bag, clear, el } from './ui.ts';
import type { Tone } from './ui.ts';
import { WizardState } from './wizard-state.ts';

type RailState = 'todo' | 'current' | 'done' | 'error';

function isBlocking(id: SetupStepId): boolean {
  return SETUP_BLOCKING_STEPS.includes(id);
}

/**
 * Render the wizard into `root` and return a teardown function.
 *
 * `onComplete` fires once `completeSetup()` has resolved, which is the shell's
 * cue to swap the dashboard in.
 */
export function mountSetup(root: HTMLElement, onComplete: () => void): () => void {
  let disposed = false;
  let teardown: () => void = () => {};

  const host = el('div', { class: 'wizard' }, el('p', { class: 'field-hint', text: 'Loading…' }));
  root.appendChild(host);

  void (async () => {
    let state: WizardState;
    try {
      state = await WizardState.load();
    } catch (error) {
      if (disposed) return;
      clear(host);
      host.appendChild(
        el(
          'div',
          { class: 'card glass' },
          el('div', { class: 'card-header' }, el('h3', { text: 'Setup could not start' })),
          el(
            'div',
            { class: 'card-body' },
            el('p', { class: 'field-error', text: String(error) }),
            el('p', { class: 'field-hint', text: 'The app could not read its own settings. Quit and reopen it; the file is rebuilt from defaults if it is unreadable.' }),
          ),
        ),
      );
      return;
    }
    if (disposed) return;
    clear(host);
    teardown = build(host, state, onComplete);
  })();

  return () => {
    disposed = true;
    teardown();
    host.remove();
  };
}

function build(host: HTMLElement, state: WizardState, onComplete: () => void): () => void {
  const bag = new Bag();
  let index = state.resumeIndex();
  let reached = index;
  let handle: StepHandle | null = null;
  let busy = false;

  // ---------------------------------------------------------------------
  // Chrome
  // ---------------------------------------------------------------------
  const rail = el('nav', { class: 'wizard-dots', attrs: { 'aria-label': 'Setup steps' } });

  const headerTitle = el('h2');
  const headerSubtitle = el('p', { class: 'field-hint' });
  const progressCaption = el('span', { class: 'wizard-progress-caption' });
  const stepBody = el('div', { class: 'detail-body' });
  const bodyPane = el(
    'section',
    { class: 'wizard-body', attrs: { tabindex: '-1' } },
    el('header', { class: 'detail-header' }, headerTitle, headerSubtitle),
    stepBody,
  );

  const backButton = el('button', {
    class: 'btn btn-ghost',
    type: 'button',
    text: 'Back',
    onClick: () => goTo(index - 1),
  });
  const status = el('p', { class: 'field-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const nextButton = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: 'Continue',
    onClick: () => {
      void advance();
    },
  });
  const footer = el(
    'footer',
    { class: 'wizard-footer' },
    el('div', { class: 'row spread' }, backButton, status, el('div', { class: 'row' }, nextButton)),
  );

  const progress = el('div', { class: 'wizard-progress' }, rail, progressCaption);

  host.append(progress, bodyPane, footer);

  // ---------------------------------------------------------------------
  // Rail
  // ---------------------------------------------------------------------
  function railState(position: number): RailState {
    if (position === index) return 'current';
    const module = STEP_MODULES[position];
    if (!module) return 'todo';
    if (state.isComplete(module.id)) return 'done';
    if (position < reached && isBlocking(module.id)) return 'error';
    return 'todo';
  }

  function renderRail(): void {
    clear(rail);
    const current = STEP_MODULES[index];
    progressCaption.textContent = current
      ? `Step ${index + 1} of ${STEP_MODULES.length}  ·  ${current.label}`
      : '';
    STEP_MODULES.forEach((module, position) => {
      const reachable = position <= reached;
      const node = el('button', {
        class: 'wizard-dot',
        type: 'button',
        disabled: !reachable,
        dataset: { state: railState(position) },
        attrs: {
          'aria-current': position === index ? 'step' : null,
          'aria-label': `Step ${position + 1}: ${module.label}`,
          title: module.label,
        },
        onClick: () => goTo(position),
      });
      rail.appendChild(node);
    });
  }

  // ---------------------------------------------------------------------
  // Footer
  // ---------------------------------------------------------------------
  function updateFooter(): void {
    const module = STEP_MODULES[index];
    if (!module) return;
    const last = index === STEP_MODULES.length - 1;
    const blocked = isBlocking(module.id) && !(handle?.canAdvance() ?? false);

    backButton.disabled = index === 0 || busy;
    nextButton.textContent = handle?.nextLabel ?? (last ? 'Finish setup' : 'Continue');
    nextButton.disabled = busy || blocked;
    nextButton.title = blocked ? 'Finish this step first.' : '';
  }

  function say(message: string, tone: Tone = 'idle'): void {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  // ---------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------
  const context: StepContext = {
    state,
    body: stepBody,
    refresh: () => {
      renderRail();
      updateFooter();
    },
    next: () => {
      void advance();
    },
    say,
  };

  function renderStep(): void {
    handle?.destroy();
    handle = null;
    clear(stepBody);
    say('');

    const module = STEP_MODULES[index];
    if (!module) return;
    headerTitle.textContent = module.title;
    headerSubtitle.textContent = module.subtitle;
    try {
      handle = module.mount(context);
    } catch (error) {
      // A step that cannot even render must say so on screen. Swallowing this
      // into the footer would leave a blank pane and a disabled Continue, which
      // reads as the app having hung.
      handle = null;
      stepBody.appendChild(
        el(
          'div',
          { class: 'card glass' },
          el('div', { class: 'card-header' }, el('h3', { text: 'This step failed to load' })),
          el('div', { class: 'card-body' }, el('p', { class: 'field-error', text: String(error) })),
        ),
      );
    }

    bodyPane.scrollTop = 0;
    // Focus follows the step so a keyboard user is not left at the top of the
    // rail after every Continue.
    bodyPane.focus();
    renderRail();
    updateFooter();
  }

  function goTo(position: number): void {
    if (busy) return;
    if (position < 0 || position >= STEP_MODULES.length) return;
    // Backwards and to anything already reached is free. Forwards only happens
    // through advance(), which is where the blocking rule lives.
    if (position > reached) return;
    index = position;
    renderStep();
  }

  async function advance(): Promise<void> {
    if (busy) return;
    const module = STEP_MODULES[index];
    if (!module) return;
    if (isBlocking(module.id) && !(handle?.canAdvance() ?? false)) return;

    busy = true;
    updateFooter();
    try {
      const proceed = (await handle?.beforeNext?.()) ?? true;
      if (!proceed) return;

      if (index === STEP_MODULES.length - 1) {
        onComplete();
        return;
      }
      index += 1;
      reached = Math.max(reached, index);
      renderStep();
    } catch (error) {
      say(`That step could not finish: ${String(error)}`, 'bad');
    } finally {
      busy = false;
      updateFooter();
    }
  }

  // ---------------------------------------------------------------------
  // Live updates and shortcuts
  // ---------------------------------------------------------------------
  bag.add(
    window.api.onConfig((next: StoredConfig) => {
      // Keep the rail and the footer honest when main rewrites config, without
      // re-mounting the step and throwing away whatever is half typed in it.
      state.config = next;
      renderRail();
      updateFooter();
    }),
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void advance();
  };
  window.addEventListener('keydown', onKeyDown);
  bag.add(() => window.removeEventListener('keydown', onKeyDown));

  renderStep();

  return () => {
    handle?.destroy();
    handle = null;
    bag.dispose();
  };
}
