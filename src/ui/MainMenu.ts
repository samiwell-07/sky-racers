import { JET_CATALOG, type JetDefinition } from '../entities/jet/jetCatalog';
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
import { hangarCustomize } from './HangarCustomize';
import { jetHandling } from './jetHandling';
import { findByKey, focusEl, focusInitial, focusKey, screenKey, setMenuNavHandler } from './menuFocus';
import type { SettingsPanel } from './SettingsPanel';
import type { LobbyMode } from '../net/lobbyTypes';
import type { RaceDifficulty, RaceLayout } from '../race/generatedCourse';
import { generateCourseForRequest } from '../race/CourseGenerator';
import { randomSeedText, seedFromText } from '../utils/seed';
import { CLASSIC_WORLD, type WorldSpec } from '../world/gen/WorldGenerator';
import './menu.css';

export interface MenuActions {
  startFreeFlight(world: WorldSpec): void;
  /** Built-in Classic Canyon course. */
  startRace(courseId: string): void;
  /** Race generated from a seeded world. */
  startGeneratedRace(world: WorldSpec, difficulty: RaceDifficulty, layout: RaceLayout, laps: number): void;
  /** Flight school lesson list. */
  openFlightSchool(): void;
  /** Practice setup (unranked gate sections), optionally preselecting a course. */
  openPractice(courseId?: string): void;
  /** Multiplayer lobby browser; `mode` preselects the mode of a lobby created from it. */
  openMultiplayer(mode?: LobbyMode): void;
  resume(): void;
  restart(): void;
  quitToMenu(): void;
  /** Multiplayer: back to the lobby screen. */
  backToLobby(): void;
}

export const courseKey = (courseId: string, laps: number): string => `${courseId}@${laps}`;

export interface AircraftSelectionOptions {
  initialId: string;
  allowPilotsChoice?: boolean;
  onConfirm(id: string): string | null;
  onBack(): void;
}

/** Main menu, sub-screens and the in-game pause menu. */
export class MainMenu {
  private readonly root: HTMLDivElement;
  private selectedCourse = 'canyon-loop';
  /** Invalidates pending generated-course previews when the setup screen is redrawn. */
  private courseToken = 0;
  /** Per screen: the control that had focus when the screen was left (restored on return). */
  private readonly focusMemory = new Map<string, string>();
  private lastFocusKey = '';
  private lastFocused: HTMLElement | null = null;
  private preview: HangarPreview | null = null;
  private hangarOpen = false;
  private releaseHangarNav: (() => void) | null = null;

