/**
 * The contract between the dashboard shell and its five panes.
 *
 * A pane renders into its own element, is told when shared state changed, and
 * is torn down by exactly one `destroy()`. It never reaches for `window.api`
 * itself: everything arrives through `Ctx`, which keeps the panes testable and
 * keeps every IPC subscription owned by the shell.
 */

import type { Api, LogLine, RendererView, TurnEvent } from '../../shared/contract.ts';
import type { Store } from './state.ts';

export interface Ctx {
  api: Api;
  store: Store;
  /** Transient confirmation or failure text shown in the detail header. */
  flash(message: string, kind?: 'ok' | 'bad'): void;
  navigate(view: RendererView): void;
  /**
   * Re-read config or status from main and publish it to the store. Called
   * after a mutation so a pane never has to assume main will push an event
   * back; if main does push one too, the second read is harmless.
   */
  refreshConfig(): Promise<void>;
  refreshStatus(): Promise<void>;
}

export interface View {
  el: HTMLElement;
  title: string;
  /** Optional controls for the right-hand side of the detail header. */
  actions?: HTMLElement;
  /** Shared state changed. Called throttled, never more than a few times a second. */
  update(): void;
  /** Turn lifecycle, forwarded from the service. */
  onTurn?(event: TurnEvent): void;
  /** One log line, forwarded live. Only the log pane implements this. */
  onLog?(line: LogLine): void;
  destroy(): void;
}

/**
 * Await an IPC call that can reject, and fall back rather than leaving the pane
 * half-painted. Main returns failures as `Result<T>`, but the invoke itself can
 * still reject if a handler throws before it can build one.
 */
export async function attempt<T>(work: Promise<T>, fallback: T, report?: (message: string) => void): Promise<T> {
  try {
    return await work;
  } catch (error) {
    report?.(error instanceof Error ? error.message : String(error));
    return fallback;
  }
}
