/**
 * "Run at login", backed by app.setLoginItemSettings.
 *
 * Three rules, each of which is a real trap:
 *
 *  - `openAsHidden` is NOT used. It is deprecated and does nothing on macOS 13
 *    and up. Starting quietly is decided from `wasOpenedAtLogin` instead.
 *  - `status` is read, not just `openAtLogin`. On macOS 13+ this is
 *    SMAppService-backed and the user can deny the item in System Settings.
 *    `requires-approval` is precisely the state where the app believes it is
 *    enabled and macOS will not honour it, so a toggle that only reads
 *    `openAtLogin` lies to the operator.
 *  - The toggle is gated on app.isPackaged. Unpackaged, the status is
 *    'not-found' and registering would register the Electron helper binary
 *    rather than this app.
 */

import { app } from 'electron';
import { logger } from '../core/log.ts';
import type { LoginItemState } from '../shared/contract.ts';

const log = logger('autostart');

function supported(): boolean {
  return app.isPackaged && process.platform === 'darwin';
}

export function loginItemState(): LoginItemState {
  if (!app.isPackaged) {
    return { enabled: false, status: 'not-found', supported: false, wasOpenedAtLogin: false };
  }
  try {
    const settings = app.getLoginItemSettings();
    return {
      enabled: settings.openAtLogin,
      status: settings.status ?? (settings.openAtLogin ? 'enabled' : 'not-registered'),
      supported: supported(),
      wasOpenedAtLogin: settings.wasOpenedAtLogin === true,
    };
  } catch (error) {
    log.warn('could not read the login item settings', error);
    return { enabled: false, status: 'not-found', supported: supported(), wasOpenedAtLogin: false };
  }
}

export function setLoginItem(enabled: boolean): LoginItemState {
  if (!supported()) {
    log.info(`ignoring the run-at-login toggle: ${app.isPackaged ? 'unsupported platform' : 'only works in a packaged build'}`);
    return loginItemState();
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch (error) {
    log.warn('could not change the login item settings', error);
  }
  const state = loginItemState();
  if (enabled && state.status === 'requires-approval') {
    log.warn('macOS registered the login item but it needs approval in System Settings > General > Login Items');
  }
  return state;
}

/**
 * True when macOS started the app at login. Quiet start hangs off this, and
 * NOT off the deprecated wasOpenedAsHidden.
 */
export function openedAtLogin(): boolean {
  if (!app.isPackaged) return false;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}
