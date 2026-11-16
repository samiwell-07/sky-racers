import { JET_CATALOG, getJetDefinition, type JetDefinition } from '../entities/jet/jetCatalog';
import type { CourseLibrary } from '../race/CourseLibrary';
import { courseSummary } from '../race/Course';
import { GhostStore } from '../race/Ghost';
import type { LeaderboardEntry } from '../race/Leaderboard';
import { categoryKey, describeConditions, recordCategory, STANDARD_TIME_TRIAL } from '../race/RecordCategory';
import { formatRaceClock } from '../race/Splits';
import { drawCoursePreview } from './CoursePreview';
import type { Leaderboard } from '../race/Leaderboard';
import type { SettingsStore } from '../settings/Settings';
import { button, checkbox, choiceButton, h, markBack, select, slider } from './dom';
import { HangarPreview } from './HangarPreview';
import { jetHandling } from './jetHandling';
import { findByKey, focusEl, focusInitial, focusKey, screenKey } from './menuFocus';
import type { SettingsPanel } from './SettingsPanel';
import './menu.css';

export interface MenuActions {
  startFreeFlight(): void;
  startRace(courseId: string): void;
  /** Flight school lesson list. */
  openFlightSchool(): void;
  /** Practice setup (unranked gate sections), optionally preselecting a course. */
  openPractice(courseId?: string): void;
  openMultiplayer(): void;
  resume(): void;
  restart(): void;
  quitToMenu(): void;
  /** Multiplayer: back to the lobby screen. */
  backToLobby(): void;
}

export const courseKey = (courseId: string, laps: number): string => `${courseId}@${laps}`;

/** Main menu, sub-screens and the in-game pause menu. */
export class MainMenu {
  private readonly root: HTMLDivElement;
  private selectedCourse = 'canyon-loop';
  /** Per screen: the control that had focus when the screen was left (restored on return). */
  private readonly focusMemory = new Map<string, string>();
  private lastFocusKey = '';
  private lastFocused: HTMLElement | null = null;
  private preview: HangarPreview | null = null;

