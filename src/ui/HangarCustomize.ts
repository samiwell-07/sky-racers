import { FACTORY_APPEARANCE, loadJetAppearance, saveJetAppearance, type JetAppearance } from '../entities/jet/jetAppearance';
import type { JetDefinition } from '../entities/jet/jetCatalog';
import { button, h, select } from './dom';

const digits: [string, string][] = [['', 'None'], ...Array.from('0123456789', (d): [string, string] => [d, d])];
const choices = <T extends string>(...values: T[]): [T, string][] =>
  values.map((v) => [v, v.charAt(0).toUpperCase() + v.slice(1)]);

export function hangarCustomize(jet: JetDefinition, preview: (a: JetAppearance) => void, close: (saved: boolean) => void) {
  const original = loadJetAppearance(jet.id);
  let draft = { ...original };
  const fields = h('div', { class: 'hangar-fields' });
  const error = h('p', { class: 'menu-error', role: 'alert' });
  const status = h('p', { class: 'hangar-help', role: 'status' });
  function change(patch: Partial<JetAppearance>): void {
    draft = { ...draft, ...patch };
    preview(draft);
    error.textContent = '';
    status.textContent = '';
  }
  function renderFields(): void {
    const second = select('Second digit', digits, () => draft.raceNumber.charAt(1),
      (v) => change({ raceNumber: draft.raceNumber.charAt(0) + v }));
    const secondDigit = second.querySelector('select')!;
    secondDigit.disabled = !draft.raceNumber;
    const first = select('First digit', digits, () => draft.raceNumber.charAt(0), (v) => {
      if (!v) secondDigit.value = '';
      secondDigit.disabled = !v;
      change({ raceNumber: v + secondDigit.value });
    });
    fields.replaceChildren(
      select('Wrap', choices('factory', 'tactical', 'woodland', 'splinter'), () => draft.wrap, (wrap) => change({ wrap })),
      select('Finish', choices('matte', 'gloss'), () => draft.finish, (finish) => change({ finish })),
      select('Canopy tint', choices('factory', 'smoke', 'amber', 'blue'), () => draft.canopy, (canopy) => change({ canopy })),
      h('fieldset', {}, h('legend', {}, 'Race number'), first, second),
    );
  }
  renderFields();
  const title = h('h3', { class: 'hangar-name', id: 'customize-heading' }, `Customize ${jet.name}`);
  const panel = h('section', { class: 'hangar-info hangar-editor', 'aria-labelledby': title.id }, title, fields);
  const controls = h('footer', { class: 'hangar-controls' }, error, status,
    h('div', { class: 'menu-row' },
      button('Apply', () => {
        if (saveJetAppearance(jet.id, draft)) close(true);
        else error.textContent = 'Could not save this appearance. Your changes are still available to retry.';
      }, 'primary'),
      button('Cancel', () => { preview(original); close(false); }),
      button('Reset to factory', () => {
        change(FACTORY_APPEARANCE);
        renderFields();
        status.textContent = 'Factory appearance previewed. Apply to save it.';
      }),
    ),
    h('p', { class: 'hangar-help' }, 'Preview only · Tab between controls · Controller: ↑ / ↓ move, ← / → change · Esc / B cancel'),
  );
  return { panel, controls };
}
