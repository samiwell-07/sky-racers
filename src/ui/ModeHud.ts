import { h } from './dom';
import './modeHud.css';

/** Top-centre box for flight school prompts and practice progress (HTML content built by the game). */
export class ModeHud {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private lastTitle = '';
  private lastBody = '';

  constructor(container: HTMLElement) {
    this.title = h('div', { class: 'mode-title' });
    this.body = h('div', { class: 'mode-body' });
    this.root = h('div', { class: 'hud mode-hud' }, h('div', { class: 'hud-panel mode-panel', role: 'status', 'aria-live': 'polite' }, this.title, this.body));
    this.root.style.display = 'none';
    container.appendChild(this.root);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    // The centre message moves below this panel while it's shown (see modeHud.css).
    document.body.classList.toggle('mode-hud-on', v);
  }

  /** @param title plain text; @param bodyHtml trusted HTML (labels are escaped by the caller). */
  set(title: string, bodyHtml: string): void {
    if (title !== this.lastTitle) this.title.textContent = this.lastTitle = title;
    if (bodyHtml !== this.lastBody) this.body.innerHTML = this.lastBody = bodyHtml;
  }
}
