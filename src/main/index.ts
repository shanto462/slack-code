/**
 * Boot order, and why each step is where it is.
 *
 *  1. app.setName BEFORE any getPath call, or userData and the log directory
 *     resolve differently in dev and packaged builds.
 *  2. The --doctor / --selftest branch, BEFORE the single-instance lock. Those
 *     modes open no Socket Mode connection, so they cannot cause the problem
 *     the lock exists to prevent, and taking it would make them refuse to run
 *     whenever the app is open, which is exactly when they get reached for.
 *  3. The single-instance lock. This is a correctness control, not a nicety:
 *     the inbound dedupe set is per process, so two copies on one app token
 *     each receive every DM and each run it. Note its limit: it defends against
 *     a second copy of THIS app only, not against the old launchd daemon and
 *     not against `npm run dev` while the packaged app is open. Both of those
 *     are covered by checks instead.
 *  4. repairEnvironment BEFORE anything can spawn an agent.
 *  5. The application menu, which is mandatory rather than decoration: setup
 *     requires PASTING Slack tokens, and without an Edit menu Cmd+V never
 *     reaches the renderer.
 *
 * There is no process.exit anywhere in this file. In an Electron main process
 * it skips before-quit, so a config error would kill the window with no message
 * and leave the database unflushed.
 */

import { Menu, app } from 'electron';
import { logger } from '../core/log.ts';
import { type RendererView, IPC_EVENTS } from '../shared/contract.ts';
import { MainApp } from './app.ts';
import { openedAtLogin } from './autostart.ts';
import { repairEnvironment } from './env.ts';
import { headlessMode, runHeadless } from './headless.ts';
import { registerIpc, unregisterIpc } from './ipc.ts';
import { createTray, destroyTray, updateTray } from './tray.ts';
import { initTheme, onThemeChange } from './theme.ts';
import { createWindow, send, setQuitting, showWindow } from './window.ts';

const log = logger('main');

let instance: MainApp | null = null;
let cleanedUp = false;

app.setName('slack-code');
try {
  // Without this, app.getPath('logs') resolves to .../Logs/Electron.
  app.setAppLogsPath();
} catch {
  // Only affects where the text log lands; everything else still works.
}

function buildMenu(): void {
  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  if (!app.isPackaged) {
    template.splice(2, 0, {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/*
 * A window must never open before registerIpc() has run.
 *
 * Both `activate` and `second-instance` call showWindow(), and both are live
 * well before bootstrap reaches registerIpc: `activate` is subscribed at module
 * scope, `second-instance` a few lines after the lock. Clicking the dock icon
 * or launching a second copy during startup therefore opened a window whose
 * very first IPC call had no handler, and the renderer reported
 * "No handler registered for 'config:get'" over an app that was otherwise fine.
 *
 * Requests that arrive early are remembered and honoured once boot finishes,
 * rather than dropped, so the click still does what the user meant.
 */
let ipcReady = false;
let pendingShow: RendererView | true | null = null;

function requestWindow(view?: RendererView): void {
  if (!ipcReady) {
    // A specific view wins over a bare activate.
    if (view || pendingShow === null) pendingShow = view ?? true;
    return;
  }
  showWindow(view);
}

async function shutdown(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  ipcReady = false;
  unregisterIpc();
  destroyTray();
  await instance?.dispose();
  instance = null;
}

async function bootstrap(): Promise<void> {
  const mode = headlessMode(process.argv);
  if (mode) {
    await runHeadless(mode, process.argv);
    return;
  }

  const lockHeld = app.requestSingleInstanceLock();
  if (!lockHeld) {
    log.warn('another copy of slack-code is already running, handing over to it');
    app.quit();
    return;
  }

  app.on('second-instance', () => requestWindow());

  repairEnvironment();

  await app.whenReady();
  buildMenu();

  instance = await MainApp.boot({ instanceLockHeld: lockHeld, headless: false });
  const running = instance;

  initTheme({
    mode: running.config.app.themeMode,
    vibrancy: running.config.app.vibrancy,
    reduceMotion: running.config.app.reduceMotion,
  });
  onThemeChange((theme) => send(IPC_EVENTS.theme, theme));

  registerIpc(running, { quit: () => app.quit() });
  ipcReady = true;

  const trayActions = {
    start: () => void running.startService(),
    stop: () => void running.stopService(),
    quit: () => app.quit(),
  };
  createTray(trayActions, running.status());
  running.onStatus((status) => updateTray(trayActions, status));

  // Quiet start only applies to a packaged app that macOS launched at login,
  // and never when setup is unfinished: a login-item launch that silently did
  // nothing would be invisible and unexplainable.
  const setupComplete = Boolean(running.config.setupCompletedAt);
  const quiet = app.isPackaged && openedAtLogin() && setupComplete;
  const queued = pendingShow;
  pendingShow = null;
  if (queued) {
    // Someone asked for the window while we were still booting.
    showWindow(queued === true ? (setupComplete ? undefined : 'setup') : queued);
  } else if (quiet) log.info('started by the login item, staying in the menu bar');
  else if (setupComplete) createWindow();
  else showWindow('setup');

  if (setupComplete && running.config.app.connectOnLaunch) {
    const started = await running.startService();
    if (!started.ok) log.error(`the bridge did not start: ${started.error}`);
  } else if (!setupComplete) {
    log.info('setup has not been completed yet, so the bridge is not starting');
  }

  running.pushStatus();
}

// Closing the settings window must not kill the Slack bridge. The listener is
// subscribed even though the body is empty: without it, Electron's default
// behaviour quits the app when the last window closes.
app.on('window-all-closed', () => {
  // Deliberately empty.
});

app.on('activate', () => requestWindow());

app.on('before-quit', (event) => {
  setQuitting(true);
  if (cleanedUp) return;
  event.preventDefault();
  void shutdown()
    .catch((error: unknown) => log.error('shutdown failed', error))
    .finally(() => app.quit());
});

// Belt and braces: if anything ever quits without before-quit running, the
// database still gets closed.
app.on('will-quit', () => {
  void shutdown();
});

bootstrap().catch((error: unknown) => {
  log.error('fatal error during startup', error);
  // Still a graceful quit, so storage closes and before-quit runs.
  app.quit();
});
