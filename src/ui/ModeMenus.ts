import type { CourseDef } from '../race/Course';
import { formatRaceClock } from '../race/Splits';
import { LESSONS, type LessonDef, type LessonProgressStore } from '../modes/lessons';
import { describeSection, selectSection, type PracticeChoice } from '../modes/PracticeSession';
import type { SaveResult } from '../settings/safeStorage';
import { button, checkbox, h, markBack, select, slider } from './dom';

/** Menu screens for the flight school and practice modes (shown through MainMenu.show). */

export function lessonListPanel(progress: LessonProgressStore, onStart: (l: LessonDef) => void, onBack: () => void): HTMLElement {
  const done = LESSONS.filter((l) => progress.isComplete(l.id)).length;
  return h(
    'div',
    { class: 'menu-panel', 'data-screen': 'flight-school' },
    h('h2', {}, 'Flight school'),
    h('p', { class: 'menu-sub' }, `Short guided lessons with calm wind and daylight. Retry (R) or leave (pause menu) at any time. Lessons never count as race records. ${done}/${LESSONS.length} complete.`),
    h(
      'div',
      { class: 'menu-col' },
      ...LESSONS.map((l, i) => {
        const b = button(`${i + 1}. ${l.title}${progress.isComplete(l.id) ? '  ✓' : ''}`, () => onStart(l), i === firstOpen(progress) ? 'primary' : '');
        b.title = l.objective;
        b.setAttribute('aria-description', `${l.objective}${progress.isComplete(l.id) ? ' Completed.' : ''}`);
        return b;
      }),
    ),
    h('div', { class: 'menu-row' }, markBack(button('Back', onBack))),
  );
}

const firstOpen = (progress: LessonProgressStore): number => {
  const i = LESSONS.findIndex((l) => !progress.isComplete(l.id));
  return i < 0 ? 0 : i;
};

export function lessonCompletePanel(
  lesson: LessonDef,
  next: LessonDef | null,
  save: SaveResult,
  a: { onNext: () => void; onRetry: () => void; onList: () => void; onMenu: () => void },
): HTMLElement {
  return h(
    'div',
    { class: 'menu-panel', 'data-screen': 'lesson-complete' },
    h('h2', {}, 'Lesson complete'),
    h('p', {}, h('b', {}, lesson.title), ` – ${lesson.objective}`),
    save.ok ? null : h('p', { style: 'color:#ff8a3d' }, `Your progress could not be saved (${save.error}); it is remembered until you close the game.`),
    h(
      'div',
      { class: 'menu-col' },
      next ? button(`Next lesson: ${next.title}`, a.onNext, 'primary') : h('p', { class: 'menu-sub' }, 'That was the last lesson. Try a race or practice a section!'),
      button('Retry lesson', a.onRetry, next ? '' : 'primary'),
      markBack(button('Lesson list', a.onList)),
      button('Quit to main menu', a.onMenu),
    ),
  );
}

export function modePausePanel(
  kind: 'lesson' | 'practice',
  a: { onResume: () => void; onRestart: () => void; onChoose: () => void; onSettings: () => void; onMenu: () => void },
): HTMLElement {
  return h(
    'div',
    { class: 'menu-panel', 'data-screen': `${kind}-pause` },
    h('h2', {}, 'Paused'),
    h('p', { class: 'menu-sub' }, kind === 'lesson' ? 'Flight school' : 'PRACTICE – unranked'),
    h(
      'div',
      { class: 'menu-col' },
      markBack(button('Resume', a.onResume, 'primary')),
      button(kind === 'lesson' ? 'Restart lesson' : 'Retry section', a.onRestart),
      button(kind === 'lesson' ? 'Lesson list' : 'Change section', a.onChoose),
      button('Settings', a.onSettings),
      button('Quit to main menu', a.onMenu),
    ),
  );
}

/**
 * Practice setup: course, first gate, number of gates (loops wrap past the start/finish), timer.
 * `show` re-renders the screen when the course changes.
 */
export function practiceSetupPanel(
  courses: CourseDef[],
  choice: PracticeChoice,
  onStart: (c: PracticeChoice) => void,
  onBack: () => void,
  show: (panel: HTMLElement) => void,
  best?: (c: PracticeChoice) => number | null,
): HTMLElement {
  const course = courses.find((c) => c.id === choice.courseId) ?? courses[0];
  const c: PracticeChoice = { ...choice, courseId: course?.id ?? '' };
  const n = course?.gates.length ?? 0;
  const info = h('p', { class: 'menu-sub', 'aria-live': 'polite', style: 'text-align:left' });
  const start = button('Start practice', () => onStart({ ...c }), 'primary');
  const refresh = (): void => {
    const r = course ? selectSection(n, course.loop, c.start, c.count) : { ok: false as const, error: 'No course available.' };
    start.disabled = !r.ok;
    if (!r.ok) {
      info.textContent = r.error;
      info.style.color = '#ff8a3d';
      return;
    }
    info.style.color = '';
    const b = best?.(c) ?? null;
    info.textContent = `${describeSection(r.section)}${b !== null ? ` · best this session ${formatRaceClock(b)}` : ''}`;
  };
  if (n > 0) {
    c.start = Math.min(Math.max(0, Math.round(c.start)), n - 1);
    c.count = Math.min(Math.max(1, Math.round(c.count)), n);
  }
  refresh();
  return h(
    'div',
    { class: 'menu-panel', 'data-screen': 'practice' },
    h('h2', {}, 'Practice'),
    h('p', { class: 'menu-sub' }, 'PRACTICE – unranked. Fly a section of gates as often as you like: R retries from the section start, a crash puts you back before the next gate of the section. Real handling, collisions and damage; nothing is saved to the leaderboard or the ghosts.'),
    select('Course', courses.map((x) => [x.id, `${x.name}${x.loop ? ' (loop)' : ''}`]), () => c.courseId, (v) => {
      show(practiceSetupPanel(courses, { ...c, courseId: v, start: 0, count: Math.min(5, courses.find((x) => x.id === v)?.gates.length ?? 1) }, onStart, onBack, show, best));
    }),
    n > 0
      ? slider('First gate', 1, n, 1, () => c.start + 1, (v) => {
          c.start = v - 1;
          refresh();
        })
      : null,
    n > 0
      ? slider('Gates', 1, n, 1, () => c.count, (v) => {
          c.count = v;
          refresh();
        })
      : null,
    checkbox('Section timer', () => c.timed, (v) => (c.timed = v)),
    info,
    h('div', { class: 'menu-row' }, start, markBack(button('Back', onBack))),
  );
}
