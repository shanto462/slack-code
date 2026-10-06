/**
 * `--doctor` and `--selftest`, run inside Electron with no window.
 *
 * They stay inside Electron rather than being separate node scripts because
 * they need safeStorage to decrypt the tokens, and safeStorage only exists in
 * an Electron main process.
 *
 * Neither takes the single-instance lock. Doctor only reads, and selftest opens
 * no Socket Mode connection of its own, so both are safe to run while the app
 * is up. Taking the lock would make them refuse to run whenever the app was
 * open, which is exactly when someone reaches for them.
 */

import { app } from 'electron';
import { logger, setDebug } from '../core/log.ts';
import type { SetupCheckResult } from '../shared/contract.ts';
import { MainApp } from './app.ts';
import { buildConfigFromEnv, findEnvCandidate } from './migrate.ts';
import { importLegacyState } from '../core/storage.ts';

const log = logger('headless');

/**
 * app.whenReady() never resolves without a window server session, for instance
 * over plain ssh. Waiting forever there looks like a hang with no output, so it
 * is bounded and reported.
 */
const READY_TIMEOUT_MS = 20_000;

export type HeadlessMode = 'doctor' | 'selftest' | 'import-env';

export function headlessMode(argv: string[]): HeadlessMode | null {
  if (argv.includes('--doctor')) return 'doctor';
  if (argv.includes('--selftest')) return 'selftest';
  if (argv.includes('--import-env')) return 'import-env';
  return null;
}

/** `--project=writings` picks which project the selftest runs in. */
function projectArg(argv: string[]): string | undefined {
  const inline = argv.find((entry) => entry.startsWith('--project='));
  if (inline) return inline.slice('--project='.length);
  const index = argv.indexOf('--project');
  return index >= 0 ? argv[index + 1] : undefined;
}

