/**
 * The dashboard's building blocks.
 *
 * Every visual decision is expressed as a class name from the shared
 * stylesheet. This module ships no CSS and sets no colours, spacing or fonts.
 * The only inline style it writes is `display` for show and hide, because the
 * `hidden` attribute loses to any `display` rule on a class (see setVisible).
 *
 * Control shapes, all present in the stylesheet:
 *   .switch          <button role="switch" aria-checked>
 *   .segmented       <div role="radiogroup"> of <button role="radio">
 */

import { h, on, setVisible, type Child } from './dom.ts';
import { formatElapsed, formatRelative } from './format.ts';

export type PillKind = 'ok' | 'warn' | 'bad' | 'idle';

let uid = 0;
function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${uid}`;
}

export function pill(kind: PillKind, label: string): HTMLSpanElement {
  return h('span', { class: `pill pill-${kind}` }, label);
}

export function chip(label: string, kind?: 'ok' | 'bad' | 'pending'): HTMLSpanElement {
  return h('span', { class: kind ? `chip chip-${kind}` : 'chip' }, label);
}

export function spinner(label = 'Working'): HTMLSpanElement {
  return h('span', { class: 'spinner', role: 'status', 'aria-label': label });
}

export function code(text: string): HTMLElement {
  return h('code', { class: 'code' }, text);
}

export function kbd(text: string): HTMLElement {
  return h('kbd', { class: 'kbd' }, text);
}

/** A timestamp that a single ticker re-renders in place. See `startTicker`. */
export function relativeTime(at: number | undefined): HTMLSpanElement {
  if (!at) return h('span', {}, 'never');
  return h('span', { 'data-relative': String(at) }, formatRelative(at));
}

/** A running clock for a turn that started at `at`. Also driven by the ticker. */
export function elapsedTime(at: number | undefined): HTMLSpanElement {
  if (!at) return h('span', {}, '-');
  return h('span', { 'data-elapsed': String(at) }, formatElapsed(at));
}

export interface CardParts {
  el: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
}

/**
 * The standard surface. `title` may be omitted for a card that is only a body,
 * and the footer stays empty (and so collapses) until something is put in it.
 */
export function card(title?: string, actions?: Child, opts: { flush?: boolean } = {}): CardParts {
  const heading = h('div', { class: 'stack stack-tight' }, title ? h('h2', {}, title) : null);
  const header = h('div', { class: 'card-header' }, heading, actions ? h('div', { class: 'card-header-actions' }, actions) : null);
  // `.card-body` and `.card-footer` are already flex containers with their own
  // gaps, so no layout class is added on top of them. `is-flush` drops the
  // padding for a body whose only child is a table.
  const body = h('div', { class: opts.flush ? 'card-body is-flush' : 'card-body' });
  const footer = h('div', { class: 'card-footer' });
  const el = h('section', { class: 'card glass' }, title || actions ? header : null, body, footer);
  return { el, header, body, footer };
}

/**
 * A group of buttons for a card footer.
 *
 * The stylesheet gives `.card-footer .btn` an auto inline-start margin, which
 * is right for one trailing button and wrong for a toolbar: several of them
 * would each absorb a share of the free space and drift apart. Nesting them
 * removes the free space from their container, so the group stays together.
 */
export function buttonGroup(...buttons: Child[]): HTMLElement {
  return h('div', { class: 'row row-tight' }, ...buttons);
}

/** Absorbs the free space in a flex row, pushing what follows to the end. */
export function spacer(): HTMLElement {
  return h('div', { class: 'grow' });
}

export function emptyState(message: string, hint?: string): HTMLElement {
  return h('div', { class: 'empty-state' }, h('strong', {}, message), hint ? h('p', {}, hint) : null);
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export interface FieldOptions {
  label: string;
  // Explicitly `| undefined` so a caller can pass a computed value that may be
  // absent without having to build the object conditionally.
  hint?: string | undefined;
  error?: string | undefined;
  control: HTMLElement;
  /** Put the control on the same line as the label, as macOS settings rows do. */
  inline?: boolean;
}

export interface FieldParts {
  el: HTMLElement;
  labelEl: HTMLElement;
  hintEl: HTMLElement;
  errorEl: HTMLElement;
  setError(message?: string): void;
  setHint(message?: string): void;
}

/**
 * The element a `<label for>` should point at.
 *
 * A field's control is often a wrapper, e.g. an input next to a Choose button.
 * Pointing the label at the wrapper silently produces a control with no
 * accessible name, so the first labelable descendant is used instead.
 */
function labelTarget(control: HTMLElement): HTMLElement {
  const labelable = 'button, input, meter, output, progress, select, textarea';
  if (control.matches(labelable)) return control;
  return control.querySelector<HTMLElement>(labelable) ?? control;
}

export function field(options: FieldOptions): FieldParts {
  const id = nextId('fld');
  const target = labelTarget(options.control);
  if (!target.id) target.id = nextId('ctl');
  const labelEl = h('label', { class: 'field-label', id, for: target.id }, options.label);
  const hintEl = h('div', { class: 'field-hint' }, options.hint ?? '');
  const errorEl = h('div', { class: 'field-error', role: 'alert' }, options.error ?? '');
  setVisible(hintEl, Boolean(options.hint));
  setVisible(errorEl, Boolean(options.error));

  if (!target.getAttribute('aria-labelledby') && !target.getAttribute('aria-label')) {
    target.setAttribute('aria-labelledby', id);
  }

  // `.field` alone owns the vertical layout. Adding `.stack` here would put the
  // control in a column flex container, where a `flex-basis` meant for a row
  // becomes a height and the input grows into a huge box.
  const el = options.inline
    ? h('div', { class: 'field field-inline' }, h('div', { class: 'stack stack-tight' }, labelEl, hintEl, errorEl), options.control)
    : h('div', { class: 'field' }, labelEl, options.control, hintEl, errorEl);

  return {
    el,
    labelEl,
    hintEl,
    errorEl,
    setError(message?: string) {
      errorEl.textContent = message ?? '';
      setVisible(errorEl, Boolean(message));
    },
    setHint(message?: string) {
      hintEl.textContent = message ?? '';
      setVisible(hintEl, Boolean(message));
    },
  };
}

export function textInput(value: string, opts: { mono?: boolean; placeholder?: string; type?: string } = {}): HTMLInputElement {
  return h('input', {
    class: opts.mono ? 'input input-mono' : 'input',
    type: opts.type ?? 'text',
    value,
    placeholder: opts.placeholder,
    spellcheck: 'false',
    autocomplete: 'off',
  });
}

export function numberInput(value: number, range?: readonly [number, number], step = 1): HTMLInputElement {
  return h('input', {
    class: 'input',
    type: 'number',
    value: String(value),
    min: range ? String(range[0]) : undefined,
    max: range ? String(range[1]) : undefined,
    step: String(step),
  });
}

export function select(options: { value: string; label: string }[], value: string): HTMLSelectElement {
  const el = h(
    'select',
    { class: 'select' },
    ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
  );
  el.value = value;
  return el;
}

export function textarea(value: string, rows = 3, placeholder?: string): HTMLTextAreaElement {
  return h('textarea', { class: 'textarea', rows: String(rows), placeholder, spellcheck: 'false' }, value);
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export interface SwitchParts {
  el: HTMLButtonElement;
  set(checked: boolean): void;
  setDisabled(disabled: boolean, reason?: string): void;
}

/**
 * A real switch, not a checkbox: `role="switch"` on a button is keyboard
 * reachable, announces its state, and lets the stylesheet draw the track and
 * thumb from `[aria-checked]` with no extra markup.
 */
export function switchControl(checked: boolean, onToggle: (next: boolean) => void, label?: string): SwitchParts {
  const el = h('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label,
  });
  on(el, 'click', () => {
    if (el.disabled) return;
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', next ? 'true' : 'false');
    onToggle(next);
  });
  return {
    el,
    set(next: boolean) {
      el.setAttribute('aria-checked', next ? 'true' : 'false');
    },
    setDisabled(disabled: boolean, reason?: string) {
      el.disabled = disabled;
      if (reason) el.title = reason;
      else el.removeAttribute('title');
    },
  };
}

export interface SwitchFieldParts extends FieldParts {
  control: SwitchParts;
}

/** The settings row shape: label and hint on the left, switch on the right. */
export function switchField(
  label: string,
  hint: string | undefined,
  checked: boolean,
  onToggle: (next: boolean) => void,
): SwitchFieldParts {
  const control = switchControl(checked, onToggle, label);
  const parts = field({ label, hint, control: control.el, inline: true });
  return { ...parts, control };
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export interface SegmentedParts {
  el: HTMLElement;
  set(value: string): void;
}

export function segmented(
  options: { value: string; label: string; title?: string }[],
  value: string,
  onChange: (next: string) => void,
  label?: string,
): SegmentedParts {
  const buttons = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        class: 'segmented-option',
        role: 'radio',
        'aria-checked': o.value === value ? 'true' : 'false',
        tabindex: o.value === value ? '0' : '-1',
        'data-value': o.value,
        title: o.title,
      },
      o.label,
    ),
  );

  const el = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label }, ...buttons);

  const apply = (next: string, focus: boolean) => {
    for (const button of buttons) {
      const selected = button.dataset.value === next;
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
  };

  for (const button of buttons) {
    on(button, 'click', () => {
      const next = button.dataset.value ?? '';
      apply(next, false);
      onChange(next);
    });
  }

  // Arrow keys move within a radiogroup, which is what a native segmented
  // control does and what a screen reader user will expect.
  on(el, 'keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'ArrowUp' && key !== 'ArrowDown') return;
    event.preventDefault();
    const current = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
    const nextIndex = (current + step + buttons.length) % buttons.length;
    const next = buttons[nextIndex]?.dataset.value ?? '';
    apply(next, true);
    onChange(next);
  });

  return { el, set: (next: string) => apply(next, false) };
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

export function button(
  label: Child,
  onClick: () => void,
  opts: { variant?: ButtonVariant; disabled?: boolean; title?: string; small?: boolean } = {},
): HTMLButtonElement {
  const variant = opts.variant ?? 'default';
  const classes = ['btn'];
  if (variant !== 'default') classes.push(`btn-${variant}`);
  if (opts.small) classes.push('btn-small');
  const el = h(
    'button',
    {
      type: 'button',
      class: classes.join(' '),
      disabled: opts.disabled === true,
      title: opts.title,
    },
    label,
  );
  on(el, 'click', () => {
    if (!el.disabled) onClick();
  });
  return el;
}

/**
 * Destructive actions ask twice, in place. A second click inside the window
 * commits; anything else, including moving on, cancels. This is why the
 * dashboard needs no modal dialog and therefore no CSS the contract lacks.
 */
export function confirmButton(
  label: string,
  confirmLabel: string,
  onConfirm: () => void,
  opts: { variant?: ButtonVariant; windowMs?: number; small?: boolean } = {},
): HTMLButtonElement {
  const windowMs = opts.windowMs ?? 4000;
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const el = button(
    label,
    () => {
      if (armed) {
        if (timer) clearTimeout(timer);
        armed = false;
        el.textContent = label;
        el.classList.remove('btn-danger');
        onConfirm();
        return;
      }
      armed = true;
      el.textContent = confirmLabel;
      el.classList.add('btn-danger');
      timer = setTimeout(() => {
        armed = false;
        el.textContent = label;
        el.classList.remove('btn-danger');
      }, windowMs);
    },
    { variant: opts.variant ?? 'ghost', small: opts.small === true },
  );
  return el;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface TableParts {
  el: HTMLElement;
  tbody: HTMLTableSectionElement;
  /** Replace every row. Passing an empty array shows the empty message instead. */
  setRows(rows: HTMLTableRowElement[]): void;
  setEmpty(message: string): void;
}

export function dataTable(headers: string[], emptyMessage: string): TableParts {
  const tbody = h('tbody');
  const table = h(
    'table',
    { class: 'table' },
    h('thead', {}, h('tr', {}, ...headers.map((label) => h('th', { scope: 'col' }, label)))),
    tbody,
  );
  const empty = h('div', { class: 'table-empty' }, emptyMessage);
  setVisible(empty, false);
  // Wide content scrolls inside its own container so the window body never
  // scrolls sideways.
  const el = h('div', { class: 'table-wrap' }, table, empty);

  return {
    el,
    tbody,
    setRows(rows: HTMLTableRowElement[]) {
      tbody.replaceChildren(...rows);
      const isEmpty = rows.length === 0;
      setVisible(table, !isEmpty);
      setVisible(empty, isEmpty);
    },
    setEmpty(message: string) {
      empty.textContent = message;
    },
  };
}

export function td(...children: Child[]): HTMLTableCellElement {
  return h('td', {}, ...children);
}

/** A right-aligned cell on tabular numerals, for counts, durations and money. */
export function tdNum(...children: Child[]): HTMLTableCellElement {
  return h('td', { class: 'num' }, ...children);
}

export function tr(...cells: HTMLTableCellElement[]): HTMLTableRowElement {
  return h('tr', {}, ...cells);
}

// ---------------------------------------------------------------------------
// The relative-time ticker
// ---------------------------------------------------------------------------

/**
 * One timer for the whole window. Rebuilding a table of live rows once a second
 * just to age its timestamps would drop hover states and steal focus from any
 * button inside it, so timestamps are data attributes patched in place instead.
 */
export function startTicker(root: HTMLElement): () => void {
  const paint = () => {
    for (const el of root.querySelectorAll<HTMLElement>('[data-relative]')) {
      const at = Number(el.dataset.relative);
      if (Number.isFinite(at)) el.textContent = formatRelative(at);
    }
    for (const el of root.querySelectorAll<HTMLElement>('[data-elapsed]')) {
      const at = Number(el.dataset.elapsed);
      if (Number.isFinite(at)) el.textContent = formatElapsed(at);
    }
  };
  paint();
  const timer = setInterval(paint, 1000);
  return () => clearInterval(timer);
}
