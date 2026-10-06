/**
 * The step registry, ordered to match SETUP_STEPS from the shared contract.
 *
 * The order is derived rather than retyped: SETUP_STEPS is the source of truth
 * for which steps exist and in what order, and the sort below fails loudly at
 * boot if a step is missing rather than quietly rendering nine of ten.
 */

import { SETUP_STEPS } from '../../../shared/contract.ts';
import type { SetupStepId } from '../../../shared/contract.ts';
import type { StepModule } from './types.ts';

import { agentStep } from './agent.ts';
import { finishStep } from './finish.ts';
import { handshakeStep } from './handshake.ts';
import { operatorsStep } from './operators.ts';
import { probeStep } from './probe.ts';
import { projectStep } from './project.ts';
import { slackAppStep } from './slack-app.ts';
import { appTokenStep, botTokenStep } from './token-step.ts';
import { welcomeStep } from './welcome.ts';

const MODULES: StepModule[] = [
  welcomeStep,
  slackAppStep,
  botTokenStep,
  appTokenStep,
  operatorsStep,
  handshakeStep,
  projectStep,
  agentStep,
  probeStep,
  finishStep,
];

function moduleFor(id: SetupStepId): StepModule {
  const found = MODULES.find((module) => module.id === id);
  if (!found) throw new Error(`No wizard step implements "${id}"`);
  return found;
}

export const STEP_MODULES: StepModule[] = SETUP_STEPS.map(moduleFor);

export type { StepContext, StepHandle, StepModule } from './types.ts';
