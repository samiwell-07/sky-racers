import { button, h } from '../dom';
import type { DogfightHudState, DogfightHudView } from './types';
import './dogfightHud.css';

export interface DogfightHudOptions {
  /** The results panel's "Back to lobby" button. */
  onBackToLobby: () => void;
}

function lockLabel(missiles: number, lock: number): { text: string; cls: string } {
  if (missiles <= 0) return { text: 'NO MSL', cls: 'empty' };
  if (lock >= 1) return { text: 'LOCKED', cls: 'locked' };
  if (lock > 0) return { text: 'LOCKING', cls: 'locking' };
  return { text: 'SEARCH', cls: 'search' };
}

const RESULT_TITLES = { victory: 'VICTORY', defeat: 'DEFEAT', opponentLeft: 'VICTORY' } as const;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Gun crosshair half-size in NDC units along x (y is scaled by the aspect ratio). */
const GUN_SIZE = 0.025;
const GUN_GAP = 0.008;

/**
 * Combat HUD of the dogfight: score (top right), weapons panel (right, above the radar), missile
 * warning, start countdown, out-of-zone and respawn countdowns (centre) and the results panel.
 * Scaled by --hud-scale like the rest of the HUD.
 */
export class DogfightHud implements DogfightHudView {
  private readonly root: HTMLDivElement;
  private readonly scoreMine: HTMLElement;
  private readonly scoreTheirs: HTMLElement;
  private readonly scoreName: HTMLElement;
  private readonly scoreGoal: HTMLElement;
  private readonly board: HTMLUListElement;
  private readonly feed: HTMLDivElement;
  private readonly weaponsPanel: HTMLDivElement;
  private readonly heatFill: HTMLDivElement;
  private readonly overheat: HTMLSpanElement;
  private readonly missiles: HTMLElement;
  private readonly lock: HTMLSpanElement;
  private readonly lockFill: HTMLDivElement;
  private readonly flares: HTMLElement;
  private readonly missileWarn: HTMLDivElement;
  private readonly center: HTMLDivElement;
  private readonly centerTitle: HTMLDivElement;
  private readonly centerBig: HTMLDivElement;
  private readonly centerSub: HTMLDivElement;
  private readonly results: HTMLDivElement;
  private readonly resultsTitle: HTMLDivElement;
  private readonly resultsScore: HTMLDivElement;
  private readonly resultsNote: HTMLDivElement;
  private readonly backButton: HTMLButtonElement;
  private readonly cache = new Map<string, string>();
  private readonly reticleSvg: SVGSVGElement;
  private readonly lockBox: SVGPolygonElement;
  private readonly gunCross: SVGPathElement;
  private resultsShown = false;

  constructor(private readonly options: DogfightHudOptions) {
    this.scoreMine = h('b', { class: 'df-mine' }, '0');
    this.scoreTheirs = h('b', { class: 'df-theirs' }, '0');
    this.scoreName = h('span', { class: 'df-name' }, 'OPPONENT');
    this.scoreGoal = h('div', { class: 'df-goal' });
    this.board = h('ul', { class: 'df-board' });
    this.feed = h('div', { class: 'df-feed' });
    const score = h(
      'div',
      { class: 'hud-panel df-score', role: 'status' },
      h('div', { class: 'df-score-line' }, h('span', {}, 'YOU'), ' ', this.scoreMine, h('span', { class: 'df-dash' }, '–'), this.scoreTheirs, ' ', this.scoreName),
      this.board,
      this.scoreGoal,
      this.feed,
    );

    this.heatFill = h('div', { class: 'df-bar-fill' });
    this.overheat = h('span', { class: 'df-overheat' }, 'OVERHEAT');
    this.missiles = h('b', {}, '4');
    this.lock = h('span', { class: 'df-lock search' }, 'SEARCH');
    this.lockFill = h('div', { class: 'df-bar-fill' });
    this.flares = h('b', {}, '30');
    this.missileWarn = h('div', { class: 'df-missile-warn' }, 'MISSILE');
    this.weaponsPanel = h(
      'div',
      { class: 'hud-panel df-weapons' },
      this.missileWarn,
      h('div', { class: 'df-row' }, h('span', { class: 'df-label' }, 'GUN'), h('div', { class: 'df-bar df-heat' }, this.heatFill), this.overheat),
      h('div', { class: 'df-row' }, h('span', { class: 'df-label' }, 'MSL'), this.missiles, this.lock),
      h('div', { class: 'df-row' }, h('span', { class: 'df-label' }, ''), h('div', { class: 'df-bar df-lockbar' }, this.lockFill)),
      h('div', { class: 'df-row' }, h('span', { class: 'df-label' }, 'FLR'), this.flares),
    );

    this.centerTitle = h('div', { class: 'df-center-title' });
    this.centerBig = h('div', { class: 'df-center-big' });
    this.centerSub = h('div', { class: 'df-center-sub' });
    this.center = h('div', { class: 'df-center', 'aria-live': 'assertive' }, this.centerTitle, this.centerBig, this.centerSub);

    this.resultsTitle = h('div', { class: 'df-results-title' });
    this.resultsScore = h('div', { class: 'df-results-score' });
    this.resultsNote = h('div', { class: 'df-results-note' });
    this.backButton = button('Back to lobby', () => this.options.onBackToLobby(), 'primary');
    this.results = h(
      'div',
      { class: 'df-results', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'df-results-panel' }, this.resultsTitle, this.resultsScore, this.resultsNote, this.backButton),
    );

