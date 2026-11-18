# Sky Flight Racing

Low-altitude jet racing in the browser (TypeScript + Three.js + Vite). Thread holographic gates a
few meters above the ground through a meandering canyon, over mountain passes and rolling hills.

## Run
```
npm install
npm run dev      # play: opens the game in the browser
npm run server   # multiplayer server only (npm run dev already starts it)
npm test         # unit tests (flight model, terrain, AI on the real courses, race logic...)
npm run build    # type-check + production build
```

Development is **localhost-only** by default (game: `http://localhost:5173`, multiplayer: `ws://localhost:8787`).
`npm run dev` owns its relay and closes it on shutdown/restart, including connected clients. Relay source changes
restart Vite. Startup fails if either port is occupied; it never silently switches to 5174 or reuses another,
possibly outdated relay. Stop the old process and restart if this happens; do not run `npm run server` alongside dev.

For an explicit LAN session, run `npm run dev -- --host 0.0.0.0`: both listeners then accept network connections.
Friends open `http://<your-ip>:5173` and connect to `ws://<your-ip>:8787`. For the standalone relay, PowerShell
`$env:HOST='0.0.0.0'; npm run server` enables LAN access (`HOST` otherwise defaults to `localhost`; `PORT` defaults to 8787).

Other pilots, including late joiners, see your saved wrap, finish, canopy and race number for the
aircraft you actually fly. If the host forces a plane, each pilot keeps their own look for that plane.
These cosmetics travel in lobby profiles, not movement packets; missing or invalid looks use factory paint.

## Game modes
- **Free flight** – pick a world (a seed or the Classic Canyon), take off from the runway (or start in the air) and explore. No gates, just flying.
- **Race** – on a seeded world: a generated course for that seed (Easy / Medium / Hard, Sprint or Loop). On the Classic Canyon: Canyon Sprint (point to point) or Canyon Loop (laps). Against up to 5 AI pilots and your best-run ghost. Countdown, laps, missed-gate penalty (+3 s), split times vs your best, medals, local leaderboard.
- **Practice** (unranked) – opens a choice between **Flight school** and **Gate sections**. Gate sections: pick a course and a run of consecutive gates (loops may wrap past the start/finish), spawn on the approach to the first gate and fly it as often as you like: R (or pause → Retry section) returns to the section start; a crash puts you back on the approach to the next gate of the section and voids that run's section time. Optional section timer (first to last gate, +3 s per missed gate) with a session best. Real handling, collisions and damage; never writes the leaderboard or ghosts.
  - **Flight school** (Practice > Flight school) – six short lessons (throttle & takeoff, landing gear, bank and pull, gate approach, airbrake, stall recovery) with one objective each and prompts showing your actual key bindings (and controller buttons when one is connected). Calm wind, no turbulence, daylight; R restarts a lesson, the pause menu leaves it. Completed lessons are saved when browser storage works and never count as race records.
- **Multiplayer** – lobbies: browse public lobbies, join private ones with a 5-letter invite code, or create your own (name, public/private, max players 2–8, mode Race, Free flight or Dogfight (2–4 pilots), joining during a game, the world – a seed or the Classic Canyon – and the weather: time of day, clouds, wind, turbulence; all the same for everyone in the lobby). Creating a lobby or saving its settings remembers the server-confirmed choices in this browser for your next lobby, including after a reload; Cancel and joining someone else's lobby do not overwrite them. Solo settings stay separate. In a dogfight lobby every pilot is on one of 4 teams (Alpha, Beta, Gamma, Delta; newcomers join the smallest team); the host clicks a pilot's team to move them to another one. Races on a seeded world use the course generated for that seed and difficulty; Classic Canyon races use the built-in courses and laps. Players mark themselves ready, the host starts, races start together on a grid with everyone in the standings, then everybody returns to the lobby. The server starts with `npm run dev`; friends on the same network open `http://<your-ip>:5173` (start with `npx vite --host`) and the game connects to `ws://<your-ip>:8787` automatically.

## Controls (no yaw – bank and pull to turn)
Default keys (all rebindable in Settings > Controls). Gamepad / HOTAS and mouse flight are supported.

| Key | Action |
| --- | --- |
| W / S | Nose down / up |
| A / D | Roll left / right (steers the nose wheel on the ground) |
| ↑ or Shift / ↓ or Ctrl | Throttle up / down (≥85% = afterburner, 0% on the ground = brakes) |
| B (hold) | Airbrake |
| G | Landing gear |
| L | Jet LEDs on / off (wingtip, tail, strobe and beacon lights) |
| C | Chase / cockpit camera |
| R | Respawn / restart race |
| P or Esc | Pause menu |
| H | Help |
| F | Fullscreen (also stops Ctrl+W from closing the tab) |
| Z | Radar range (2 / 5 / 10 / 20 km) |
| Space | Machine gun (dogfight only) |
| Q | Missile: tap to fire, hold to wait for the lock (dogfight only) |
| E | Flares (dogfight only) |

