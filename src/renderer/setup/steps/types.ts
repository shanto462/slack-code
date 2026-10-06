/**
 * The contract between the wizard shell and one step.
 *
 * A step renders into `ctx.body`, tells the shell whether Continue may light up,
 * and hands back one destroy(). It never touches the rail, the footer buttons or
 * the navigation, so a step can be read and changed on its own.
 */

import type { SetupStepId } from '../../../shared/contract.ts';
import type { Tone } from '../ui.ts';
import type { WizardState } from '../wizard-state.ts';

export interface StepContext {
  state: WizardState;
  /** The scrolling region a step owns outright. */
  body: HTMLElement;
  /** Re-evaluate the footer: Continue enabled or not, and the rail's step states. */
  refresh(): void;
  /** Move to the next step, as if Continue had been clicked. */
  next(): void;
  /** One short line in the footer's polite live region. */
  say(message: string, tone?: Tone): void;
}

export interface StepHandle {
  destroy(): void;
  /** False greys out Continue. Only enforced for SETUP_BLOCKING_STEPS. */
  canAdvance(): boolean;
  /** Overrides the primary button label, e.g. "Finish setup". */
  nextLabel?: string;
  /**
   * Last chance to do work before leaving, e.g. add the project the operator
   * typed but did not click Add on. Returning false cancels the navigation and
   * leaves the reason on screen.
   */
  beforeNext?(): Promise<boolean>;
}

export interface StepModule {
  id: SetupStepId;
  /** Short label for the rail. */
  label: string;
  /** Heading above the step body. */
  title: string;
  subtitle: string;
  /** Shows a Skip button. Only ever true for steps outside SETUP_BLOCKING_STEPS. */
  skippable?: boolean;
  mount(ctx: StepContext): StepHandle;
}
