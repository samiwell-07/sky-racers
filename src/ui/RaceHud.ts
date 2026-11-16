import type { Medal } from '../race/Leaderboard';
import type { LeaderboardEntry } from '../race/Leaderboard';
import { describeSplit, formatRaceClock, type SplitState } from '../race/Splits';
import { JET_CATALOG } from '../entities/jet/jetCatalog';
import { button, h } from './dom';
import './menu.css';

export interface RaceHudData {
  countdown: number | null;
  /** Scoring time (s): race clock from GO plus penalties, frozen at the finish. */
  raceTime: number;
  lap: number;
  laps: number;
  gate: number;
  gates: number;
  position: number;
  racers: number;
  penalties: number;
  /** Latest split vs the reference ghost; persists until the next gate. */
  split: SplitState;
  standings: string[];
}

export interface RaceResults {
  courseName: string;
  time: number;
  penalties: number;
  medal: Medal;
  rank: number;
  position: number;
  racers: number;
  newBest: boolean;
  ranked?: boolean;
  /** null/undefined = no save attempted. */
  ghostSaved?: boolean | null;
  leaderboardSaved?: boolean | null;
  top: LeaderboardEntry[];
  split?: SplitState;
  categoryLabel?: string;
  multiplayer?: boolean;
  onRestart: () => void;
  onMenu: () => void;
}

const TONE_COLOR: Record<'ahead' | 'behind' | 'even' | 'none', string> = { ahead: '', behind: '', even: '#e8eef5', none: '#b8c4d0' };

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Race overlay: countdown, position, lap, race clock, penalties, persistent ghost split; plus the results screen. */
export class RaceHud {
  private readonly root: HTMLDivElement;
  private readonly countdownEl: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly results: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.countdownEl = h('div', { class: 'race-center' });
    this.panel = h('div', { class: 'hud-panel race-panel' });
    this.results = h('div', { class: 'menu-root hidden' });
    this.root = h('div', { class: 'hud' }, this.countdownEl, this.panel);
    this.root.style.display = 'none';
    container.append(this.root, this.results);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    if (!v) this.hideResults();
  }

  update(d: RaceHudData, _dt = 0): void {
    this.countdownEl.textContent = d.countdown === null ? '' : d.countdown > 0 ? String(Math.ceil(d.countdown)) : 'GO!';
    const s = describeSplit(d.split);
    const color = TONE_COLOR[s.tone];
    const split = `<div class="race-delta ${s.tone}"${color ? ` style="color:${color}"` : ''}><b>${escapeHtml(s.text)}</b><div style="font-size:12px;opacity:0.8">${escapeHtml(s.label)}</div></div>`;
    this.panel.innerHTML = `
      <div>POS <span class="big">${d.position}</span>/${d.racers}</div>
      <div>LAP <b>${Math.min(d.lap, d.laps)}/${d.laps}</b> · GATE <b>${Math.min(d.gate + 1, d.gates)}/${d.gates}</b></div>
      <div class="big" style="font-variant-numeric:tabular-nums">${formatRaceClock(d.raceTime)}</div>
      <div style="color:${d.penalties > 0 ? '#ff8a3d' : 'inherit'};opacity:${d.penalties > 0 ? 1 : 0.6}">Penalties +${d.penalties} s</div>
      ${split}
      <div class="race-standings">${d.standings.join('<br>')}</div>`;
  }

  showResults(r: RaceResults): void {
    const medalText = r.medal ? `${r.medal.toUpperCase()} MEDAL` : 'No medal';
    const ranked = r.ranked ?? true;
    const table = r.top.length
      ? h(
          'table',
          { class: 'menu-table' },
          ...r.top.slice(0, 5).map((e, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, e.name), h('td', {}, JET_CATALOG.find((j) => j.id === e.jetId)?.name ?? ''), h('td', {}, formatRaceClock(e.time)), h('td', { class: e.medal ? `medal-${e.medal}` : '' }, e.medal ?? ''))),
        )
      : null;
    const split = r.split ? describeSplit(r.split) : null;
    const notices: Array<HTMLElement | null> = [
      !ranked ? h('p', { class: 'menu-sub' }, 'Unranked run – no leaderboard entry or ghost is saved.') : null,
      r.newBest ? h('p', {}, r.ghostSaved ? 'New personal best! Your ghost was saved.' : 'New personal best! Ghost could not be saved (browser storage unavailable or full).') : null,
      r.leaderboardSaved === false ? h('p', { style: 'color:#ff8a3d' }, 'Leaderboard could not be saved. This result is kept until you close the game.') : null,
      r.rank > 0 ? h('p', {}, `Leaderboard rank #${r.rank}`) : null,
    ];
    this.results.replaceChildren(
      h(
        'div',
        { class: 'menu-panel' },
        h('h2', {}, `${r.courseName} – Finished`),
        h('p', { class: 'menu-sub' }, `Position ${r.position}/${r.racers}${r.categoryLabel ? ` · ${r.categoryLabel}` : ''}`),
        h(
          'div',
          { class: 'race-panel', style: 'position:static;text-align:left' },
          h('div', { class: 'big' }, formatRaceClock(r.time)),
          r.penalties ? h('div', {}, `includes +${r.penalties} s penalties`) : null,
          split ? h('div', {}, `Final split vs best ghost: ${split.text}`) : null,
        ),
        h('h3', { class: r.medal ? `medal-${r.medal}` : '' }, medalText),
        ...notices,
        table,
        r.multiplayer
          ? h('div', { class: 'menu-row' }, button('Back to lobby', r.onMenu, 'primary'))
          : h('div', { class: 'menu-row' }, button('Race again', r.onRestart, 'primary'), button('Main menu', r.onMenu)),
      ),
    );
    this.results.classList.remove('hidden');
  }

  hideResults(): void {
    this.results.classList.add('hidden');
  }
}
