/**
 * The one app window.
 *
 * It genuinely does not exist most of the time: this is a menu-bar app that
 * runs a Slack bridge, and the window is the settings and dashboard surface.
 * Two consequences run through this file. Closing the window HIDES it rather
 * than quitting, and every main-to-renderer send has to tolerate there being no
 * window at all.
 */

import { BrowserWindow, app, nativeTheme, shell } from 'electron';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../core/log.ts';
import { IPC_EVENTS, WINDOW_VIBRANCY, type RendererView } from '../shared/contract.ts';
import { setVibrancyActive, setWindowFocused, vibrancyWanted } from './theme.ts';

const log = logger('window');

let win: BrowserWindow | null = null;
let quitting = false;
/** From AppSettings.menuBarOnly. Decides whether hiding the window leaves the Dock. */
let menuBarOnly = true;

/** Set from before-quit so `close` stops intercepting. */
export function setQuitting(value: boolean): void {
  quitting = value;
}

export function mainWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Send to the renderer if there is one. Every push in the app goes through
 * here, including log lines, so a failure must NOT be logged: that would turn
 * one dead window into an endless log-send-log loop.
 */
export function send(channel: string, payload?: unknown): void {
  const target = mainWindow();
  if (!target) return;
  if (target.webContents.isDestroyed()) return;
  try {
    target.webContents.send(channel, payload);
  } catch {
    // The window went away between the check and the send. Nothing to do, and
    // nothing safe to say about it.
  }
}

function preloadPath(): string {
  return fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
}

function rendererIndexPath(): string {
  return fileURLToPath(new URL('../renderer/index.html', import.meta.url));
}

function loadRenderer(target: BrowserWindow): void {
  // electron-vite sets ELECTRON_RENDERER_URL in dev so the renderer comes from
  // the dev server with HMR. Packaged builds have no such variable.
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    void target.loadURL(devUrl);
    return;
  }
  const file = rendererIndexPath();
  if (!existsSync(file)) {
    log.error(`renderer bundle missing at ${file}. Run "npm run build" first.`);
  }
  void target.loadFile(file);
}

export function createWindow(): BrowserWindow {
  const existing = mainWindow();
  if (existing) return existing;

  const useVibrancy = vibrancyWanted();

  win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    // The traffic lights float over OUR titlebar, so they have to be told about
    // it. Left alone, hiddenInset positions them for the toolbar height macOS
    // assumes, which centres them near y=18. Our bar is --titlebar-h (52), so
    // its title and state pill centre at 26 and the buttons sit a visible 7px
    // high of everything beside them.
    //
    // Only `y` is doing real work: 20 is (52 - 12) / 2, the top of a 12px button
    // centred in a bar of --titlebar-h. Change one and the other has to follow.
    //
    // `x` is required by the type but is NOT a reliable way to place the cluster
    // horizontally: measured against a known padding, setting it did not move
    // the left edge the way the name suggests. So the horizontal clearance is
    // owned by .titlebar's padding-inline-start instead, which only moves our
    // own content. Do not try to tune the gap from here.
    trafficLightPosition: { x: 20, y: 20 },
    // With vibrancy on, the background MUST be fully transparent or the native
    // material never shows through. With it off we want a real opaque colour,
    // otherwise the window renders as a hole, and it has to match the theme or
    // the first paint flashes the wrong shade.
    backgroundColor: useVibrancy ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7',
    ...(useVibrancy
      ? {
          vibrancy: WINDOW_VIBRANCY,
          // Without this the blur goes flat and grey whenever the window is not
          // focused, which is most of the time for a background utility.
          visualEffectState: 'active' as const,
        }
      : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  setVibrancyActive(useVibrancy);

  win.once('ready-to-show', () => {
    // Showing before the first paint gives a white flash, which is especially
    // ugly against a translucent window.
    win?.show();
  });

  win.on('focus', () => setWindowFocused(true));
  win.on('blur', () => setWindowFocused(false));

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
    // Drop out of the Dock while no window is up. setActivationPolicy is used
    // rather than app.dock.hide() because hide() does nothing if it is called
    // within a second of a previous call, and showing then hiding a settings
    // window is exactly that sub-second pattern.
    if (process.platform === 'darwin' && menuBarOnly) app.setActivationPolicy('accessory');
  });

  win.on('closed', () => {
    win = null;
    setWindowFocused(false);
  });

  // Anything the page tries to open in a new window goes to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The renderer is a fixed local bundle. Navigating it anywhere else is either
  // a bug or an injection, so it is refused either way.
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      log.warn(`blocked renderer navigation to ${url}`);
    }
  });

  loadRenderer(win);
  return win;
}

export function setMenuBarOnly(value: boolean): void {
  menuBarOnly = value;
  if (process.platform !== 'darwin') return;
  if (!value) app.setActivationPolicy('regular');
  else if (!mainWindow()?.isVisible()) app.setActivationPolicy('accessory');
}

/** Show the window, creating it if needed, and optionally jump to a view. */
export function showWindow(view?: RendererView): void {
  if (process.platform === 'darwin') app.setActivationPolicy('regular');

  const target = mainWindow() ?? createWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();

  if (view) {
    // The window may still be loading, in which case the renderer would miss
    // the event entirely.
    if (target.webContents.isLoading()) {
      target.webContents.once('did-finish-load', () => send(IPC_EVENTS.navigate, view));
    } else {
      send(IPC_EVENTS.navigate, view);
    }
  }
}

export function toggleWindow(): void {
  const target = mainWindow();
  if (target?.isVisible() && target.isFocused()) {
    target.hide();
    if (process.platform === 'darwin' && menuBarOnly) app.setActivationPolicy('accessory');
    return;
  }
  showWindow();
}