Gamepad: left stick = pitch/roll, RT/LT = throttle, A = airbrake, B = gear, Y = camera, Start = pause, Back = respawn,
RB = gun, LB = missile, X = flares, d-pad ↑ = lights, d-pad ↓ = radar range, d-pad ← = help (lists controller buttons).
Menus: d-pad / left stick = move, A = confirm, B = back.
Controller buttons can be remapped in Settings > Controls > Controller (the left stick and menu buttons are fixed).

## Worlds, generated races, Dogfight and radar
- **Seeded worlds** (Minecraft style): any text or number is a seed, and the same seed always builds the same endless
  world of valleys, mountains, rivers, lakes and ocean, with roads and towns/cities. Choose "Seeded world" (type a seed
  or press Random) or "Classic Canyon" in Free flight, Race and multiplayer lobbies. The last seed is remembered.
- **Generated races**: on a seeded world, each seed + difficulty (Easy / Medium / Hard) + layout (Sprint / Loop)
  produces its own challenging course through that terrain, the same for every player.
- **Dogfight** (multiplayer game mode, 2–4 pilots): Multiplayer > create a lobby and pick the Dogfight mode (max pilots
  2–4). Two pilots fight a duel, three or four a free-for-all. Pilots spawn evenly spaced around a bounded combat zone
  (wall + ceiling) on the lobby's world: 6 km across for a duel, +2 km per extra pilot (8 km for 3, 10 km for 4).
  Machine gun, heat-seeking missiles (lock on, then fire) and flares to decoy them; stay outside the zone too long and
  you are destroyed. A crash or zone death within 10 s of being hit counts for the last pilot who hit you (in a duel it
  always counts for the opponent). After a kill or crash you respawn after a short delay; first to 3 kills wins, then
  everybody returns to the lobby. If pilots leave, the match goes on while at least two remain.
- **Radar** (bottom right in chase, dashboard-mounted in cockpit, every flying mode): heading-up, shows the next gates, AI racers, the ghost, other players,
  the opponent, missiles, flares, the airfield and the dogfight zone. Z cycles the range; Settings > Graphics turns it
  off or sets the default range.

## Jets
Five unique procedural aircraft models with sealed bodies and solid wings, tails and engine joins:
- **F-90 Falcon**: balanced swept-wing fighter with twin fins and twin engines.
- **V-7 Viper**: agile, lightweight clipped-wing fighter with one fin and one engine.
- **R-22 Raptor**: fast, heavy diamond-wing interceptor with canted twin fins and twin engines.
- **K-31 Kestrel**: single-engine canard-delta technical racer with strong low-speed lift and responsive controls, sacrificing top speed and acceleration.
- **S-12 Specter**: forward-swept, twin-engine pursuit fighter, faster and quicker to accelerate than Falcon with moderate agility; Raptor still leads in outright pace.

All five have distinct silhouettes and handling profiles; the original Falcon, Viper and Raptor tuning is unchanged.
To use your own 3D model, drop `public/assets/models/<jetId>.glb` (or `jet.glb`) – it replaces the procedural jet
(nose along +Z, it is scaled to ~20 m).
Pick your jet with **Choose jet**: a full-screen 3D tour of three connected hangars, with two parking
bays per building (the last bay is empty). The camera enters the hangar, then glides between parked
aircraft. The highlighted bay's aircraft name, description and relative handling remain visible.
Use **Left / Right** or the on-screen Previous / Next buttons to browse; **Enter / Space** on the
aircraft view or **Confirm aircraft** saves the choice and returns. **Escape / Back** cancels without
changing your aircraft. Tab reaches each control; Enter / Space activates the focused control.
Controller: d-pad / left stick to browse, **A** to confirm the focused control, **B** to cancel.
Navigation stops at the end bays. Reduced-motion preferences skip camera animation.

In a personal hangar, **Customize** previews a wrap, finish, canopy tint and optional one- or
two-digit race number on the current jet. **Apply** saves that jet’s appearance without selecting it
for flight. **Cancel** discards the draft; **Reset to factory** previews the default until you apply.
Parked jets display their saved looks. Optional GLB replacements appear only with factory appearance.
The host’s aircraft-rule picker does not edit personal appearances.

