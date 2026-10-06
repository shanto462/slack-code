/**
 * Small DOM helpers for the setup wizard.
 *
 * Deliberately local to this slice. The plan gives the wizard and the dashboard
 * their own helpers so there is no shared renderer module for two implementers
 * to fight over. The one shared surface is the CSS class list, which the build
 * and shell slice owns, so nothing here ships a stylesheet or invents a class
 * name outside that list.
 *
 * Nothing here ever assigns innerHTML. Almost every string the wizard renders
 * comes from somewhere the operator does not fully control: Slack display
 * names, raw Slack API error text, file paths, shell PATH entries. Text goes in
 * through textContent, always.
 */

export type Child = Node | string | number | null | undefined | false;

export interface ElOptions {
  class?: string;
  text?: string;
  id?: string;
  type?: string;
  name?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  autocomplete?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string>;
  style?: Record<string, string>;
  onClick?: (ev: MouseEvent) => void;
  onInput?: (ev: Event) => void;
  onChange?: (ev: Event) => void;
  onKeyDown?: (ev: KeyboardEvent) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.id) node.id = opts.id;
  if (opts.text !== undefined) node.textContent = opts.text;

  if (opts.type !== undefined) node.setAttribute('type', opts.type);
  if (opts.name !== undefined) node.setAttribute('name', opts.name);
  if (opts.placeholder !== undefined) node.setAttribute('placeholder', opts.placeholder);
  if (opts.autocomplete !== undefined) node.setAttribute('autocomplete', opts.autocomplete);
  if (opts.value !== undefined && 'value' in node) (node as unknown as { value: string }).value = opts.value;
  if (opts.disabled !== undefined && 'disabled' in node) (node as unknown as { disabled: boolean }).disabled = opts.disabled;

  for (const [key, value] of Object.entries(opts.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [key, value] of Object.entries(opts.dataset ?? {})) node.dataset[key] = value;
  for (const [key, value] of Object.entries(opts.style ?? {})) node.style.setProperty(key, value);

  if (opts.onClick) node.addEventListener('click', opts.onClick as EventListener);
  if (opts.onInput) node.addEventListener('input', opts.onInput);
  if (opts.onChange) node.addEventListener('change', opts.onChange);
  if (opts.onKeyDown) node.addEventListener('keydown', opts.onKeyDown as EventListener);

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Collects teardown functions so a step's destroy() is one call, never a checklist. */
export class Bag {
  private readonly disposers: (() => void)[] = [];

  add(disposer: () => void): void {
    this.disposers.push(disposer);
  }

  /** Convenience for the timers the handshake countdown and the probe spinner need. */
  interval(fn: () => void, ms: number): void {
    const id = window.setInterval(fn, ms);
    this.disposers.push(() => window.clearInterval(id));
  }

  dispose(): void {
    while (this.disposers.length) {
      const disposer = this.disposers.pop();
      try {
        disposer?.();
      } catch (error) {
        console.error('[setup] teardown threw', error);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Composed controls, all built from the shared class list
// ---------------------------------------------------------------------------

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

export function button(
  label: string,
  opts: { variant?: 'primary' | 'danger' | 'ghost'; onClick?: () => void; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  const variant = opts.variant ? ` btn-${opts.variant}` : '';
  return el('button', {
    class: `btn${variant}`,
    type: 'button',
    text: label,
    disabled: opts.disabled ?? false,
    attrs: { title: opts.title ?? null },
    onClick: () => opts.onClick?.(),
  });
}

export interface FieldParts {
  wrap: HTMLDivElement;
  input: HTMLInputElement;
  error: HTMLParagraphElement;
  setError(message: string | null): void;
}

export function textField(opts: {
  label: string;
  hint?: string;
  placeholder?: string;
  value?: string;
  mono?: boolean;
  password?: boolean;
  onInput?: (value: string) => void;
  onEnter?: () => void;
}): FieldParts {
  const id = nextId('field');
  const input = el('input', {
    id,
    class: opts.mono ? 'input input-mono' : 'input',
    type: opts.password ? 'password' : 'text',
    placeholder: opts.placeholder ?? '',
    value: opts.value ?? '',
    // Slack tokens must never end up in the browser's saved-password store.
    autocomplete: 'off',
    attrs: { spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' },
    onInput: () => opts.onInput?.(input.value),
    onKeyDown: (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        opts.onEnter?.();
      }
    },
  });
  const error = el('p', { class: 'field-error', attrs: { hidden: true, role: 'alert' } });
  const wrap = el(
    'div',
    { class: 'field' },
    el('label', { class: 'field-label', text: opts.label, attrs: { for: id } }),
    input,
    opts.hint ? el('p', { class: 'field-hint', text: opts.hint }) : null,
    error,
  );
  return {
    wrap,
    input,
    error,
    setError(message) {
      error.textContent = message ?? '';
      error.toggleAttribute('hidden', !message);
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    },
  };
}

/** A masked token field with a reveal toggle, because a mistyped token is the commonest setup failure. */
export function secretField(opts: {
  label: string;
  hint?: string;
  placeholder: string;
  onInput?: (value: string) => void;
  onEnter?: () => void;
}): FieldParts & { reveal: HTMLButtonElement } {
  const parts = textField({ ...opts, mono: true, password: true });
  const reveal = button('Show', {
    variant: 'ghost',
    onClick: () => {
      const masked = parts.input.type === 'password';
      parts.input.type = masked ? 'text' : 'password';
      reveal.textContent = masked ? 'Hide' : 'Show';
      reveal.setAttribute('aria-pressed', masked ? 'true' : 'false');
    },
  });
  reveal.setAttribute('aria-pressed', 'false');

  // The reveal sits beside the input rather than after the hint, so the hint
  // and the error text still read as one block under the control. Capture the
  // anchor before moving the input: appending it into `line` would otherwise
  // detach it from `wrap` and leave insertBefore with nothing to aim at.
  const anchor = parts.input.nextSibling;
  const line = el('div', { class: 'row' });
  parts.wrap.insertBefore(line, anchor);
  line.append(parts.input, reveal);
  return { ...parts, reveal };
}

/**
 * A real switch, not a checkbox. `role="switch"` with `aria-checked` is the
 * pattern screen readers announce correctly, and it leaves the visual entirely
 * to the stylesheet.
 */
export function switchControl(opts: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}): { wrap: HTMLElement; set(checked: boolean): void; setDisabled(disabled: boolean): void } {
  let checked = opts.checked;
  const control = el('button', {
    class: 'switch',
    type: 'button',
    disabled: opts.disabled ?? false,
    attrs: { role: 'switch', 'aria-checked': String(checked) },
    onClick: () => {
      checked = !checked;
      control.setAttribute('aria-checked', String(checked));
      opts.onChange(checked);
    },
  });
  const labelId = nextId('switch-label');
  control.setAttribute('aria-labelledby', labelId);

  const wrap = el(
    'div',
    { class: 'row spread' },
    el(
      'div',
      { class: 'stack' },
      el('span', { class: 'field-label', id: labelId, text: opts.label }),
      opts.hint ? el('p', { class: 'field-hint', text: opts.hint }) : null,
    ),
    control,
  );
  return {
    wrap,
    set(next) {
      checked = next;
      control.setAttribute('aria-checked', String(next));
    },
    setDisabled(disabled) {
      control.disabled = disabled;
    },
  };
}

/**
 * Segmented control for exclusive choices. Roving tabindex plus arrow keys, so
 * the whole group is one tab stop and behaves like a native radio group.
 */
export function segmented<T extends string>(opts: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
}): { wrap: HTMLElement; set(value: T): void } {
  const groupId = nextId('seg-label');
  const buttons = new Map<T, HTMLButtonElement>();

  const group = el('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-labelledby': groupId } });

  function select(value: T, focus: boolean): void {
    for (const [key, node] of buttons) {
      const on = key === value;
      node.setAttribute('aria-checked', String(on));
      node.tabIndex = on ? 0 : -1;
    }
    if (focus) buttons.get(value)?.focus();
  }

  opts.options.forEach((option) => {
    const node = el('button', {
      class: 'segmented-option',
      type: 'button',
      text: option.label,
      attrs: { role: 'radio', 'aria-checked': 'false' },
      onClick: () => {
        select(option.value, false);
        opts.onChange(option.value);
      },
      onKeyDown: (ev) => {
        const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
        if (step === 0) return;
        ev.preventDefault();
        const index = opts.options.findIndex((o) => o.value === option.value);
        const next = opts.options[(index + step + opts.options.length) % opts.options.length];
        if (!next) return;
        select(next.value, true);
        opts.onChange(next.value);
      },
    });
    node.tabIndex = -1;
    buttons.set(option.value, node);
    group.appendChild(node);
  });

  // Nothing selected means no roving stop exists yet, so make the first option
  // reachable by tab. This is the "wizard preselects nothing" case.
  if (opts.value === null) {
    const first = opts.options[0];
    if (first) {
      const node = buttons.get(first.value);
      if (node) node.tabIndex = 0;
    }
  } else {
    select(opts.value, false);
  }

  const wrap = el('div', { class: 'field' }, el('span', { class: 'field-label', id: groupId, text: opts.label }), group);
  return { wrap, set: (value) => select(value, false) };
}

export type Tone = 'ok' | 'warn' | 'bad' | 'idle';

export function pill(tone: Tone, text: string): HTMLElement {
  return el('span', { class: `pill pill-${tone}`, text });
}

export function chip(text: string, tone?: 'ok' | 'bad' | 'pending', onRemove?: () => void): HTMLElement {
  const node = el('span', { class: tone ? `chip chip-${tone}` : 'chip' }, el('span', { text }));
  if (onRemove) {
    node.appendChild(
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: '×',
        attrs: { 'aria-label': `Remove ${text}` },
        onClick: onRemove,
      }),
    );
  }
  return node;
}

