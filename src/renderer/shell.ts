/**
 * The renderer shell.
 *
 * It does four things and nothing else:
 *   1. reflects the theme from main onto <html>, so every rule in the
 *      stylesheet has something to key off,
 *   2. routes on status.setupComplete: wizard or dashboard,
 *   3. swaps one for the other when setup finishes,
 *   4. makes sure the window is draggable even if a view forgets its titlebar.
 *
 * It owns no styling and no application logic. The wizard and the dashboard each
 * render their own .app-shell into the root element handed to them.
 */

import type { RendererView, ThemeState } from '../shared/contract.ts';
import { mountSetup } from './setup/index.ts';
import { mountDashboard } from './dashboard/index.ts';

type Teardown = () => void;

const FALLBACK_ACCENT = '#007aff';

let teardown: Teardown | null = null;
let mounted: 'setup' | 'dashboard' | null = null;
/** A tray navigation that arrived while the wizard was still up. */
let pendingView: RendererView | null = null;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * White or near-black text on top of the accent colour, decided by relative
 * luminance. macOS lets a person pick yellow or graphite as their accent, and
 * white on yellow is unreadable, so this cannot be a constant.
 */
function accentContrast(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const value = Number.parseInt(m[1], 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const linear = channels.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return luminance > 0.55 ? '#1c1c1e' : '#ffffff';
}

function normaliseAccent(hex: string | undefined): string {
  if (typeof hex !== 'string') return FALLBACK_ACCENT;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? `#${m[1].toLowerCase()}` : FALLBACK_ACCENT;
}

function applyTheme(theme: ThemeState): void {
  const root = document.documentElement;
  root.dataset.theme = theme.dark ? 'dark' : 'light';
  root.dataset.vibrancy = theme.vibrancy ? 'on' : 'off';
  root.dataset.focus = theme.windowFocused ? 'on' : 'off';
  root.dataset.motion = theme.reduceMotion ? 'reduced' : 'full';

  const accent = normaliseAccent(theme.accentHex);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-contrast', accentContrast(accent));
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * titleBarStyle is 'hiddenInset', so the window has no native title bar to drag
 * by. If a view renders no .titlebar the window would be stuck in place, which
 * is easy to miss in review and very annoying to live with. One empty bar costs
 * nothing and removes the failure mode.
 */
function ensureDragRegion(root: HTMLElement): void {
  if (root.querySelector('.titlebar')) return;
  const bar = document.createElement('header');
  bar.className = 'titlebar';
  bar.setAttribute('aria-hidden', 'true');
  (root.querySelector('.app-shell') ?? root).prepend(bar);
}

function unmount(): void {
  if (teardown) {
    try {
      teardown();
    } catch (error) {
      console.error('[shell] teardown failed', error);
    }
  }
  teardown = null;
  mounted = null;
}

function mount(root: HTMLElement, view: 'setup' | 'dashboard'): void {
  if (mounted === view) return;
  unmount();
  root.replaceChildren();

  if (view === 'setup') {
    teardown = mountSetup(root, () => {
      // The wizard finished, so completeSetup() has already resolved in main.
      mount(root, 'dashboard');
    });
  } else {
    const initial = pendingView && pendingView !== 'setup' ? pendingView : undefined;
    pendingView = null;
    teardown = mountDashboard(root, initial);
  }

  mounted = view;
  ensureDragRegion(root);
}

/** Preload never ran, so nothing in the app can work. Say so rather than
 *  showing an empty translucent window. */
function renderBridgeFailure(root: HTMLElement): void {
  root.replaceChildren();
  root.innerHTML = `
    <div class="app-shell">
      <header class="titlebar"><h1>slack-code</h1></header>
      <div class="detail">
        <div class="detail-body">
          <div class="empty-state">
            <strong>The app bridge did not load</strong>
            <p>
              The preload script failed, so this window cannot reach the service.
              Quit and relaunch slack-code. If it keeps happening, run
              <span class="code">npm run build</span> and check that
              out/preload/index.cjs exists.
            </p>
          </div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing from index.html');

  if (typeof window.api === 'undefined') {
    renderBridgeFailure(root);
    return;
  }

  const api = window.api;

  // Paint the theme before the first view mounts, so nothing flashes in the
  // wrong colours.
  try {
    applyTheme(await api.getTheme());
  } catch (error) {
    console.error('[shell] initial theme failed', error);
  }
  api.onTheme(applyTheme);

  // A tray click can ask for a view before the dashboard exists.
  api.onNavigate((view) => {
    if (mounted === 'dashboard') return; // the dashboard handles its own routing
    pendingView = view;
  });

  let setupComplete = false;
  try {
    setupComplete = (await api.getStatus()).setupComplete;
  } catch (error) {
    console.error('[shell] initial status failed', error);
  }
  mount(root, setupComplete ? 'dashboard' : 'setup');

  // Setup can also be completed or reset from outside this window, for example
  // by a config import. Follow it either way.
  api.onStatus((status) => {
    const wanted = status.setupComplete ? 'dashboard' : 'setup';
    if (mounted !== wanted) mount(root, wanted);
  });
}

void boot().catch((error: unknown) => {
  console.error('[shell] boot failed', error);
});