  get hangarVisible(): boolean { return this.hangarOpen && this.visible; }
  get currentPanel(): HTMLElement | null { return this.root.firstElementChild as HTMLElement | null; }

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
    this.root.classList.toggle('hangar-open', panel.classList.contains('hangar-panel'));
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
    const action = (label: string, description: string, onClick: () => void, primary = false): HTMLButtonElement => {
      const el = button(label, onClick, `menu-launch${primary ? ' primary' : ''}`);
      el.setAttribute('aria-label', label);
      el.replaceChildren(
        h('span', { class: 'menu-launch-title' }, label),
        h('span', { class: 'menu-launch-desc' }, description),
      );
      return el;
    };
    this.show(
      h(
        'div',
        { class: 'menu-panel menu-home' },
        h('p', { class: 'menu-eyebrow' }, 'FLIGHT DECK'),
        h('h1', {}, 'SKY FLIGHT RACING'),
        h('p', { class: 'menu-sub' }, 'Low-level jet racing. No rudder: bank and pull to turn.'),
        h(
          'div',
          { class: 'menu-launch-grid' },
          action('Free flight', 'Your jet. Your world. No limits.', () => this.showFreeFlightSetup(), true),
          action('Race', 'Chase gates. Beat the clock.', () => this.showRaceSetup()),
          action('Practice', 'Build confidence. Find your line.', () => this.showPracticeMenu()),
          action('Multiplayer', 'Share the skies with friends.', () => this.actions.openMultiplayer()),
          action('Choose jet', 'Find your next airframe.', () => this.showJetSelect()),
          action('Leaderboards', 'See how your best runs stack up.', () => this.showLeaderboards()),
          action('Settings', 'Fine-tune your flight experience.', () => this.show(this.settingsPanel.render(() => this.showMain()))),
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
          button('Settings', () => this.show(this.settingsPanel.render(() => this.showPause(inRace, multiplayer), multiplayer), true)),
          multiplayer
            ? button('Back to lobby', () => this.actions.backToLobby())
            : button('Quit to main menu', () => this.actions.quitToMenu()),
        ),
      ),
      true,
    );
  }

  /** Shared, transactional aircraft picker for the main menu and multiplayer callers. */
  showJetSelect(options: AircraftSelectionOptions = {
    initialId: this.settings.values.jetId,
    onConfirm: (id) => {
      const previous = this.settings.values.jetId;
      this.settings.set('jetId', id);
      const error = this.settings.lastSaveError;
      if (error) {
        this.settings.set('jetId', previous);
        return `Could not remember your aircraft: ${error}`;
      }
      this.showMain();
      return null;
    },
    onBack: () => this.showMain(),
  }): void {
    this.closeHangar();
    const preview = (this.preview ??= new HangarPreview());
    const view = h('div', { class: 'hangar-view' });
    const info = h('div', { class: 'hangar-info', 'aria-live': 'polite' });
    const status = h('p', { class: 'hangar-location', 'aria-live': 'polite' });
    const error = h('p', { class: 'menu-error', role: 'alert' });
    let index = Math.max(0, JET_CATALOG.findIndex((j) => j.id === options.initialId));
    let pilotsChoice = !!options.allowPilotsChoice && options.initialId === '';
    const choose = (delta: number): void => {
      if (!pilotsChoice) index = Math.max(0, Math.min(JET_CATALOG.length - 1, index + delta));
      pilotsChoice = false;
      update();
      if (preview.available) preview.select(index);
    };
    const previous = button('Previous jet', () => choose(-1));
    const next = button('Next jet', () => choose(1));
    const confirm = button('Confirm aircraft', () => {
      if (!this.hangarOpen) return;
      error.textContent = options.onConfirm(pilotsChoice ? '' : JET_CATALOG[index]!.id) ?? '';
    }, 'primary');
    const stage = h('button', { type: 'button', class: 'hangar-inspect', 'data-autofocus': '', 'aria-label': 'Inspect aircraft. Left and right to browse; Enter or Space to confirm.', onclick: () => confirm.click() });
    const pilotRule = options.allowPilotsChoice
      ? choiceButton(["Pilot's choice"], pilotsChoice, () => { pilotsChoice = true; update(); }, 'hangar-pilot-rule')
      : null;
    const update = (): void => {
      const def = JET_CATALOG[index]!;
      previous.disabled = !pilotsChoice && index === 0;
      next.disabled = !pilotsChoice && index === JET_CATALOG.length - 1;
      pilotRule?.setAttribute('aria-pressed', String(pilotsChoice));
      status.textContent = pilotsChoice ? "HOST RULE · Pilot's choice" : `HANGAR ${Math.floor(index / 2) + 1} / 3 · BAY ${index % 2 + 1} · ${index + 1} / ${JET_CATALOG.length}`;
      info.replaceChildren(...(pilotsChoice
        ? [h('h3', { class: 'hangar-name' }, "Pilot's choice"), h('p', {}, 'Each pilot chooses their own aircraft.')]
        : hangarInfo(def)));
      stage.setAttribute('aria-label', `${pilotsChoice ? "Pilot's choice" : def.name}. Left and right to browse; Enter or Space to confirm.`);
      error.textContent = '';
    };
    const customize = options.allowPilotsChoice ? null : button('Customize', () => {
      const bay = index;
      const editor = hangarCustomize(JET_CATALOG[bay]!, (a) => preview.previewAppearance(bay, a), (saved) => {
        panel.replaceChildren(view, header, stage, info, controls);
        if (saved) status.textContent += ' · Appearance saved';
        focusEl(customize);
        enableBrowse();
      });
      this.releaseHangarNav?.();
      this.releaseHangarNav = null;
      update();
      panel.replaceChildren(view, header, editor.panel, editor.controls);
      focusEl(editor.panel.querySelector('select'));
    });
    const header = h('header', { class: 'hangar-header' }, h('h2', {}, 'Aircraft hangars'), status);
    const controls = h('footer', { class: 'hangar-controls' }, error,
      h('div', { class: 'menu-row' }, previous, next, pilotRule, customize, confirm, button('Back', () => { if (this.hangarOpen) options.onBack(); })),
      h('p', { class: 'hangar-help' }, '← / → on aircraft to browse · Tab / d-pad to move · Enter / Space / A activate · Esc / B back'),
    );
    const panel = h(
      'div',
      { class: 'menu-panel hangar-panel', 'data-screen': 'hangar' },
      view,
      header,
      stage,
      info,
      controls,
    );
    update();
    this.show(panel);
    this.hangarOpen = true;
    const enableBrowse = (): void => {
      this.releaseHangarNav = setMenuNavHandler(panel, (action) => {
        if (document.activeElement !== stage || (action !== 'left' && action !== 'right')) return false;
        choose(action === 'left' ? -1 : 1);
        return true;
      });
    };
    enableBrowse();
    preview.attach(view, index);
    if (!preview.available) view.replaceChildren(h('p', { class: 'hangar-unavailable', role: 'status' }, '3D hangar unavailable. Use Previous / Next to browse the aircraft information, then Confirm or Back.'));
  }

  private closeHangar(): void {
    this.hangarOpen = false;
    this.releaseHangarNav?.();
    this.releaseHangarNav = null;
    this.preview?.detach();
  }

  /** The world chosen for solo play (rolls and remembers a seed if none is set yet). */
  private chosenWorld(): WorldSpec {
    const s = this.settings.values;
    if (s.worldSource === 'classic') return CLASSIC_WORLD;
    if (!s.worldSeed.trim()) this.settings.set('worldSeed', randomSeedText());
    return { kind: 'seeded', seed: seedFromText(s.worldSeed) };
  }

  /** "Seeded world" (seed text + Random) or "Classic Canyon"; `redraw` re-renders the screen. */
  private worldChooser(redraw: () => void): HTMLElement {
    const s = this.settings.values;
    this.chosenWorld();
    const seeded = s.worldSource === 'seeded';
    const seedInput = h('input', { type: 'text', value: s.worldSeed, maxLength: 32, 'aria-label': 'World seed', spellcheck: false });
    seedInput.addEventListener('change', () => {
      this.settings.set('worldSeed', seedInput.value.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32));
      redraw();
    });
    return h(
      'div',
      { class: 'menu-col' },
      select<'seeded' | 'classic'>('World', [['seeded', 'Seeded world'], ['classic', 'Classic Canyon']], () => s.worldSource, (v) => {
        this.settings.set('worldSource', v);
        redraw();
      }),
      seeded
        ? h(
            'div',
            { class: 'menu-row', style: 'align-items:center;gap:8px' },
            h('label', { class: 'menu-field', style: 'flex:1' }, h('span', {}, 'Seed'), seedInput),
            button('Random', () => {
              this.settings.set('worldSeed', randomSeedText());
              redraw();
            }, 'small'),
          )
        : null,
      h(
        'p',
        { class: 'menu-sub' },
        seeded
          ? 'Every seed is its own endless world of valleys, mountains, rivers, oceans, roads and cities. Same seed = same world (share it with friends).'
          : 'The original hand-made canyon with its built-in courses and records.',
      ),
    );
  }

  private showFreeFlightSetup(): void {
    this.show(
      h(
        'div',
        { class: 'menu-panel', 'data-screen': 'free-setup' },
        h('h2', {}, 'Free flight'),
        this.worldChooser(() => this.showFreeFlightSetup()),
        checkbox('Start on the runway', () => this.settings.values.startOnRunway, (v) => this.settings.set('startOnRunway', v)),
        h('div', { class: 'menu-row' }, button('Fly', () => this.actions.startFreeFlight(this.chosenWorld()), 'primary'), markBack(button('Back', () => this.showMain()))),
      ),
    );
  }

  /** Practice: choose between the guided flight school and free gate-section practice. */
  showPracticeMenu(): void {
    this.show(
      h(
        'div',
        { class: 'menu-panel', 'data-screen': 'practice-menu' },
        h('h2', {}, 'Practice'),
        h('p', { class: 'menu-sub' }, 'Unranked training: nothing here affects your records.'),
        h(
          'div',
          { class: 'menu-col' },
          button('Flight school', () => this.actions.openFlightSchool(), 'primary'),
          h('p', { class: 'menu-sub' }, 'Guided lessons, from the basics to advanced manoeuvres.'),
          button('Gate sections', () => this.actions.openPractice()),
          h('p', { class: 'menu-sub' }, 'Pick a course section and fly it again and again.'),
        ),
        h('div', { class: 'menu-row' }, markBack(button('Back', () => this.showMain()))),
      ),
    );
  }

  private showRaceSetup(): void {
    if (this.settings.values.worldSource === 'seeded') this.showGeneratedRaceSetup();
    else this.showClassicRaceSetup();
  }

  /** Race on a seeded world: the course is generated from the seed, difficulty and layout. */
  private showGeneratedRaceSetup(): void {
    const s = this.settings.values;
    const redraw = (): void => this.showRaceSetup();
    const courseName = h('h3', { class: 'menu-sub', style: 'margin:6px 0 2px' }, 'Generating course…');
    const preview = h('canvas', { width: 240, height: 170, class: 'course-preview', 'aria-label': 'Top-down map of the generated course', style: 'border-radius:6px;max-width:100%' });
    const facts = h('div', { class: 'menu-sub', style: 'text-align:left;line-height:1.5' });
    const token = ++this.courseToken;
    // Generation takes a moment the first time (cached afterwards): let the screen paint first.
    setTimeout(() => {
      if (token !== this.courseToken || !courseName.isConnected) return;
      try {
        const def = generateCourseForRequest({ world: this.chosenWorld(), difficulty: s.raceDifficulty, layout: s.raceLayout });
        const sum = courseSummary(def, s.raceLayout === 'loop' ? s.laps : 1);
        courseName.textContent = def.name;
        drawCoursePreview(preview, def);
        facts.textContent = `${sum.gatesPerLap} gates · ${(sum.raceLength / 1000).toFixed(1)} km · about ${Math.round(sum.estimatedDuration)} s`;
      } catch (err) {
        console.warn('Course generation failed', err);
        courseName.textContent = 'Course generation failed for this seed';
      }
    }, 30);
    this.show(
      h(
        'div',
        { class: 'menu-panel', 'data-screen': 'race-setup' },
        h('h2', {}, 'Race'),
        this.worldChooser(redraw),
        select<RaceDifficulty>('Difficulty', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], () => s.raceDifficulty, (v) => {
          this.settings.set('raceDifficulty', v);
          redraw();
        }),
        select<RaceLayout>('Layout', [['loop', 'Loop (laps)'], ['sprint', 'Sprint (point to point)']], () => s.raceLayout, (v) => {
          this.settings.set('raceLayout', v);
          redraw();
        }),
        s.raceLayout === 'loop' ? slider('Laps', 1, 5, 1, () => s.laps, (v) => this.settings.set('laps', v)) : null,
        h('p', { class: 'menu-sub' }, 'A challenging course is generated for this seed through its valleys, canyons, rivers, under bridges and between towers. Same seed + difficulty + layout = the same course.'),
        courseName,
        preview,
        facts,
        slider('AI opponents', 0, 5, 1, () => s.aiOpponents, (v) => this.settings.set('aiOpponents', v)),
        slider('AI skill', 0.2, 1, 0.05, () => s.aiSkill, (v) => this.settings.set('aiSkill', v), (v) => `${Math.round(v * 100)}%`),
        checkbox('Race against my best ghost', () => s.showGhost, (v) => this.settings.set('showGhost', v)),
        h(
          'div',
          { class: 'menu-row' },
          button('Start race', () => this.actions.startGeneratedRace(this.chosenWorld(), s.raceDifficulty, s.raceLayout, s.raceLayout === 'loop' ? s.laps : 1), 'primary'),
          markBack(button('Back', () => this.showMain())),
        ),
      ),
    );
  }

  private showClassicRaceSetup(): void {
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
        { class: 'menu-panel', 'data-screen': 'race-setup' },
        h('h2', {}, 'Race'),
        this.worldChooser(() => this.showRaceSetup()),
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
