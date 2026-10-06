/**
 * Rendering for `SetupCheckResult`. One place, because the same shape is shown
 * on the probe step, on the finish step's "Run all checks", and inline next to
 * the token fields, and three slightly different renderings of the same result
 * is how a UI starts lying about state.
 */

import type { SetupCheckResult } from '../../shared/contract.ts';
import { el, ms, pill, spinner } from './ui.ts';
import { hintFor } from './slack-errors.ts';

export interface CheckRowHandle {
  node: HTMLElement;
  setRunning(): void;
  setResult(result: SetupCheckResult): void;
  setIdle(note?: string): void;
}

/**
 * A check row is three states, not two: idle, running, and settled. The running
 * state matters because `claudeAuth` spawns the 317 MB CLI and takes seconds,
 * and a row that just sits blank reads as a hang.
 */
export function checkRow(label: string, idleNote = 'Not run yet'): CheckRowHandle {
  const detail = el('p', { class: 'field-hint', text: idleNote });
  const hint = el('p', { class: 'field-error', attrs: { hidden: true } });
  const status = el('div', {}, pill('idle', 'idle'));

  const node = el(
    'div',
    { class: 'row spread hairline' },
    el('div', { class: 'stack' }, el('span', { class: 'field-label', text: label }), detail, hint),
    status,
  );

  function replaceStatus(child: Node): void {
    status.replaceChildren(child);
  }

  return {
    node,
    setIdle(note) {
      detail.textContent = note ?? idleNote;
      hint.toggleAttribute('hidden', true);
      replaceStatus(pill('idle', 'idle'));
    },
    setRunning() {
      detail.textContent = 'Checking…';
      hint.toggleAttribute('hidden', true);
      replaceStatus(spinner(`Checking ${label}`));
    },
    setResult(result) {
      const took = result.durationMs && result.durationMs > 250 ? ` (${ms(result.durationMs)})` : '';
      detail.textContent = `${result.detail}${took}`;
      const advice = result.ok ? null : hintFor(result.detail, result.hint);
      hint.textContent = advice ?? '';
      hint.toggleAttribute('hidden', !advice);
      replaceStatus(result.ok ? pill('ok', 'ok') : pill(result.severity === 'warning' ? 'warn' : 'bad', result.severity === 'warning' ? 'warning' : 'failed'));
    },
  };
}

/** True when nothing in the set is a hard failure. Warnings never block. */
export function allChecksPassed(results: SetupCheckResult[]): boolean {
  return results.every((result) => result.ok || result.severity === 'warning');
}

export function failureSummary(results: SetupCheckResult[]): string {
  const failed = results.filter((result) => !result.ok && result.severity === 'error');
  if (failed.length === 0) {
    const warnings = results.filter((result) => !result.ok).length;
    return warnings === 0 ? 'All checks passed.' : `Passed with ${warnings} warning${warnings === 1 ? '' : 's'}.`;
  }
  return `${failed.length} check${failed.length === 1 ? '' : 's'} failed: ${failed.map((result) => result.label).join(', ')}.`;
}
