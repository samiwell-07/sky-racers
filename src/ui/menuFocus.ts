/**
 * Focus management for the menu overlay: keyboard/controller navigation between controls,
 * confirm/back, a sensible initial focus when a screen opens and focus restore when it returns.
 */
export type MenuNavAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';
type Direction = 'up' | 'down' | 'left' | 'right';
const menuNavHandlers = new WeakMap<HTMLElement, (action: MenuNavAction) => boolean>();

export function setMenuNavHandler(panel: HTMLElement, handler: (action: MenuNavAction) => boolean): () => void {
  menuNavHandlers.set(panel, handler);
  return () => { menuNavHandlers.delete(panel); };
}

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** The visible menu overlay, if any. */
export function activeMenuRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.menu-root:not(.hidden)');
}

const isShown = (el: HTMLElement): boolean => el.getClientRects().length > 0;

export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isShown);
}

function baseKey(e: HTMLElement): string {
  if (e.dataset.focusKey) return e.dataset.focusKey;
  if (e.id) return `#${e.id}`;
  const aria = e.getAttribute('aria-label');
  if (aria) return `aria:${aria}`;
  const label = e.closest('label');
  if (label && e.tagName !== 'BUTTON') return `field:${label.firstElementChild?.textContent ?? label.textContent ?? ''}`;
  return `${e.tagName}:${(e.textContent ?? '').trim()}`;
}

/** Stable identity of a control across re-renders of the same screen (repeated labels get an index). */
export function focusKey(el: Element): string {
  const base = baseKey(el as HTMLElement);
  const scope = el.closest('.menu-root') ?? document;
  const same = focusables(scope).filter((o) => baseKey(o) === base);
  const i = same.indexOf(el as HTMLElement);
  return i > 0 ? `${base}@${i}` : base;
}

/** Screen identity: explicit data-screen, else its heading. */
export function screenKey(panel: Element): string {
  return (panel as HTMLElement).dataset.screen ?? panel.querySelector('h1, h2')?.textContent ?? '';
}

export function focusEl(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: 'nearest' });
  return document.activeElement === el;
}

export function findByKey(root: ParentNode, key: string): HTMLElement | undefined {
  return focusables(root).find((el) => focusKey(el) === key);
}

/** Initial focus: [autofocus], else the selected choice, else the primary action, else the first control. */
export function focusInitial(root: ParentNode): boolean {
  const list = focusables(root);
  return focusEl(
    list.find((el) => el.hasAttribute('autofocus') || el.hasAttribute('data-autofocus')) ??
      list.find((el) => el.getAttribute('aria-pressed') === 'true') ??
      list.find((el) => el.classList.contains('primary') && !el.hasAttribute('data-back')) ??
      list.find((el) => !el.hasAttribute('data-back')) ??
      list[0],
  );
}

const center = (r: DOMRect): { x: number; y: number } => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** Nearest control in a direction (spatial navigation), wrapping in DOM order when there is none. */
export function moveFocus(root: ParentNode, dir: Direction, from: HTMLElement | null = document.activeElement as HTMLElement | null): boolean {
  const list = focusables(root);
  if (list.length === 0) return false;
  if (!from || !list.includes(from)) return focusInitial(root);
  const a = from.getBoundingClientRect();
  const ac = center(a);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bc = center(b);
    let primary: number;
    let secondary: number;
    switch (dir) {
      case 'up': primary = a.top - b.bottom; secondary = Math.abs(bc.x - ac.x); if (bc.y >= ac.y - 1) continue; break;
      case 'down': primary = b.top - a.bottom; secondary = Math.abs(bc.x - ac.x); if (bc.y <= ac.y + 1) continue; break;
      case 'left': primary = a.left - b.right; secondary = Math.abs(bc.y - ac.y); if (bc.x >= ac.x - 1) continue; break;
      case 'right': primary = b.left - a.right; secondary = Math.abs(bc.y - ac.y); if (bc.x <= ac.x + 1) continue; break;
    }
    // Side-by-side controls only count for left/right when they share a row.
    if ((dir === 'left' || dir === 'right') && (b.bottom < a.top + 2 || b.top > a.bottom - 2)) continue;
    const score = Math.max(0, primary) + secondary * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) {
    if (dir === 'left' || dir === 'right') return false;
    const i = list.indexOf(from);
    best = list[(i + (dir === 'down' ? 1 : -1) + list.length) % list.length]!;
  }
  return focusEl(best);
}

