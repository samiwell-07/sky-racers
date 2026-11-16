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

## Game modes
- **Free flight** – take off from the runway (or start in the air, see Settings) and practice on the Canyon Loop gates.
- **Race** – Canyon Sprint (point to point) or Canyon Loop (laps), against up to 5 AI pilots and your best-run ghost. Countdown, laps, missed-gate penalty (+3 s), split times vs your best, medals, local leaderboard.
- **Practice** (unranked) – pick a course and a run of consecutive gates (loops may wrap past the start/finish), spawn on the approach to the first gate and fly it as often as you like: R (or pause → Retry section) returns to the section start; a crash puts you back on the approach to the next gate of the section and voids that run's section time. Optional section timer (first to last gate, +3 s per missed gate) with a session best. Real handling, collisions and damage; never writes the leaderboard or ghosts.
- **Flight school** – six short lessons (throttle & takeoff, landing gear, bank and pull, gate approach, airbrake, stall recovery) with one objective each and prompts showing your actual key bindings (and controller buttons when one is connected). Calm wind, no turbulence, daylight; R restarts a lesson, the pause menu leaves it. Completed lessons are saved when browser storage works and never count as race records.
- **Multiplayer** – lobbies: browse public lobbies, join private ones with a 5-letter invite code, or create your own (name, public/private, max players 2–8, mode Race or Free flight, course and laps, joining during a game, and the world: time of day, clouds, wind, turbulence – the base world by default and the same for everyone in the lobby). Players mark themselves ready, the host starts, races start together on a grid with everyone in the standings, then everybody returns to the lobby. The server starts with `npm run dev`; friends on the same network open `http://<your-ip>:5173` (start with `npx vite --host`) and the game connects to `ws://<your-ip>:8787` automatically.

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

Gamepad: left stick = pitch/roll, RT/LT = throttle, A = airbrake, B = gear, Y = camera, Start = pause, Back = respawn.

## Jets
Three jets with different handling: **F-90 Falcon** (balanced), **V-7 Viper** (agile), **R-22 Raptor** (fast).
To use your own 3D model, drop `public/assets/models/<jetId>.glb` (or `jet.glb`) – it replaces the procedural jet
(nose along +Z, it is scaled to ~20 m).
Pick your jet in the **Hangar** (main menu): rotating 3D preview, role and relative handling.

## Settings highlights
- **HOTAS throttle lever** (Settings > Controls): choose the lever axis, invert it and calibrate min/max with a live readout.
- **HUD**: compact or detailed instruments, HUD scale 75–150%, and an arrow that points to the next gate even when it's off screen.
- **Audio**: master, engine, effects and warnings volumes (engine and effects dip while a warning sounds).
- **Race conditions**: *Standard time trial* (same wind for everyone) or *My world settings*. Records and ghosts are kept per course, laps, jet and conditions; older times appear as "Legacy".
- The game pauses when the window loses focus. Menus work with keyboard (Tab/arrows/Enter/Esc) and controller (d-pad/A/B).

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
  modes/               flight school (lessons, objective checks, FlightSchool) and unranked PracticeSession
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
