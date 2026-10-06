/**
 * The theme state the renderer paints from.
 *
 * HONEST CEILING, and this must not be softened anywhere: Electron cannot
 * render real macOS Liquid Glass. NSGlassEffectView is AppKit and SwiftUI only
 * and is not exposed to Electron. What this app actually uses is native window
 * vibrancy, native traffic lights over its own chrome, CSS backdrop-filter for
 * the surfaces inside the window, and the system theme and accent colour. The
 * result is a convincing translucent macOS app. It is not Liquid Glass.
 *
 * The renderer never reads any of this directly. Main resolves it into one
 * ThemeState and pushes it on nativeTheme changes, on accent changes, and on
 * window focus and blur.
 */

import { nativeTheme, systemPreferences } from 'electron';
import { logger } from '../core/log.ts';
import type { ThemeMode, ThemeState } from '../shared/contract.ts';

const log = logger('theme');

/** macOS default blue, used when the accent colour cannot be read. */
const FALLBACK_ACCENT = '007AFFFF';

interface Appearance {
  mode: ThemeMode;
  /** The setting. Whether it is actually in effect is `vibrancyActive`. */
  vibrancy: boolean;
  forceReduceMotion: boolean;
}

let appearance: Appearance = { mode: 'system', vibrancy: true, forceReduceMotion: false };
let vibrancyActive = false;
let windowFocused = false;
let listeners: ((theme: ThemeState) => void)[] = [];

/**
 * VERIFIED to return 8 hex digits as RGBA with no leading `#`, e.g. "007AFFFF".
 * Only the first 6 are a CSS colour: pasting all 8 into `#…` silently changes
 * the alpha, which is why this is normalised in exactly one place.
 */
function readAccent(): string {
  if (process.platform !== 'darwin') return FALLBACK_ACCENT;
  try {
    const raw = systemPreferences.getAccentColor();
    const cleaned = typeof raw === 'string' ? raw.replace('#', '').trim() : '';
    if (/^[0-9a-fA-F]{6,8}$/.test(cleaned)) return cleaned.padEnd(8, 'F');
  } catch (error) {
    log.debug('getAccentColor failed', error);
  }
  return FALLBACK_ACCENT;
}

function readReducedMotion(): boolean {
  if (appearance.forceReduceMotion) return true;
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion;
  } catch {
    return false;
  }
}

export function currentTheme(): ThemeState {
  const accentRgba = readAccent();
  return {
    dark: nativeTheme.shouldUseDarkColors,
    mode: appearance.mode,
    accentRgba,
    accentHex: `#${accentRgba.slice(0, 6)}`,
    reduceMotion: readReducedMotion(),
    vibrancy: vibrancyActive,
    windowFocused,
  };
}

function publish(): void {
  const theme = currentTheme();
  for (const listener of listeners) {
    try {
      listener(theme);
    } catch (error) {
      log.debug('a theme listener threw', error);
    }
  }
}

/** Subscribe. Main pushes these onto IPC_EVENTS.theme. */
export function onThemeChange(listener: (theme: ThemeState) => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

export function initTheme(initial: { mode: ThemeMode; vibrancy: boolean; reduceMotion: boolean }): void {
  appearance = { mode: initial.mode, vibrancy: initial.vibrancy, forceReduceMotion: initial.reduceMotion };
  nativeTheme.themeSource = initial.mode;

  nativeTheme.on('updated', publish);
  if (process.platform === 'darwin') {
    try {
      systemPreferences.on('accent-color-changed', publish);
    } catch (error) {
      log.debug('could not subscribe to accent-color-changed', error);
    }
  }
}

/** Called when the settings pane changes appearance. Returns the new state. */
export function applyAppearanceSettings(next: { mode: ThemeMode; vibrancy: boolean; reduceMotion: boolean }): ThemeState {
  const changed =
    appearance.mode !== next.mode || appearance.vibrancy !== next.vibrancy || appearance.forceReduceMotion !== next.reduceMotion;
  appearance = { mode: next.mode, vibrancy: next.vibrancy, forceReduceMotion: next.reduceMotion };
  nativeTheme.themeSource = next.mode;
  if (changed) publish();
  return currentTheme();
}

export function setThemeMode(mode: ThemeMode): ThemeState {
  return applyAppearanceSettings({ mode, vibrancy: appearance.vibrancy, reduceMotion: appearance.forceReduceMotion });
}

/** True only when the window was really created with a vibrancy material. */
export function setVibrancyActive(active: boolean): void {
  if (vibrancyActive === active) return;
  vibrancyActive = active;
  publish();
}

export function setWindowFocused(focused: boolean): void {
  if (windowFocused === focused) return;
  windowFocused = focused;
  publish();
}

export function vibrancyWanted(): boolean {
  return appearance.vibrancy && process.platform === 'darwin';
}
