/**
 * Minimal DOM helpers for the dashboard.
 *
 * The wizard and the dashboard deliberately keep separate helper modules, so
 * two parallel implementers never contend over one renderer file. Nothing here
 * touches theme, layout or colour: every visual decision lives in the shared
 * stylesheet and is reached only through the class names in the CSS contract.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export type Attrs = Record<string, string | number | boolean | null | undefined>;

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
      continue;
    }
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Create an element. `false`, `null` and `undefined` attribute values are
 * dropped so a conditional attribute can be written inline; `true` becomes a
 * bare attribute. `value` and `checked` are set as properties, because setting
 * them as attributes only changes the default, not the live control.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, raw] of Object.entries(attrs)) {
    if (raw === null || raw === undefined || raw === false) continue;
    if (
      key === 'value' &&
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
    ) {
      el.value = String(raw);
      continue;
    }
    if (key === 'checked' && el instanceof HTMLInputElement) {
      el.checked = true;
      continue;
    }
    el.setAttribute(key, raw === true ? '' : String(raw));
  }
  append(el, children);
  return el;
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace an element's children in one pass. */
export function fill(el: Node, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

/** Add a listener and return the function that removes it again. */
export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function on(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions,
): () => void;
export function on(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/**
 * Collects teardown functions so a view can be unmounted without leaking
 * listeners, timers or IPC subscriptions. Every view owns exactly one.
 */
export class Disposers {
  private fns: (() => void)[] = [];

  add(fn: () => void): void {
    this.fns.push(fn);
  }

  dispose(): void {
    // Reverse order, so a listener registered against something created later
    // is always removed before that thing is torn down.
    for (let i = this.fns.length - 1; i >= 0; i -= 1) {
      try {
        this.fns[i]!();
      } catch {
        // A failing teardown must not strand the ones after it.
      }
    }
    this.fns = [];
  }
}

/**
 * Show or hide an element.
 *
 * The `hidden` attribute alone is not enough: it is only a `display: none` rule
 * in the UA stylesheet, so ANY `display` declaration on the element's class
 * beats it and the element stays visible. That bites every spinner and every
 * empty-state here, because the shared stylesheet is written by someone else.
 * Setting the inline style as well is the only reliable answer; clearing it
 * back to '' restores whatever the class asked for.
 */
export function setVisible(el: HTMLElement, visible: boolean): void {
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
}

/** True when focus is inside `el`, so a background refresh can leave it alone. */
export function holdsFocus(el: HTMLElement): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && el.contains(active);
}