async function waitForReady(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
  });
  const ready = app.whenReady().then(() => true);
  const result = await Promise.race([ready, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

function printCheck(check: SetupCheckResult): void {
  const tag = check.ok ? 'ok  ' : check.severity === 'warning' ? 'warn' : 'FAIL';
  const timing = check.durationMs !== undefined && check.durationMs > 250 ? ` (${(check.durationMs / 1000).toFixed(1)}s)` : '';
  console.log(`${tag}  ${check.label}: ${check.detail}${timing}`);
  if (!check.ok && check.hint) console.log(`      ${check.hint}`);
}

async function doctor(instance: MainApp): Promise<number> {
  console.log('slack-code doctor');
  console.log('');

  if (instance.configProblem) console.log(`warn  config: ${instance.configProblem}`);

  const checks = await instance.runAllChecks();
  for (const check of checks) printCheck(check);

  const failures = checks.filter((check) => !check.ok && check.severity === 'error');
  console.log('');

  // Checks that need a value skip themselves when it is absent, so a fresh
  // install used to print an unbroken column of "ok" and exit 0. Technically
  // every check that could run did run; in practice it read as "configured and
  // healthy" to someone who had configured nothing.
  const missing: string[] = [];
  if (!instance.hasTokens()) missing.push('Slack tokens');
  if (instance.config.slack.allowed.length === 0) missing.push('operators');
  if (instance.config.projects.length === 0) missing.push('projects');

  if (missing.length > 0) {
    console.log(`Not set up yet: no ${missing.join(', no ')}.`);
    console.log('The checks above only cover what is present, so they are not a clean bill of health.');
    console.log('Open the app to run setup, or import an existing .env with:  electron . --import-env');
    return 1;
  }

  if (failures.length === 0) {
    console.log('Everything the app can verify from here is in order.');
  } else {
    console.log(`${failures.length} check${failures.length === 1 ? '' : 's'} failed.`);
  }

  if (!instance.config.slack.eventsVerifiedAt) {
    console.log('');
    console.log('Nothing here can prove DMs are actually delivered. If the bridge starts but DMs never arrive,');
    console.log('the remaining piece is always the Slack app itself:');
    console.log('  api.slack.com/apps -> your app -> Event Subscriptions -> Subscribe to bot events -> add "message.im"');
    console.log('  then reinstall the app to the workspace, and run the handshake step in the app to confirm it.');
  }

  return failures.length > 0 ? 1 : 0;
}

async function selftest(instance: MainApp, wanted: string | undefined): Promise<number> {
  const projects = instance.config.projects;
  if (projects.length === 0) {
    console.log('FAIL  no projects are configured, so there is nothing to run a turn against.');
    return 1;
  }

  const project = wanted
    ? projects.find((entry) => entry.alias === wanted || entry.aliases.includes(wanted) || entry.id === wanted)
    : (projects.find((entry) => entry.enabled) ?? projects[0]);

  if (!project) {
    console.log(`FAIL  no project matches "${wanted}". Known aliases: ${projects.map((entry) => entry.alias).join(', ')}`);
    return 1;
  }

  console.log(`slack-code selftest against ${project.name} (${project.alias}) in ${project.dir}`);
  const result = await instance.selftest(project.id);

  if (!result.ok) {
    console.log(`FAIL  ${result.error}`);
    return 1;
  }
  const value = result.value;
  console.log(`${value.ok ? 'ok  ' : 'FAIL'}  ${value.detail}`);
  console.log(`      thread ${value.threadTs} in ${value.channel}, ${(value.durationMs / 1000).toFixed(1)}s`);
  return value.ok ? 0 : 1;
}

/**
 * Satisfies `Promise<never>` after app.exit() without unwinding the caller.
 *
 * app.exit() SCHEDULES termination, it does not return control the way its name
 * suggests, so code placed after it really does run. Throwing there propagated
 * out of runHeadless into bootstrap()'s catch in index.ts, which logged
 * "fatal error during startup: unreachable" at the end of every doctor and
 * selftest run and then called app.quit() on a process that was already
 * exiting. A promise that never settles types the same and stays quiet.
 */
function exiting(): Promise<never> {
  return new Promise<never>(() => {});
}

/**
 * `--import-env`: adopt a legacy .env and its .state/threads.json without going
 * through the wizard. The wizard offers the same import interactively; this is
 * the same path for a machine that is already configured and just needs to come
 * across, or for setting the app up over a terminal.
 *
 * Neither the .env nor the legacy JSON is deleted afterwards. They stay as the
 * rollback.
 */
async function importEnv(instance: MainApp): Promise<number> {
  const candidate = findEnvCandidate();
  if (!candidate) {
    console.error('No legacy .env found. Looked at SLACK_CODE_ENV_FILE, the working directory, and userData.');
    return 1;
  }

  console.log(`Importing ${candidate.envPath}`);
  const { config, botToken, appToken, notes } = buildConfigFromEnv(instance.config, candidate);
  for (const note of notes) console.log(`  note: ${note}`);

  // An imported .env is a completed setup: it carries tokens, operators, and a
  // project. Without this the app starts, finds a full config, and still refuses
  // to connect because the wizard never ran.
  const saved = await instance.saveConfig({ ...config, setupCompletedAt: new Date().toISOString() });
  if (!saved.ok) {
    console.error(`Could not save the imported settings: ${saved.error}`);
    return 1;
  }
  console.log(`  settings written, ${saved.value.projects.length} project(s)`);
  for (const project of saved.value.projects) {
    console.log(`    ${project.alias} -> ${project.dir}`);
  }

  if (botToken || appToken) {
    const stored = await instance.setSecrets({
      ...(botToken ? { botToken } : {}),
      ...(appToken ? { appToken } : {}),
    });
    if (!stored.ok) {
      // Worth failing on: without tokens the app cannot connect, and a silent
      // partial import would look like success until the first turn.
      console.error(`Could not store the tokens: ${stored.error}`);
      return 1;
    }
    const shown = (entry: { present: boolean; hint?: string }) => (entry.present ? (entry.hint ?? 'set') : 'missing');
    console.log(`  tokens encrypted (bot: ${shown(stored.value.bot)}, app: ${shown(stored.value.app)})`);
    if (!stored.value.writable) {
      console.log('  WARNING: safeStorage is not writable here, so these tokens will not survive a quit.');
    }
  }

  if (candidate.legacyStatePath) {
    // saveConfig already runs the legacy import once projects exist, so this is
    // a second, idempotent pass that only reports anything on the rare path
    // where the first one had no project to bind threads to.
    const report = importLegacyState(instance.storage, candidate.legacyStatePath, saved.value.projects);
    if (report.threads > 0 || report.cursors > 0) {
      console.log(`  threads imported: ${report.threads}, cursors: ${report.cursors} (bound ${report.bound}, unbound ${report.unbound})`);
    }
    console.log(`  thread history is in SQLite; ${candidate.legacyStatePath} left in place as the rollback`);
  }

  console.log('Import complete. Run --doctor to check it, then start the app.');
  return 0;
}

/** Runs the mode and exits the process. Never returns. */
export async function runHeadless(mode: HeadlessMode, argv: string[]): Promise<never> {
  setDebug(argv.includes('--debug'));

  const ready = await waitForReady();
  if (!ready) {
    console.error('This session has no window server, so Electron never finished starting.');
    console.error('The stored tokens are encrypted with safeStorage, which only works in a real desktop session,');
    console.error('so run this from a terminal on the logged-in Mac rather than over ssh.');
    app.exit(2);
    return exiting();
  }

  let code = 1;
  let instance: MainApp | null = null;
  try {
    instance = await MainApp.boot({ instanceLockHeld: 'unknown', headless: true });
    if (mode === 'doctor') code = await doctor(instance);
    else if (mode === 'import-env') code = await importEnv(instance);
    else code = await selftest(instance, projectArg(argv));
  } catch (error) {
    log.error(`${mode} failed`, error);
    console.error(error instanceof Error ? error.message : String(error));
    code = 1;
  } finally {
    await instance?.dispose().catch(() => undefined);
  }

  app.exit(code);
  return exiting();
}