    this.root = h('div', { class: 'hud df-hud' }, score, this.weaponsPanel, this.center, this.results);
    this.reticleSvg = svg('svg', { class: 'df-reticle', viewBox: '-1 -1 2 2', preserveAspectRatio: 'none' });
    this.lockBox = svg('polygon', { class: 'df-lockbox idle' });
    this.gunCross = svg('path', { class: 'df-gun' });
    this.reticleSvg.append(this.lockBox, this.gunCross);
    this.root.prepend(this.reticleSvg);
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.root);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  update(s: DogfightHudState): void {
    const ffa = s.standings.length > 2;
    this.root.classList.toggle('ffa', ffa);
    if (ffa) this.updateBoard(s);
    else {
      this.text(this.scoreMine, 'mine', String(s.myKills));
      this.text(this.scoreTheirs, 'theirs', String(s.opponentKills));
      this.text(this.scoreName, 'name', s.opponentName.toUpperCase());
    }
    this.text(this.scoreGoal, 'goal', `first to ${s.killsToWin}`);
    this.text(this.feed, 'feed', s.feed ?? '');

    const w = s.weapons;
    this.weaponsPanel.classList.toggle('off', !w);
    if (w) {
      this.heatFill.style.width = `${Math.round(Math.min(1, Math.max(0, w.gunHeat)) * 100)}%`;
      this.heatFill.classList.toggle('hot', w.gunHeat > 0.75 || w.gunOverheated);
      this.overheat.classList.toggle('visible', w.gunOverheated);
      this.text(this.missiles, 'msl', String(w.missiles));
      const l = lockLabel(w.missiles, w.lock);
      this.text(this.lock, 'lock', l.text);
      if (this.cache.get('lockCls') !== l.cls) {
        this.cache.set('lockCls', l.cls);
        this.lock.className = `df-lock ${l.cls}`;
      }
      this.lockFill.style.width = `${Math.round(Math.min(1, Math.max(0, w.lock)) * 100)}%`;
      this.text(this.flares, 'flr', String(w.flares));
    }
    const incoming = !!w?.incomingMissile;
    this.missileWarn.classList.toggle('visible', incoming);
    this.root.classList.toggle('incoming', incoming);

    this.updateReticle(s);
    this.updateCenter(s);
    this.updateResults(s);
  }

  private updateReticle(s: DogfightHudState): void {
    const r = s.reticle ?? null;
    this.reticleSvg.style.display = r ? '' : 'none';
    if (!r) return;
    // NDC y is up; SVG y is down.
    if (r.box) {
      this.lockBox.setAttribute('points', r.box.map(([x, y]) => `${x.toFixed(4)},${(-y).toFixed(4)}`).join(' '));
      this.lockBox.style.display = '';
    } else this.lockBox.style.display = 'none';
    const boxCls = `df-lockbox ${r.boxState}`;
    if (this.cache.get('boxCls') !== boxCls) {
      this.cache.set('boxCls', boxCls);
      this.lockBox.setAttribute('class', boxCls);
    }
    if (r.gun) {
      const [x, y0] = r.gun;
      const y = -y0;
      const rect = this.reticleSvg.getBoundingClientRect();
      const k = rect.height > 0 ? rect.width / rect.height : 1;
      const a = GUN_SIZE;
      const g = GUN_GAP;
      const ay = a * k;
      const gy = g * k;
      this.gunCross.setAttribute(
        'd',
        `M${x - a},${y}H${x - g}M${x + g},${y}H${x + a}M${x},${y - ay}V${y - gy}M${x},${y + gy}V${y + ay}`,
      );
      this.gunCross.style.display = '';
    } else this.gunCross.style.display = 'none';
    this.gunCross.classList.toggle('hit', r.gunHit);
  }

  /** Free-for-all scoreboard: one line per pilot, best first (rebuilt only when it changes). */
  private updateBoard(s: DogfightHudState): void {
    const key = s.standings.map((p) => `${p.id}:${p.kills}:${p.left ? 1 : 0}`).join('|');
    if (this.cache.get('board') === key) return;
    this.cache.set('board', key);
    this.board.replaceChildren(
      ...s.standings.map((p) => h('li', { class: `${p.self ? 'self' : ''} ${p.left ? 'left' : ''}`.trim() }, h('b', {}, String(p.kills)), ' ', p.name.toUpperCase())),
    );
  }

  private updateCenter(s: DogfightHudState): void {
    let title = '';
    let big = '';
    let sub = '';
    let kind = '';
    if (s.phase === 'countdown') {
      kind = 'countdown';
      title = s.standings.length > 2 ? `DOGFIGHT · ${s.standings.length}-WAY FREE-FOR-ALL` : `DOGFIGHT vs ${s.opponentName}`;
      big = String(Math.max(1, Math.ceil(s.countdown)));
      sub = `First to ${s.killsToWin} kills`;
    } else if (s.phase === 'dead' && s.respawnIn !== null) {
      kind = 'dead';
      title = s.deathText ?? 'DESTROYED';
      big = String(Math.max(1, Math.ceil(s.respawnIn)));
      sub = 'Respawning…';
    } else if (s.phase === 'fighting' && s.zoneTimer !== null) {
      kind = 'zone';
      title = s.zoneReason === 'ceiling' ? 'ABOVE THE CEILING – DESCEND' : 'LEAVING COMBAT ZONE – TURN BACK';
      big = Math.ceil(s.zoneTimer).toString();
      sub = 'Return to the zone or be destroyed';
    }
    this.center.className = `df-center ${kind}`.trim();
    this.text(this.centerTitle, 'cTitle', title);
    this.text(this.centerBig, 'cBig', big);
    this.text(this.centerSub, 'cSub', sub);
  }

  private updateResults(s: DogfightHudState): void {
    const show = s.phase === 'finished' && s.result !== null;
    if (show === this.resultsShown) return;
    this.resultsShown = show;
    this.results.classList.toggle('visible', show);
    if (!show || !s.result) return;
    this.results.dataset.result = s.result;
    this.resultsTitle.textContent = RESULT_TITLES[s.result];
    if (s.standings.length > 2) {
      this.resultsScore.textContent = s.standings.map((p, i) => `${i + 1}. ${p.name.toUpperCase()}  ${p.kills}`).join('\n');
    } else {
      this.resultsScore.textContent = `YOU ${s.myKills} – ${s.opponentKills} ${s.opponentName.toUpperCase()}`;
    }
    this.resultsNote.textContent =
      s.result === 'opponentLeft'
        ? s.standings.length > 2 ? 'Every opponent left the match' : `${s.opponentName} left the match`
        : s.result === 'victory'
          ? 'Air superiority achieved'
          : s.winnerName && s.standings.length > 2 ? `${s.winnerName} wins – better luck next time` : 'Better luck next time';
    this.backButton.focus();
  }

  private text(el: HTMLElement, key: string, value: string): void {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    el.textContent = value;
  }

  dispose(): void {
    this.root.remove();
  }
}