export function spinner(label = 'Working'): HTMLElement {
  return el('span', { class: 'spinner', attrs: { role: 'status', 'aria-label': label } });
}

export function card(opts: { title?: string; subtitle?: string; body: Child[]; footer?: Child[]; glass?: boolean }): HTMLElement {
  const node = el('section', { class: opts.glass === false ? 'card' : 'card glass' });
  if (opts.title || opts.subtitle) {
    node.appendChild(
      el(
        'header',
        { class: 'card-header' },
        opts.title ? el('h3', { text: opts.title }) : null,
        opts.subtitle ? el('p', { class: 'field-hint', text: opts.subtitle }) : null,
      ),
    );
  }
  const body = el('div', { class: 'card-body' });
  append(body, opts.body);
  node.appendChild(body);
  if (opts.footer?.length) {
    const footer = el('div', { class: 'card-footer' });
    append(footer, opts.footer);
    node.appendChild(footer);
  }
  return node;
}

export function emptyState(message: string): HTMLElement {
  return el('p', { class: 'empty-state', text: message });
}

export function kbd(keys: string): HTMLElement {
  return el('span', { class: 'kbd', text: keys });
}

export function codeBlock(text: string): HTMLElement {
  // Wide content scrolls inside its own container. The window body must never
  // scroll horizontally.
  return el('pre', { class: 'code', style: { 'overflow-x': 'auto' }, attrs: { tabindex: '0' } }, el('code', { text }));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

/** Truncate for display, never for storage. */
export function ellipsis(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Directory basename to a candidate alias. Same grammar as ALIAS_PATTERN, so
 * validateAlias() from the contract accepts whatever this produces or the
 * operator sees the reason immediately.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

export function basename(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? dir;
}

/**
 * Clipboard with a fallback. `navigator.clipboard` needs a secure context;
 * file:// counts as one in Chromium, but the packaged app is the case we cannot
 * retest cheaply, so the execCommand path stays as a safety net.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const scratch = el('textarea', { value, style: { position: 'fixed', opacity: '0', top: '0' } });
      document.body.appendChild(scratch);
      scratch.select();
      const copied = document.execCommand('copy');
      scratch.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

/** Briefly swap a button's label to confirm an action without a toast system. */
export function flashLabel(node: HTMLButtonElement, label: string, restoreAfterMs = 1600): void {
  const original = node.textContent ?? '';
  node.textContent = label;
  window.setTimeout(() => {
    node.textContent = original;
  }, restoreAfterMs);
}