The same hangar opens from personal jet selection in the multiplayer browser/room and from the host's
**Plane** rule in lobby creation/settings. Personal confirmation updates your profile; host confirmation
only edits the form draft until **Create / Save** is pressed. **Pilot's choice** keeps individual aircraft
selection enabled. Host-enforced aircraft cannot be overridden by individual pilots. Player/chat updates
do not close a tour; changed host rules or lobby ownership invalidate it with an explanation.
If 3D rendering is unavailable, the aircraft information and selection controls still work.

## Settings highlights
- **HOTAS throttle lever** (Settings > Controls): choose the lever axis, invert it and calibrate min/max with a live readout.
- **HUD**: compact or detailed instruments, HUD scale 75–150%, and an arrow that points to the next gate even when it's off screen.
- **Cockpit view** (C): a separate pilot-seat view inside the selected jet's canopy, with windscreen framing and a fixed dashboard. The central artificial horizon shows live pitch and bank, airspeed sits left, altitude and vertical speed right, and heading below. Engine/throttle, G, angle of attack, airframe health, gear, airbrake and radar stay on the dashboard rather than floating at the sides. Cockpit always shows the full instrument set; compact HUD applies to chase only. Units remain km/h, meters and m/s.
- **Audio**: master, engine, effects and warnings volumes (engine and effects dip while a warning sounds).
- **Race conditions**: *Standard time trial* (same wind for everyone) or *My world settings*. Records and ghosts are kept per course, laps, jet and conditions; older times appear as "Legacy".
- The game pauses when the window loses focus. Menus work with keyboard (Tab/arrows/Enter/Esc) and controller (d-pad/A/B).
- Menus use a midnight-navy palette with cyan actions, amber aircraft/course selections, and a separate bright focus ring. Responsive launch tiles, dark dropdowns, slim scrollbars, and sticky Back actions keep setup screens usable in smaller windows.

## Folder structure
```
src/
  main.ts              entry point
  game/                Game (wiring + modes), RaceSession, AIRacer, PuppetJet (ghost/remote), RemotePlayers
  core/                GameLoop (fixed timestep), Renderer
  config/              flight, controls (key bindings), camera, world (terrain, runway, gates, landmarks)
  settings/            persisted player settings + graphics presets
  input/               InputManager, KeyBindings (rebinding), GamepadInput, MouseFlight, input curves
  physics/             FlightModel + aerodynamics (wind, turbulence, damage modifiers; unit tested)
  ai/                  AIPilot (bank-to-turn autopilot with terrain avoidance)
  race/                Course (built-ins, gate placement), RaceProgress, Ghost, Leaderboard, CourseLibrary
  modes/               flight school (lessons, objective checks, FlightSchool), unranked PracticeSession, DogfightSession
  combat/              WeaponSystem (gun, missiles, flares), combat effects
  world/gen/           seeded world generation (biomes, rivers, roads, settlements)
  ui/radar/            Radar + contact helpers; ui/dogfight/ dogfight HUD
  net/                 NetClient + SnapshotBuffer (multiplayer)
  audio/               AudioEngine (synthesized engine, wind, warnings, effects)
  effects/             VaporTrails, DustKicker, HeatHaze, GTolerance, CameraShake
  entities/jet/        Jet, JetModel (+ control surfaces, gear), jetCatalog, DamageModel, glTF loader, Afterburner
  entities/effects/    Explosion
  world/terrain/       HeightField (infinite procedural terrain, valley, river, passes, runway), streamed LOD chunks, splat material
  world/environment/   Sky, Lights, TimeOfDay, Clouds, Weather, River, Runway
  world/props/         Trees, rocks, buildings, power lines, stone bridges (+ collision)
  world/rings/         holographic gates
  camera/              CameraManager, ChaseCamera, CockpitCamera
  systems/             CollisionSystem (ground/water/obstacles/scrapes), GroundHandling (runway)
  ui/                  Hud, RaceHud, MainMenu, SettingsPanel, GForceOverlay
server/relay.mjs       multiplayer WebSocket relay
tests/                 Vitest unit tests
docs/FUTURE_IDEAS.md   idea list and what was built
```

## Improvement backlog

See [the selected feature backlog](docs/GAME_BACKLOG.md) for daily challenges, exploration missions,
weather trials, new landmarks, dynamic weather, and selectable units.

## Contributing
`main` is protected: every change goes through a pull request.
```
git checkout main && git pull           # start from the latest main
git checkout -b my-feature              # one branch per change
# ...make changes, then check them:
npm test && npm run typecheck
git add -A && git commit -m "Describe the change"
git push -u origin my-feature           # then open a PR on GitHub
```
The other person reviews and merges the PR; delete the branch after merging.
