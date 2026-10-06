/**
 * Shared, mutable wizard state, plus the rule for where a half-finished setup
 * resumes.
 *
 * Two sources of truth, deliberately:
 *
 *   config.json + the secret store   for everything that leaves a trace: a
 *                                    stored token, a resolved allowlist, a
 *                                    project, the handshake timestamp. These
 *                                    are re-read on mount, so a wizard resumed
 *                                    after a quit sees the real state and never
 *                                    a stale draft.
 *   a small local record             for the steps that leave no trace: the
 *                                    welcome and manifest screens, the
 *                                    deliberate permission-mode choice, and a
 *                                    skipped optional step.
 *
 * The local record is a convenience, never a correctness input. If it is
 * unreadable the wizard simply restarts at the welcome step, which is annoying
 * for two clicks and wrong for nothing.
 */

import type {
  AppInfo,
  DeepPartial,
  Result,
  SecretsStatus,
  SetupStepId,
  SlackIdentity,
  StoredConfig,
} from '../../shared/contract.ts';
import { SETUP_STEPS } from '../../shared/contract.ts';

const PROGRESS_KEY = 'slack-code.setup.progress';

interface Progress {
  /** Steps finished or skipped that leave nothing behind in config.json. */
  acknowledged: SetupStepId[];
}

/**
 * Fallback for the case where localStorage throws. A packaged renderer loads
 * from file://, and Chromium's rules for storage on file:// have moved before.
 * Keeping the value in memory means the wizard still behaves correctly for the
 * length of one window even when nothing can be persisted.
 */
let memoryProgress: Progress = { acknowledged: [] };

function readProgress(): Progress {
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { ...memoryProgress };
    const parsed = JSON.parse(raw) as Partial<Progress>;
    const acknowledged = Array.isArray(parsed.acknowledged)
      ? parsed.acknowledged.filter((step): step is SetupStepId => SETUP_STEPS.includes(step as SetupStepId))
      : [];
    return { acknowledged };
  } catch {
    return { ...memoryProgress };
  }
}

function writeProgress(progress: Progress): void {
  memoryProgress = { acknowledged: [...progress.acknowledged] };
  try {
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Nothing to do. The in-memory copy above already keeps this window honest.
  }
}

export class WizardState {
  config: StoredConfig;
  secrets: SecretsStatus;
  info: AppInfo;
  private progress: Progress;

  constructor(config: StoredConfig, secrets: SecretsStatus, info: AppInfo) {
    this.config = config;
    this.secrets = secrets;
    this.info = info;
    this.progress = readProgress();
  }

  static async load(): Promise<WizardState> {
    const [config, secrets, info] = await Promise.all([
      window.api.getConfig(),
      window.api.secretsStatus(),
      window.api.appInfo(),
    ]);
    return new WizardState(config, secrets, info);
  }

  async reload(): Promise<void> {
    const [config, secrets] = await Promise.all([window.api.getConfig(), window.api.secretsStatus()]);
    this.config = config;
    this.secrets = secrets;
  }

  /** Persist a non-secret answer and keep the local copy in step with what main stored. */
  async save(patch: DeepPartial<StoredConfig>): Promise<Result<StoredConfig>> {
    const result = await window.api.saveConfig(patch);
    if (result.ok) this.config = result.value;
    return result;
  }

  async refreshSecrets(): Promise<void> {
    this.secrets = await window.api.secretsStatus();
  }

  get identity(): SlackIdentity | undefined {
    return this.config.slack.workspace;
  }

  get resolvedOperators(): number {
    return this.config.slack.allowed.filter((entry) => Boolean(entry.id)).length;
  }

  get enabledProjects(): StoredConfig['projects'] {
    return this.config.projects.filter((project) => project.enabled);
  }

  acknowledge(step: SetupStepId): void {
    if (this.progress.acknowledged.includes(step)) return;
    this.progress.acknowledged.push(step);
    writeProgress(this.progress);
  }

  isAcknowledged(step: SetupStepId): boolean {
    return this.progress.acknowledged.includes(step);
  }

  /**
   * Is this step satisfied? Config-derived wherever there is a real trace, so a
   * token stored in an earlier run counts even though this window never saw it.
   */
  isComplete(step: SetupStepId): boolean {
    switch (step) {
      case 'welcome':
      case 'slackApp':
        return this.isAcknowledged(step);
      case 'botToken':
        return this.secrets.bot.present && Boolean(this.config.slack.workspace);
      case 'appToken':
        return this.secrets.app.present;
      case 'operators':
        return this.resolvedOperators > 0;
      case 'handshake':
        return Boolean(this.config.slack.eventsVerifiedAt) || this.isAcknowledged('handshake');
      case 'project':
        return this.config.projects.length > 0;
      case 'agent':
        // A permission mode is a real authority grant, and config.json always
        // holds one because DEFAULT_CONFIG has to. So the only honest signal
        // that the operator actually chose is that they were on this step and
        // clicked. Losing the signal costs one extra click, never a wrong mode.
        return this.isAcknowledged('agent');
      case 'probe':
        return this.isAcknowledged('probe');
      case 'finish':
        return Boolean(this.config.setupCompletedAt);
      default:
        return false;
    }
  }

  /** Where a resumed wizard opens: the first step that is not satisfied. */
  resumeIndex(): number {
    const index = SETUP_STEPS.findIndex((step) => !this.isComplete(step));
    return index === -1 ? SETUP_STEPS.length - 1 : index;
  }
}
