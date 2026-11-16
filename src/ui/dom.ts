/** Tiny DOM builder for the menus. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | number | boolean | ((e: Event) => void)>> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, '').toLowerCase(), value as EventListener);
    else if (key === 'class') el.className = String(value);
    else if (key in el && key !== 'list') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Labels that leave the current screen: Escape and the controller's back button activate them. */
const BACK_LABELS = new Set(['Back', 'Cancel']);

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const el = h('button', { class: `menu-btn ${cls}`.trim(), onclick: onClick, type: 'button' }, label);
  if (BACK_LABELS.has(label)) markBack(el);
  // Selected tabs/options announce themselves (the class alone is purely visual).
  if (/(^|\s)selected(\s|$)/.test(cls)) el.setAttribute('aria-current', 'true');
  return el;
}

/** Marks a control as the screen's way back (Escape / controller back). */
export function markBack<T extends HTMLElement>(el: T): T {
  el.dataset.back = '';
  return el;
}

/** A toggle-style choice (one of several): announces its pressed state. */
export function choiceButton(content: Array<Node | string>, pressed: boolean, onClick: () => void, cls = ''): HTMLButtonElement {
  const el = h('button', { class: `menu-btn ${cls} ${pressed ? 'selected' : ''}`.trim(), onclick: onClick, type: 'button' }, ...content);
  el.setAttribute('aria-pressed', String(pressed));
  return el;
}


/** Labeled range slider bound to a getter/setter. */
export function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (v: number) => void,
  format: (v: number) => string = (v) => String(v),
): HTMLElement {
  const value = h('span', { class: 'menu-value', 'aria-hidden': 'true' }, format(get()));
  const input = h('input', { type: 'range', min, max, step, value: get() });
  input.setAttribute('aria-valuetext', format(get()));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    value.textContent = format(v);
    input.setAttribute('aria-valuetext', format(v));
  });
  return h('label', { class: 'menu-field' }, h('span', {}, label), input, value);
}

export function checkbox(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: get() });
  input.addEventListener('change', () => set(input.checked));
  return h('label', { class: 'menu-field menu-check' }, h('span', {}, label), input);
}

export function select<T extends string>(label: string, options: Array<[T, string]>, get: () => T, set: (v: T) => void): HTMLElement {
  const input = h('select', {}, ...options.map(([v, l]) => h('option', { value: v, selected: v === get() }, l)));
  input.addEventListener('change', () => set(input.value as T));
  return h('label', { class: 'menu-field' }, h('span', {}, label), input);
}

export function textInput(label: string, get: () => string, set: (v: string) => void): HTMLElement {
  const input = h('input', { type: 'text', value: get() });
  input.addEventListener('change', () => set(input.value));
  return h('label', { class: 'menu-field' }, h('span', {}, label), input);
}
