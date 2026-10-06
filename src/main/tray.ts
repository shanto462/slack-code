/**
 * The menu-bar item. For most of the app's life this is the entire UI.
 *
 * The Tray object is held at module scope on purpose: a dropped reference gets
 * garbage collected and the icon silently disappears from the menu bar.
 *
 * Icons must be TEMPLATE images so macOS inverts them for light and dark menu
 * bars, and macOS only treats a file as a template if its NAME ends in
 * "Template". If the build asset is missing the icon is drawn in code rather
 * than left empty, because an invisible tray icon means an app with no way to
 * open its own window.
 */

import { Menu, Tray, app, nativeImage, shell, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../core/log.ts';
import type { DaemonStatus, ServiceState } from '../shared/contract.ts';
import { assetRoot, logFilePath } from './paths.ts';
import { showWindow } from './window.ts';

const log = logger('tray');

let tray: Tray | null = null;

export interface TrayActions {
  start: () => void;
  stop: () => void;
  quit: () => void;
}

const STATE_LABEL: Record<ServiceState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  error: 'Not running',
};

function iconCandidates(): string[] {
  const root = assetRoot();
  return [
    join(root, 'trayTemplate.png'),
    join(root, 'build', 'trayTemplate.png'),
    join(root, 'resources', 'trayTemplate.png'),
  ];
}

/**
 * A 32x32 (16pt at 2x) speech bubble, black with an alpha mask, which is
 * exactly what a template image is. Supersampled 3x3 so the curves are not
 * jagged next to the system's own menu-bar glyphs.
 */
function drawFallbackIcon(): NativeImage {
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);

  const inRoundedRect = (x: number, y: number): boolean => {
    const x0 = 3;
    const y0 = 4;
    const x1 = 29;
    const y1 = 23;
    const r = 6.5;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  // A short tail under the left of the bubble, so it reads as a message rather
  // than a generic rounded square.
  const inTail = (x: number, y: number): boolean => {
    if (y < 22 || y > 29) return false;
    const spread = (29 - y) * 1.1;
    return x >= 8 && x <= 8 + spread + 2;
  };

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const x = px + (sx + 0.5) / 3;
          const y = py + (sy + 0.5) / 3;
          if (inRoundedRect(x, y) || inTail(x, y)) hits += 1;
        }
      }
      const offset = (py * size + px) * 4;
      // Black with coverage in the alpha channel. Colour is irrelevant for a
      // template image, so channel order does not matter here.
      buffer[offset + 3] = Math.round((hits / 9) * 255);
    }
  }

  return nativeImage.createFromBitmap(buffer, { width: size, height: size, scaleFactor: 2 });
}

function loadIcon(): NativeImage {
  for (const candidate of iconCandidates()) {
    if (!existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) {
      image.setTemplateImage(true);
      return image;
    }
  }
  log.debug('no trayTemplate.png found, drawing the menu-bar icon in code');
  const drawn = drawFallbackIcon();
  drawn.setTemplateImage(true);
  return drawn;
}

function summarise(status: DaemonStatus): string {
  const base = STATE_LABEL[status.state] ?? status.state;
  if (status.state === 'connected') {
    const busy = status.activeThreads.filter((thread) => thread.busy).length;
    const identity = status.identity ? ` as ${status.identity.botName}` : '';
    return busy > 0 ? `${base}${identity}, ${busy} turn${busy === 1 ? '' : 's'} running` : `${base}${identity}`;
  }
  return status.detail ? `${base}: ${status.detail}` : base;
}

export function createTray(actions: TrayActions, status: DaemonStatus): void {
  if (tray) return;
  tray = new Tray(loadIcon());
  tray.setToolTip('slack-code');
  updateTray(actions, status);
}

export function updateTray(actions: TrayActions, status: DaemonStatus): void {
  if (!tray) return;

  const running = status.state !== 'stopped' && status.state !== 'error';
  const summary = summarise(status);

  const template: MenuItemConstructorOptions[] = [
    { label: summary, enabled: false },
    { type: 'separator' },
    { label: 'Open dashboard', click: () => showWindow('dashboard') },
    { label: 'Projects', click: () => showWindow('projects') },
    { type: 'separator' },
    running
      ? { label: 'Pause the bridge', click: actions.stop }
      : { label: 'Start the bridge', click: actions.start },
    { type: 'separator' },
    { label: 'Logs', click: () => showWindow('logs') },
    { label: 'Reveal log file', click: () => shell.showItemInFolder(logFilePath()) },
    { label: 'Diagnostics', click: () => showWindow('diagnostics') },
    { label: 'Settings', click: () => showWindow('settings') },
    { type: 'separator' },
    { label: `Quit ${app.getName()}`, click: actions.quit },
  ];

  tray.setToolTip(`slack-code · ${summary}`);
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