/** Changes a range/select value by one step, firing the same events as user input. */
function stepValue(el: HTMLElement, delta: 1 | -1): boolean {
  if (el instanceof HTMLInputElement && el.type === 'range') {
    const before = el.value;
    if (delta > 0) el.stepUp();
    else el.stepDown();
    if (el.value === before) return true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el instanceof HTMLSelectElement) {
    const i = Math.min(el.options.length - 1, Math.max(0, el.selectedIndex + delta));
    if (i === el.selectedIndex) return true;
    el.selectedIndex = i;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

export function backButton(root: ParentNode): HTMLElement | undefined {
  // The last one: the screen's footer Back wins over inline Cancel buttons (e.g. a calibration step).
  return [...root.querySelectorAll<HTMLElement>('[data-back]')].filter((el) => isShown(el) && !(el as HTMLButtonElement).disabled).pop();
}

/** Applies one navigation action to the visible menu. Returns true when it was handled. */
export function handleMenuNav(action: MenuNavAction, root: HTMLElement | null = activeMenuRoot()): boolean {
  if (!root) return false;
  const panel = root.firstElementChild;
  if (panel instanceof HTMLElement && menuNavHandlers.get(panel)?.(action)) return true;
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && root.contains(active) && active !== root;
  if (action === 'back') {
    const back = backButton(root);
    if (!back) return false;
    // Focus first so the screen remembers Back (not a stale control) as the way it was left.
    back.focus({ preventScroll: true });
    back.click();
    return true;
  }
  if (!inside) return focusInitial(root);
  switch (action) {
    case 'confirm':
      if (active instanceof HTMLSelectElement) {
        // A native list can't be opened from script: confirm cycles through the options.
        if (active.options.length > 0) {
          active.selectedIndex = (active.selectedIndex + 1) % active.options.length;
          active.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      }
      if (active instanceof HTMLInputElement && (active.type === 'range' || isTextEntry(active))) return true;
      active.click();
      return true;
    case 'left':
    case 'right':
      if (stepValue(active, action === 'right' ? 1 : -1)) return true;
      return moveFocus(root, action, active);
    default:
      return moveFocus(root, action, active);
  }
}

const isTextEntry = (el: Element | null): boolean =>
  !!el && (el.tagName === 'TEXTAREA' || (el instanceof HTMLInputElement && el.type !== 'range' && el.type !== 'checkbox'));

/**
 * Keyboard handling for the menu overlay: arrow keys move between buttons (native arrow behaviour
 * of sliders, lists and text fields is kept) and Escape activates Back on main-menu sub-screens.
 * The in-game pause overlay (transparent) leaves Escape to the game's pause toggle.
 */
export function installMenuKeyboard(isCapturing: () => boolean = () => false): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || isCapturing()) return;
    const root = activeMenuRoot();
    if (!root) return;
    const panel = root.firstElementChild;
    if (panel instanceof HTMLElement && menuNavHandlers.has(panel) && (e.key === 'Enter' || e.key === ' ')) {
      if (!e.repeat) handleMenuNav('confirm', root);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      if (root.classList.contains('transparent')) return;
      if (handleMenuNav('back', root)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[e.key as 'ArrowUp'];
    if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
    const active = document.activeElement;
    if (active instanceof HTMLSelectElement || (active instanceof HTMLInputElement && active.type === 'range') || isTextEntry(active)) return;
    if (handleMenuNav(dir, root)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  // Capture phase: runs before the game's own key handling (Escape is also the pause key).
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

/**
 * Connects a controller menu-navigation source (e.g. `cb => input.onMenuNavigate(cb)`, returning an
 * unsubscribe function) and the menu keyboard handling. Returns a cleanup function.
 */
export function attachMenuNavigation(
  subscribe: ((cb: (a: MenuNavAction) => void) => () => void) | null,
  isCapturing: () => boolean = () => false,
  cancelCapture: () => void = () => {},
): () => void {
  const offKeys = installMenuKeyboard(isCapturing);
  const offPad = subscribe?.((a) => {
    // A controller can't type a key: any pad navigation abandons a pending key capture (Back only cancels it).
    if (isCapturing()) {
      cancelCapture();
      if (a === 'back') return;
    }
    handleMenuNav(a);
  });
  return () => {
    offKeys();
    offPad?.();
  };
}