  constructor(
    container: HTMLElement,
    private readonly settings: SettingsStore,
    private readonly courses: CourseLibrary,
    private readonly leaderboard: Leaderboard,
    private readonly settingsPanel: SettingsPanel,
    private readonly actions: MenuActions,
  ) {
    this.root = h('div', { class: 'menu-root hidden' });
    container.appendChild(this.root);
    // Screens that re-render themselves (settings tabs, key capture...) keep focus on the same control.
    this.root.addEventListener('focusin', (e) => {
      if (!(e.target instanceof HTMLElement)) return;
      this.lastFocused = e.target;
      this.lastFocusKey = focusKey(e.target);
    });
    new MutationObserver(() => {
      // Only when the focused control itself was replaced (not when the player clicked elsewhere).
      if (!this.visible || !this.lastFocused || this.lastFocused.isConnected) return;
      const a = document.activeElement;
      if (a && a !== document.body && this.root.contains(a)) return;
      this.lastFocused = null;
      if (!focusEl(findByKey(this.root, this.lastFocusKey))) focusInitial(this.root);
    }).observe(this.root, { childList: true, subtree: true });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Called before the overlay hides or switches/redraws its screen. */
  onScreenChange: (() => void) | null = null;

  hide(): void {
    this.onScreenChange?.();
    this.rememberFocus();
    this.closeHangar();
    this.root.classList.add('hidden');
  }

  /** Shows any panel in the menu overlay (used by the lobby screens too). */
  show(panel: HTMLElement, transparent = false): void {
    this.onScreenChange?.();
    this.rememberFocus();
    if (!panel.classList.contains('hangar-panel')) this.closeHangar();
    this.root.classList.remove('hidden');
    this.root.classList.toggle('transparent', transparent);
    this.root.replaceChildren(panel);
    // Returning to a screen (or re-rendering it) restores its focus; a new screen focuses its main control.
    const key = this.focusMemory.get(screenKey(panel));
    if (!(key && focusEl(findByKey(panel, key)))) focusInitial(panel);
  }

  private rememberFocus(): void {
    const prev = this.root.firstElementChild;
    const a = document.activeElement as HTMLElement | null;
    if (!prev || !a || !prev.contains(a)) return;
    // Left with Back: next time the screen opens fresh.
    if (a.hasAttribute('data-back')) this.focusMemory.delete(screenKey(prev));
    else this.focusMemory.set(screenKey(prev), focusKey(a));
  }

  showMain(): void {
    this.show(
      h(
        'div',
        { class: 'menu-panel' },
        h('h1', {}, 'SKY FLIGHT RACING'),
        h('p', { class: 'menu-sub' }, 'Low-level jet racing. No rudder: bank and pull to turn.'),
        h(
          'div',
          { class: 'menu-col' },
          button('Free flight', () => this.actions.startFreeFlight(), 'primary'),
          button('Race', () => this.showRaceSetup()),
          button('Practice', () => this.actions.openPractice()),
          button('Flight school', () => this.actions.openFlightSchool()),
          button('Multiplayer', () => this.actions.openMultiplayer()),
          button('Choose jet', () => this.showJetSelect()),
          button('Leaderboards', () => this.showLeaderboards()),
          button('Settings', () => this.show(this.settingsPanel.render(() => this.showMain()))),
        ),
      ),
    );
  }

  showPause(inRace: boolean, multiplayer = false): void {
    this.show(
      h(
        'div',
        { class: 'menu-panel' },
        h('h2', {}, multiplayer ? 'Menu' : 'Paused'),
        multiplayer ? h('p', { class: 'menu-sub' }, 'Multiplayer keeps running while this menu is open.') : null,
        h(
          'div',
          { class: 'menu-col' },
          Object.assign(markBack(button('Resume', () => this.actions.resume(), 'primary')), { autofocus: true }),
          button(!multiplayer && inRace ? 'Restart race' : 'Respawn', () => this.actions.restart()),
          button('Settings', () => this.show(this.settingsPanel.render(() => this.showPause(inRace, multiplayer)), true)),
          multiplayer
            ? button('Back to lobby', () => this.actions.backToLobby())
            : button('Quit to main menu', () => this.actions.quitToMenu()),
        ),
      ),
      true,
    );
  }

  /** Hangar: rotating 3D preview, role and relative handling of the selected jet. */
  private showJetSelect(): void {
    const preview = (this.preview ??= new HangarPreview());
    const view = h('div', { class: 'hangar-view' });
    const info = h('div', { class: 'hangar-info', 'aria-live': 'polite' });
    const choices = JET_CATALOG.map((j) =>
      choiceButton(
        [h('b', {}, j.name), h('span', { class: 'hangar-role' }, roleOf(j)), h('span', { class: 'hangar-badge' }, 'Selected')],
        false,
        () => choose(j),
        'hangar-choice',
      ),
    );
    const choose = (def: JetDefinition): void => {
      if (this.settings.values.jetId !== def.id) this.settings.set('jetId', def.id);
      JET_CATALOG.forEach((j, i) => {
        const on = j.id === def.id;
        choices[i]!.setAttribute('aria-pressed', String(on));
        choices[i]!.classList.toggle('selected', on);
      });
      info.replaceChildren(...hangarInfo(def));
      if (preview.available) preview.setJet(def);
    };
    const panel = h(
      'div',
      { class: 'menu-panel hangar-panel', 'data-screen': 'hangar' },
      h('h2', {}, 'Hangar'),
      h('p', { class: 'menu-sub' }, 'Choose your jet. Your choice is saved and used for your next flight.'),
      h(
        'div',
        { class: 'hangar' },
        h('div', { class: 'hangar-stage' }, view, info),
        h('div', { class: 'hangar-list', role: 'group', 'aria-label': 'Aircraft' }, ...choices),
      ),
      h('div', { class: 'menu-row' }, button('Back', () => this.showMain(), 'primary')),
    );
    choose(getJetDefinition(this.settings.values.jetId));
    this.show(panel);
    preview.attach(view);
    if (!preview.available) view.replaceChildren(h('p', { class: 'menu-sub' }, '3D preview unavailable.'));
  }

  private closeHangar(): void {
    this.preview?.detach();
  }

  private showRaceSetup(): void {
    const s = this.settings.values;
    const all = this.courses.all();
    if (!all.some((c) => c.id === this.selectedCourse)) this.selectedCourse = all[0]!.id;
    const course = all.find((c) => c.id === this.selectedCourse)!;
    const ghosts = new GhostStore();
    const preview = h('canvas', { width: 240, height: 170, class: 'course-preview', 'aria-label': `Top-down map of ${course.name}`, style: 'border-radius:6px;max-width:100%' });
    drawCoursePreview(preview, course);
    const facts = h('div', { class: 'menu-sub', style: 'text-align:left;line-height:1.5' });
    const conditionsInfo = h('p', { class: 'menu-sub', style: 'text-align:left' });
    const record = h('div', { style: 'text-align:left;line-height:1.5' });
    const km = (m: number): string => `${(m / 1000).toFixed(1)} km`;

    // Everything that depends on laps / course / jet / conditions; redrawn without rebuilding the controls.
    const refresh = (): void => {
      const laps = course.loop ? s.laps : 1;
      const sum = courseSummary(course, laps);
      const est = Math.round(sum.estimatedDuration);
      facts.replaceChildren(
        h('div', {}, h('b', {}, sum.type === 'loop' ? 'Circuit (laps)' : 'Point-to-point sprint')),
        h('div', {}, `Lap ${km(sum.lapLength)} · ${sum.gatesPerLap} gates per lap`),
        h('div', {}, `Race ${km(sum.raceLength)} · ${sum.totalGates} gates · ${sum.laps} lap${sum.laps === 1 ? '' : 's'}`),
        h('div', {}, `Estimated duration ≈ ${Math.floor(est / 60)}:${String(est % 60).padStart(2, '0')} (estimate, not a target)`),
      );
      const std = STANDARD_TIME_TRIAL;
      conditionsInfo.textContent =
        s.raceConditions === 'standard'
          ? `${std.name}: the same weather for everyone – wind ${std.windSpeed} m/s toward ${std.windDirection}° (east), turbulence ${Math.round(std.turbulence * 100)}%. Time of day and clouds stay as you set them (cosmetic). Preset values may be retuned in a later version.`
          : `Uses your World settings for wind and turbulence, rounded for the record (wind to 1 m/s, direction to 5°, turbulence to 5%). Records are kept separately for each set of conditions.`;
      const category = recordCategory(course, laps, s);
      const key = categoryKey(category);
      const best = this.leaderboard.best(key);
      const legacyBest = this.leaderboard.legacy(course.id, laps)[0];
      const jet = JET_CATALOG.find((j) => j.id === s.jetId)?.name ?? s.jetId;
      record.replaceChildren(
        h(
          'div',
          {},
          'Medal targets: ',
          h('span', { class: 'medal-gold' }, `Gold ${formatRaceClock(sum.medals.gold)}`),
          ' · ',
          h('span', { class: 'medal-silver' }, `Silver ${formatRaceClock(sum.medals.silver)}`),
          ' · ',
          h('span', { class: 'medal-bronze' }, `Bronze ${formatRaceClock(sum.medals.bronze)}`),
        ),
        h('div', {}, `Jet: ${jet} · ${describeConditions(category.conditions)}`),
        h('div', {}, h('b', {}, best ? `Your best (this jet, conditions and laps): ${formatRaceClock(best.time)} by ${best.name}` : 'No time yet for this jet, conditions and laps.')),
        h('div', {}, ghosts.has(key) ? 'Ghost reference: your best run in this category.' : 'No ghost reference yet – your next finish in this category sets one.'),
        legacyBest ? h('div', { class: 'menu-sub' }, `Legacy best (older rules, any jet/weather; not comparable): ${formatRaceClock(legacyBest.time)}`) : '',
      );
    };
    refresh();

    this.show(
      h(
        'div',
        { class: 'menu-panel' },
        h('h2', {}, 'Race'),
        select('Course', all.map((c) => [c.id, `${c.name}${c.loop ? ' (loop)' : ''}`]), () => this.selectedCourse, (v) => {
          this.selectedCourse = v;
          this.showRaceSetup();
        }),
        h('div', { class: 'menu-row', style: 'align-items:flex-start;flex-wrap:wrap;gap:12px' }, preview, facts),
        course.loop
          ? slider('Laps', 1, 5, 1, () => s.laps, (v) => {
              this.settings.set('laps', v);
              refresh();
            })
          : h('p', { class: 'menu-sub' }, 'Point-to-point sprint (1 lap).'),
        select<'standard' | 'custom'>('Conditions', [['standard', 'Standard time trial'], ['custom', 'Custom world conditions']], () => s.raceConditions, (v) => {
          this.settings.set('raceConditions', v);
          refresh();
        }),
        conditionsInfo,
        slider('AI opponents', 0, 5, 1, () => s.aiOpponents, (v) => this.settings.set('aiOpponents', v)),
        slider('AI skill', 0.2, 1, 0.05, () => s.aiSkill, (v) => this.settings.set('aiSkill', v), (v) => `${Math.round(v * 100)}%`),
        checkbox('Race against my best ghost', () => s.showGhost, (v) => this.settings.set('showGhost', v)),
        record,
        this.settings.lastSaveError ? h('p', { style: 'color:#ff8a3d' }, `Settings could not be saved (${this.settings.lastSaveError}); they apply until you close the game.`) : null,
        h('div', { class: 'menu-row' }, button('Start race', () => this.actions.startRace(this.selectedCourse), 'primary'), button('Practice a section', () => this.actions.openPractice(this.selectedCourse)), markBack(button('Back', () => this.showMain()))),
      ),
    );
  }

  private showLeaderboards(): void {
    const s = this.settings.values;
    const all = this.courses.all();
    const course = all.find((c) => c.id === this.selectedCourse) ?? all[0]!;
    const laps = course.loop ? s.laps : 1;
    const current = recordCategory(course, laps, s);
    const currentKey = categoryKey(current);
    const jetName = (id: string): string => JET_CATALOG.find((j) => j.id === id)?.name ?? id;
    const table = (entries: LeaderboardEntry[]): HTMLElement =>
      h(
        'table',
        { class: 'menu-table' },
        h('tr', {}, ...['#', 'Pilot', 'Jet', 'Time', 'Medal', 'Date'].map((t) => h('th', {}, t))),
        ...entries.map((e, i) =>
          h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, e.name), h('td', {}, jetName(e.jetId)), h('td', {}, formatRaceClock(e.time)), h('td', { class: e.medal ? `medal-${e.medal}` : '' }, e.medal ?? '—'), h('td', {}, e.date)),
        ),
      );
    const entries = this.leaderboard.get(currentKey);
    const others = this.leaderboard
      .categories(course.id)
      .filter((c) => c.key !== currentKey)
      .map((c) => ({ ...c, best: this.leaderboard.best(c.key) }))
      .filter((c) => c.best)
      .sort((a, b) => a.category.laps - b.category.laps || a.best!.time - b.best!.time);
    const legacy = this.leaderboard.legacy(course.id, laps);
    this.show(
      h(
        'div',
        { class: 'menu-panel' },
        h('h2', {}, 'Leaderboards'),
        select('Course', all.map((c) => [c.id, c.name]), () => course.id, (v) => {
          this.selectedCourse = v;
          this.showLeaderboards();
        }),
        h('p', { class: 'menu-sub' }, `${course.loop ? `${laps} lap${laps === 1 ? '' : 's'}` : 'Sprint'} · ${jetName(current.jetId)} · ${describeConditions(current.conditions)} (change in Race setup / Choose jet)`),
        entries.length ? table(entries) : h('p', {}, 'No times yet for this jet and conditions. Go race!'),
        others.length
          ? h(
              'div',
              {},
              h('h3', {}, 'Other jets / conditions / laps'),
              h(
                'table',
                { class: 'menu-table' },
                h('tr', {}, ...['Laps', 'Jet', 'Conditions', 'Best', 'Pilot'].map((t) => h('th', {}, t))),
                ...others.map((o) => h('tr', {}, h('td', {}, String(o.category.laps)), h('td', {}, jetName(o.category.jetId)), h('td', {}, describeConditions(o.category.conditions)), h('td', {}, formatRaceClock(o.best!.time)), h('td', {}, o.best!.name))),
              ),
            )
          : null,
        legacy.length
          ? h('div', {}, h('h3', {}, 'Legacy'), h('p', { class: 'menu-sub' }, 'Times from before records were separated by jet and conditions (older rules). Kept for reference, not compared.'), table(legacy))
          : null,
        h('div', { class: 'menu-row' }, markBack(button('Back', () => this.showMain(), 'primary'))),
      ),
    );
  }
}

/** Short role from the catalog description ("Heavy interceptor: ..." -> "Heavy interceptor"). */
const roleOf = (j: JetDefinition): string => j.description.split(/[.:]/)[0]!.trim();

function hangarInfo(def: JetDefinition): Node[] {
  const traits = jetHandling(def);
  return [
    h('h3', { class: 'hangar-name' }, def.name),
    h('p', { class: 'hangar-desc' }, def.description),
    h(
      'dl',
      { class: 'hangar-traits' },
      ...traits.flatMap((t) => {
        const fill = h('span', { class: 'hangar-fill' });
        fill.style.width = `${Math.round(t.bar * 100)}%`;
        return [
          h('dt', {}, t.label),
          h('dd', {}, h('span', { class: 'hangar-bar', 'aria-hidden': 'true' }, fill), h('span', { class: 'hangar-verdict' }, t.verdict)),
        ];
      }),
    ),
    h('p', { class: 'hangar-note' }, 'Tendencies relative to the standard airframe (middle mark), derived from each jet\'s flight settings. Not measured figures.'),
  ];
}
