# Sky Flight Racing - Selected Feature Backlog

Only the six features selected by the user are included below. Numbers match the feature list in chat.
All are planned, not marked as implemented. Team dogfight (#8) is already implemented according to the user and is not pending work.

## #2 - Daily challenge

- [ ] Add a daily seeded time trial.
  - Use one fixed seed, course, jet, and set of conditions per UTC day.
  - Allow unlimited retries and save the best time locally for that day's challenge.
  - Show the challenge date, rules, best time, and time until the next challenge.
  - Keep the course/rules version with the result so incompatible times are not mixed.
  - Do not require a global leaderboard or online backend.
  - **Done when:** the same game version produces the same challenge for the same UTC date; retries preserve its rules, results survive reload, and the next day selects the next challenge.

## #13 - Exploration missions

- [ ] Add missions to discover landmarks and return to an airfield.
  - Show a small list of destinations with navigation cues and completion status.
  - Define how close a pilot must get to discover each destination.
  - Complete the mission after visiting all required destinations and landing at the designated airfield.
  - Save mission progress against the world seed and generator version.
  - Provide clear restart and abandon actions without affecting race records.
  - **Done when:** destinations are reachable, discoveries count once, progress survives reload, and landing at the destination airfield completes the mission only after all objectives are met.

## #17 - Weather trials

- [ ] Add curated races with challenging weather or lighting.
  - Include crosswind, turbulence, and night presets on validated routes.
  - Explain the selected conditions before launch.
  - Keep each trial's conditions fixed across retries and use separate compatible record categories.
  - Ensure gates and critical flight warnings remain readable.
  - **Done when:** each trial is finishable, its advertised conditions match gameplay, and records are not mixed with normal races or other weather presets.

## #34 - New landmarks

- [ ] Add distinctive landmarks to explore and fly around.
  - Candidate landmarks: dams, harbors, tunnels, observatories, and racing obstacles.
  - Integrate placement with the terrain and preserve deterministic generation for seeded worlds.
  - Give solid structures appropriate collision geometry; leave intended fly-through openings clear.
  - Make landmarks usable as destinations for exploration missions.
  - Set rendering and streaming budgets before increasing landmark density.
  - **Done when:** the same seed/version reproduces the same placements, structures fit the terrain, intended routes are passable, and collision matches visible geometry.

## #36 - Dynamic weather

- [ ] Add changing weather during free flight.
  - Transition wind, turbulence, and cloud coverage smoothly rather than switching abruptly.
  - Provide an explicit enable/disable setting and show the current conditions.
  - Preserve the existing fixed-weather option.
  - Do not alter ranked race conditions, curated weather trials, or calm flight-school conditions.
  - **Done when:** enabled free flight visibly and physically transitions between conditions without abrupt control changes, while disabled and fixed-condition modes remain stable.

## #59 - Selectable units

- [ ] Add selectable speed and altitude units.
  - Offer km/h or knots for speed, and meters or feet for altitude.
  - Apply the choices consistently to HUD, cockpit, lessons, setup information, and tooltips wherever those quantities appear.
  - Convert related vertical-speed displays consistently and label their units explicitly.
  - Save preferences and restore them after reload.
  - Change display formatting only; keep physics, objective thresholds, scoring, and stored race results unchanged.
  - **Done when:** switching units converts every affected display correctly, labels remain explicit, preferences survive reload, and gameplay behavior is identical.
