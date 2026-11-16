import { Group, Mesh, Points, Quaternion, Scene, Vector3, type Material, type Object3D, type WebGLRenderer } from 'three';
import { AudioEngine, type FlybyListener, type FlybySource } from '../audio/AudioEngine';
import { CameraManager } from '../camera/CameraManager';
import type { CameraTarget } from '../camera/CameraController';
import { createCameraConfig } from '../config/cameraConfig';
import { DEFAULT_FLIGHT_CONFIG, createFlightConfig } from '../config/flightConfig';
import { LANDMARKS, SPAWN_CONFIG, TERRAIN_CONFIG } from '../config/worldConfig';
import { GameLoop } from '../core/GameLoop';
import { createRenderer, handleResize } from '../core/Renderer';
import { shakeOffset } from '../effects/CameraShake';
import { DustKicker } from '../effects/DustKicker';
import { VaporTrails } from '../effects/VaporTrails';
import { Explosion } from '../entities/effects/Explosion';
import { Jet } from '../entities/jet/Jet';
import { GEAR_HEIGHT } from '../entities/jet/JetModel';
import { getJetDefinition } from '../entities/jet/jetCatalog';
import { InputManager } from '../input/InputManager';
import { KeyBindings, keyLabel } from '../input/KeyBindings';
import { NetClient } from '../net/NetClient';
import { BUILTIN_COURSES, resolveCourse, type CourseDef } from '../race/Course';
import type { Lobby } from '../net/lobbyTypes';
import { LobbyMenu } from '../ui/LobbyMenu';
import { CourseLibrary } from '../race/CourseLibrary';
import { Leaderboard } from '../race/Leaderboard';
import { RaceProgress } from '../race/RaceProgress';
import { DEFAULT_SETTINGS, GRAPHICS_PRESETS, SettingsStore } from '../settings/Settings';
import { CollisionSystem, IMPACT_RULES, ImpactTracker, type CrashReason } from '../systems/CollisionSystem';
import { GroundHandling } from '../systems/GroundHandling';
import { GForceOverlay } from '../ui/GForceOverlay';
import { Hud, formatTime, type GamePhase } from '../ui/Hud';
import { MainMenu } from '../ui/MainMenu';
import { attachMenuNavigation } from '../ui/menuFocus';
import { RaceHud } from '../ui/RaceHud';
import { SettingsPanel } from '../ui/SettingsPanel';
import { RAD2DEG, smoothstep } from '../utils/math';
import { Clouds } from '../world/environment/Clouds';
import { Lights } from '../world/environment/Lights';
import { River } from '../world/environment/River';
import { createRunwayMesh } from '../world/environment/Runway';
import { Sky } from '../world/environment/Sky';
import { applyTimeOfDay } from '../world/environment/TimeOfDay';
import { Weather } from '../world/environment/Weather';
import { PropsManager } from '../world/props/PropsManager';
import { RingManager } from '../world/rings/RingManager';
import { HeightField, valleyCenterX } from '../world/terrain/HeightField';
import { createTerrainMaterial } from '../world/terrain/TerrainMaterial';
import { TerrainStreamer } from '../world/terrain/TerrainStreamer';
import { RaceSession, type Standing } from './RaceSession';
import type { InputAction } from '../config/controlsConfig';
import { FlightSchool, padHint, snapshotOf } from '../modes/FlightSchool';
import { escapeHtml, LESSON_WORLD, LESSONS, LessonProgressStore, nextLesson, type LessonDef, type PromptKeys } from '../modes/lessons';
import { describeSection, PracticeSession, selectSection, type PracticeChoice } from '../modes/PracticeSession';
import { formatRaceClock } from '../race/Splits';
import { ModeHud } from '../ui/ModeHud';
import type { SaveResult } from '../settings/safeStorage';
import { lessonCompletePanel, lessonListPanel, modePausePanel, practiceSetupPanel } from '../ui/ModeMenus';
import { RemotePlayers } from './RemotePlayers';

/** 'lesson' = flight school, 'practice' = unranked gate-section practice. Every mode but 'menu' is flying. */
type Mode = 'menu' | 'free' | 'race' | 'lesson' | 'practice';

const CRASH_TEXT: Record<CrashReason, string> = {
  ground: 'You hit the ground',
  water: 'You hit the water',
  damage: 'Too much damage',
  hardLanding: 'Hard landing',
  rock: 'You hit a rock',
  building: 'You hit a building',
  powerline: 'You hit a power line',
  arch: 'You hit the bridge',
};

const RESPAWN_DELAY = IMPACT_RULES.respawnDelay;
const UP = new Vector3(0, 1, 0);
/** Practice session-best key: course + section. */
const practiceKey = (c: PracticeChoice): string => `${c.courseId}:${c.start}:${c.count}`;

/** Wires together world, jets, race, multiplayer, UI and the game loop. */
export class Game {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly loop: GameLoop;

  // Settings & input
  private readonly settings = new SettingsStore();
  private readonly bindings = new KeyBindings();
  private readonly input: InputManager;
  private readonly flightConfig = createFlightConfig();
  private readonly cameraConfig = createCameraConfig();

  // World
  private readonly heightField = new HeightField(TERRAIN_CONFIG);
  private readonly terrain: TerrainStreamer;
  private readonly river = new River(TERRAIN_CONFIG);
  private readonly sky: Sky;
  private readonly lights: Lights;
  private readonly clouds = new Clouds();
  private readonly weather: Weather;
  private readonly props: PropsManager;

  // Player
  private jet: Jet;
  private readonly ground: GroundHandling;
  private readonly collision: CollisionSystem;
  private readonly explosion = new Explosion();
  private readonly vapor = new VaporTrails();
  private readonly dust = new DustKicker();
  private readonly cameras: CameraManager;
  private readonly cameraTarget: CameraTarget;
  private readonly before: Vector3[] = [];
  private readonly after: Vector3[] = [];

  // Game state
  private mode: Mode = 'menu';
  private phase: GamePhase = 'flying';
  private paused = false;
  private respawnTimer = 0;
  private readonly impacts = new ImpactTracker();
  private shakeImpulse = 0;
  private flightTime = 0;
  private time = 0;
  private readonly rings = new RingManager();
  private freeProgress: RaceProgress | null = null;
  private freeGates = resolveCourse(BUILTIN_COURSES[1]!, this.heightField).gates;
  private race: RaceSession | null = null;
  /** Flight school lesson / practice section in progress (never ranked, never write records). */
  private school: FlightSchool | null = null;
  private practice: PracticeSession | null = null;
  private practiceChoice: PracticeChoice = { courseId: BUILTIN_COURSES[1]!.id, start: 0, count: 5, timed: true };
  /** Best clean section time per section this session (memory only). */
  private readonly practiceBest = new Map<string, number>();
  private readonly lessonProgress = new LessonProgressStore();
  private lessonSave: SaveResult = { ok: true };
  private readonly modeHud: ModeHud;
  private readonly settingsPanel: SettingsPanel;
  private lastCourse: CourseDef | null = null;

  // Services & UI
  private readonly audio = new AudioEngine();
  private readonly courses = new CourseLibrary();
  private readonly leaderboard = new Leaderboard();
  private readonly net = new NetClient();
  private readonly remotes: RemotePlayers;
  private readonly lobbyMenu: LobbyMenu;
  /** The current game was started from a multiplayer lobby. */
  private mpGame = false;
  /** Multiplayer menu overlay open (the game keeps running). */
  private mpMenuOpen = false;
  /** Grid / runway slot in multiplayer so players don't spawn inside each other. */
  private spawnSlot = 0;
  private readonly remoteSnap = { position: new Vector3(), quaternion: new Quaternion(), throttle: 0, afterburner: false };
  private readonly flybySources: FlybySource[] = [];
  private readonly flybyListener = { position: new Vector3(), right: new Vector3(), velocity: new Vector3() };
  private netEventTimer = 0;
  private readonly hud: Hud;
  private readonly raceHud: RaceHud;
  private readonly menu: MainMenu;
  private readonly gforce: GForceOverlay;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly shake = new Vector3();
  private readonly anisotropy: number;
  private readonly terrainMaterials = new Map<boolean, Material>();
  // Dynamic resolution + UI throttling.
  private pixelRatio = 1;
  private frameTimeAvg = 16;
  private resolutionTimer = 0;
  private hudTimer = 0;

  constructor(private readonly container: HTMLElement) {
    const preset = GRAPHICS_PRESETS[this.settings.values.graphics];
    // Anti-aliasing can only be chosen when the WebGL context is created (applies after a reload).
    this.renderer = createRenderer(container, preset.antialias);
    this.input = new InputManager(this.bindings, this.settings.values, this.renderer.domElement);
    this.input.onFocusChange((focused) => this.onFocusChange(focused));
    this.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.terrain = new TerrainStreamer(this.heightField, this.terrainMaterial(preset.simpleTerrain));
    this.sky = new Sky(this.scene);
    this.lights = new Lights(this.scene);
    this.weather = new Weather({ windSpeed: 0, windDirection: 0, turbulence: 0 });
    this.props = new PropsManager({
      seed: TERRAIN_CONFIG.seed,
      heightAt: (x, z) => this.heightField.getHeightAt(x, z),
      valleyCenterX,
      powerLineZ: [...LANDMARKS.powerLineZ],
      archZ: [...LANDMARKS.archZ],
      clearZones: [{ x: this.heightField.runway.x, z: this.heightField.runway.z, halfWidth: 140, halfLength: this.heightField.runway.halfLength + 300, heading: 0 }],
    });
    this.ground = new GroundHandling(this.heightField);
    this.collision = new CollisionSystem(this.heightField, this.props);
    this.jet = this.createPlayerJet();
    this.scene.add(this.terrain.group, this.river.mesh, this.clouds.mesh, this.props.group, this.rings.group, this.explosion.group, this.vapor.object, this.dust.object, createRunwayMesh(this.heightField.runway));

    const groundHeight = (x: number, z: number): number => this.heightField.getSurfaceHeight(x, z);
    this.cameras = new CameraManager(this.cameraConfig, groundHeight);
    this.cameraTarget = { position: this.jet.object.position, quaternion: this.jet.object.quaternion, speed: 0 };

    this.gforce = new GForceOverlay(container);
    this.hud = new Hud(container, this.bindings);
    this.raceHud = new RaceHud(container);
    this.modeHud = new ModeHud(container);
    const settingsPanel = (this.settingsPanel = new SettingsPanel(this.settings, this.bindings, this.input));
    this.menu = new MainMenu(container, this.settings, this.courses, this.leaderboard, settingsPanel, {
      startFreeFlight: () => this.startFreeFlight(),
      startRace: (id) => {
        const c = this.courses.get(id);
        if (c) this.startRace(c);
      },
      openFlightSchool: () => this.showLessonList(),
      openPractice: (courseId) => this.showPracticeSetup(courseId),
      openMultiplayer: () => void this.lobbyMenu.open(),
      resume: () => this.setPaused(false),
      restart: () => this.restart(),
      quitToMenu: () => this.showMenu(),
      backToLobby: () => this.backToLobby(),
    });
    this.lobbyMenu = new LobbyMenu(this.menu, this.net, this.settings, {
      connect: () => this.connect(),
      backToMain: () => this.showMenu(),
    });
    // Controller d-pad/A/B and keyboard arrows/Escape move through the menus (not during key capture).
    attachMenuNavigation(
      (cb) => this.input.onMenuNavigate(cb),
      () => this.input.captureNextKey !== null,
      () => this.input.cancelKeyCapture(),
    );
    // Leaving or redrawing a menu screen abandons a pending key capture.
    this.menu.onScreenChange = () => this.input.cancelKeyCapture();
    this.remotes = new RemotePlayers(this.net, this.scene, (t) => {
      if (this.mpGame) this.hud.showMessage(t, 3);
    });
    this.net.started.on((lobby, late) => this.startMultiplayerGame(lobby, late));
    // The lobby's world settings apply to everyone in it.
    this.net.lobbyChanged.on(() => this.applySettings());
    this.net.disconnected.on(() => {
      if (this.mpGame) this.showMenu();
      this.hud.showMessage('Disconnected from the multiplayer server', 4);
      if (this.lobbyMenu.active) void this.lobbyMenu.open();
    });

    handleResize(this.renderer, container, (aspect) => this.cameras.setAspect(aspect));
    this.settings.onChange(() => this.applySettings());
    this.applySettings();
    // Any key/click unlocks audio (browser autoplay policy).
    const unlock = (): void => this.audio.resume();
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);

    this.loop = new GameLoop(
      (dt) => this.fixedUpdate(dt),
      (alpha, frameDt) => this.render(alpha, frameDt),
    );
    this.showMenu();
  }

  start(): void {
    this.terrain.update(this.cameras.camera.position, true);
    this.loop.start();
    void this.warmUpShaders();
  }

  /**
   * Compiles every shader in the background (including normally hidden effects such as the
   * explosion and vapor trails) so nothing stalls the first time it appears on screen.
   */
  private async warmUpShaders(): Promise<void> {
    // Hidden objects (explosion, vapor trails, menu-hidden jet...) are compiled through visible
    // stand-ins that share their geometry and material, so the real objects are never touched.
    const proxies = new Group();
    this.scene.traverse((o) => {
      const r = o as Mesh;
      if (!r.isMesh && !(o as Points).isPoints) return;
      let hidden = false;
      for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) hidden = true;
      if (!hidden) return;
      const proxy = (o as Points).isPoints ? new Points(r.geometry, r.material) : new Mesh(r.geometry, r.material);
      proxy.frustumCulled = false;
      proxies.add(proxy);
    });
    this.scene.add(proxies);
    // compile() collects the materials synchronously; detach the proxies right away so they are never
    // drawn while waiting (they would re-upload resources of objects disposed in the meantime).
    const compiled = (async () => this.renderer.compileAsync(this.scene, this.cameras.camera))();
    this.scene.remove(proxies);
    try {
      await compiled;
    } catch {
      // compileAsync is an optimisation only.
    }
  }

  // ---------------------------------------------------------------- setup

  private createPlayerJet(): Jet {
    const def = getJetDefinition(this.settings.values.jetId);
    Object.assign(this.flightConfig, DEFAULT_FLIGHT_CONFIG, def.flight);
    const jet = new Jet(def, this.flightConfig);
    this.scene.add(jet.object);
    return jet;
  }

  /** Rebuild the player jet if the selected type changed. */
  private ensurePlayerJet(): void {
    if (this.jet.definition.id === this.settings.values.jetId) {
      Object.assign(this.flightConfig, DEFAULT_FLIGHT_CONFIG, this.jet.definition.flight);
      return;
    }
    this.jet.dispose();
    this.jet = this.createPlayerJet();
    this.cameraTarget.position = this.jet.object.position;
    this.cameraTarget.quaternion = this.jet.object.quaternion;
  }

  private terrainMaterial(simple: boolean): Material {
    let m = this.terrainMaterials.get(simple);
    if (!m) {
      m = createTerrainMaterial(TERRAIN_CONFIG, this.anisotropy, simple);
      this.terrainMaterials.set(simple, m);
    }
    return m;
  }

  /** World settings: the lobby's when in a multiplayer lobby, flight school's calm daylight in a lesson, otherwise the player's own. */
  private worldSettings(): { timeOfDay: number; cloudCoverage: number; windSpeed: number; windDirection: number; turbulence: number } {
    if (this.mode === 'lesson') return LESSON_WORLD;
    return this.net.lobby?.settings.world ?? this.settings.values;
  }

  private applySettings(): void {
    const s = this.settings.values;
    const w = this.worldSettings();
    const g = GRAPHICS_PRESETS[s.graphics];
    this.pixelRatio = Math.min(window.devicePixelRatio, g.pixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = g.shadows;
    this.lights.sun.castShadow = g.shadows;
    this.lights.setShadowMapSize(g.shadowMap);
    this.terrain.setMaterial(this.terrainMaterial(g.simpleTerrain));
    this.terrain.setDetail(g.viewScale);
    this.props.setQuality(g.props);
    this.clouds.maxVisible = g.clouds;
    this.sky.setFogRange(this.terrain.viewDistance * 0.12, this.terrain.viewDistance * 0.9);
    this.audio.setMixer({ master: s.masterVolume, engine: s.engineVolume, effects: s.effectsVolume, warnings: s.warningsVolume });
    applyTimeOfDay(w.timeOfDay, this.sky, this.lights);
    this.clouds.setCoverage(w.cloudCoverage);
    this.clouds.setColor(this.sky.colors.horizon.clone().lerp(this.lights.sun.color, 0.5).multiplyScalar(1.1));
    // Ranked races keep their frozen race weather (record category) until the race ends.
    Object.assign(this.weather.settings, this.race?.weather ?? { windSpeed: w.windSpeed, windDirection: w.windDirection, turbulence: w.turbulence });
    this.input.applySettings();
    this.hud.setLayout(s.hudLayout, s.hudScale);
    if (this.loop) void this.warmUpShaders();
  }

  // ---------------------------------------------------------------- modes

  private showMenu(): void {
    this.endRace();
    this.mpGame = false;
    this.setMpMenu(false);
    this.lobbyMenu.deactivate();
    if (this.net.connected) this.net.disconnect();
    this.mode = 'menu';
    this.paused = false;
    this.jet.object.visible = false;
    this.rings.clear();
    this.hud.setVisible(false);
    this.raceHud.setVisible(false);
    this.gforce.reset();
    this.applySettings(); // back to the player's own world settings
    this.menu.showMain();
  }

  /** Multiplayer: leave the current game and go back to the lobby room. */
  private backToLobby(): void {
    this.endRace();
    this.mpGame = false;
    this.setMpMenu(false);
    this.mode = 'menu';
    this.jet.object.visible = false;
    this.rings.clear();
    this.hud.setVisible(false);
    this.raceHud.setVisible(false);
    this.gforce.reset();
    this.net.leftGame();
    void this.lobbyMenu.open();
  }

  private startMultiplayerGame(lobby: Lobby, late: boolean): void {
    this.lobbyMenu.deactivate();
    this.spawnSlot = Math.max(0, lobby.players.findIndex((p) => p.id === this.net.id));
    if (lobby.settings.mode === 'race') {
      const course = BUILTIN_COURSES.find((c) => c.id === lobby.settings.courseId) ?? BUILTIN_COURSES[0]!;
      this.startRace(course, lobby);
    } else {
      this.startFreeFlight(lobby);
      if (late) this.hud.showMessage(`Joined ${lobby.settings.name}`, 3);
    }
  }

  private startFreeFlight(lobby: Lobby | null = null): void {
    this.endRace();
    this.ensurePlayerJet();
    this.mpGame = lobby !== null;
    if (!lobby) this.spawnSlot = 0;
    this.mode = 'free';
    this.menu.hide();
    this.hud.setVisible(true);
    this.raceHud.setVisible(false);
    this.rings.setGates(this.freeGates);
    this.freeProgress = new RaceProgress(this.freeGates.length, 99);
    this.spawnFree();
    this.hud.showMessage(this.settings.values.startOnRunway ? 'Full throttle, pull up at 280 km/h · G = gear' : 'Free flight', 4);
  }

  private startRace(course: CourseDef, lobby: Lobby | null = null): void {
    this.endRace();
    this.ensurePlayerJet();
    this.mpGame = lobby !== null;
    if (!lobby) this.spawnSlot = 0;
    this.mode = 'race';
    this.lastCourse = course;
    this.menu.hide();
    this.hud.setVisible(true);
    this.raceHud.setVisible(true);
    // Multiplayer races: the lobby decides the laps; no AI or ghost so everyone races the same field.
    const raceSettings = lobby ? { ...this.settings.values, laps: lobby.settings.laps, aiOpponents: 0, showGhost: false } : this.settings.values;
    // Multiplayer races are unranked: they never write local records or ghosts.
    this.race = new RaceSession(course, raceSettings, this.heightField, this.scene, this.leaderboard, { ranked: !lobby });
    if (this.race.weather) Object.assign(this.weather.settings, this.race.weather);
    this.rings.setGates(this.race.course.gates);
    const st = this.race.course.start;
    this.spawnAt(this.gridPosition(), st.heading, st.speed, false);
    this.hud.showMessage(`${course.name}: get ready`, 2.5);
    void this.warmUpShaders(); // AI and ghost jets bring new materials; compile them during the countdown
  }

  private endRace(): void {
    const raceWeather = this.race?.weather;
    this.race?.dispose();
    this.race = null;
    if (raceWeather) {
      const w = this.worldSettings();
      Object.assign(this.weather.settings, { windSpeed: w.windSpeed, windDirection: w.windDirection, turbulence: w.turbulence });
    }
    this.freeProgress = null;
    this.school = null;
    this.practice = null;
    this.modeHud.setVisible(false);
    this.raceHud.hideResults();
  }

  // ---------------------------------------------------------------- flight school & practice

  /** Leaves any game in progress for a menu screen (keeps the menu background running). */
  private toMenuScreen(panel: HTMLElement): void {
    if (this.mode !== 'menu') this.showMenu();
    this.menu.show(panel);
  }

  private showLessonList(): void {
    this.toMenuScreen(lessonListPanel(this.lessonProgress, (l) => this.startLesson(l), () => this.showMenu()));
  }

  private startLesson(lesson: LessonDef): void {
    this.endRace();
    this.ensurePlayerJet();
    this.spawnSlot = 0;
    this.mode = 'lesson';
    this.paused = false;
    this.school = new FlightSchool(lesson, this.heightField);
    this.applySettings(); // calm wind, no turbulence, daylight for the lesson
    this.menu.hide();
    this.hud.setVisible(true);
    this.raceHud.setVisible(false);
    this.modeHud.setVisible(true);
    this.spawnLesson();
  }

  private spawnLesson(): void {
    const school = this.school!;
    school.restart();
    if (school.gates.length) {
      this.rings.setGates(school.gates);
      this.rings.showProgress(0);
    } else this.rings.clear();
    const p = school.spawnPose();
    this.spawnAt(p.position, p.heading, p.speed, p.onGround, { orientation: p.orientation, throttle: p.throttle, gearDown: p.gearDown });
    this.flightTime = 0;
    this.hud.showMessage(school.def.title, 2.5);
  }

  private onLessonComplete(): void {
    const school = this.school!;
    this.lessonSave = this.lessonProgress.markComplete(school.def.id);
    if (!this.lessonSave.ok) console.warn(`Flight school progress not saved: ${this.lessonSave.error}`);
    this.audio.playLapComplete();
    this.paused = true;
    this.showLessonComplete();
  }

  private showLessonComplete(): void {
    const lesson = this.school!.def;
    const next = nextLesson(lesson.id);
    this.menu.show(
      lessonCompletePanel(lesson, next, this.lessonSave, {
        onNext: () => next && this.startLesson(next),
        onRetry: () => this.startLesson(lesson),
        onList: () => this.showLessonList(),
        onMenu: () => this.showMenu(),
      }),
      true,
    );
  }

  /** The player's real controls for the lesson prompts. */
  private promptKeys(): PromptKeys {
    const pad = this.input.gamepadConnected;
    const invert = this.settings.values.invertPitch;
    return {
      key: (a: InputAction) => {
        // Inverted pitch swaps what the nose-up / nose-down keys do.
        const action: InputAction = invert && a === 'pitchUp' ? 'pitchDown' : invert && a === 'pitchDown' ? 'pitchUp' : a;
        const codes = this.bindings.get(action);
        return codes.length ? codes.slice(0, 2).map(keyLabel).join(' / ') : 'unbound';
      },
      pad: (a: InputAction) => (pad ? padHint(a) : null),
    };
  }

  private updateLessonHud(agl: number): void {
    const school = this.school!;
    const k = this.promptKeys();
    const i = LESSONS.findIndex((l) => l.id === school.def.id);
    const snap = snapshotOf(this.jet, agl, this.ground.grounded, school.progress);
    const prompt = this.phase === 'crashed' ? 'Crashed – the lesson restarts in a moment.' : school.tracker.prompt(snap, k);
    const key = (a: InputAction): string => `<kbd>${escapeHtml(k.key(a))}</kbd>`;
    this.modeHud.set(
      `FLIGHT SCHOOL · Lesson ${i + 1}/${LESSONS.length}: ${school.def.title}`,
      `<div class="mode-objective">${escapeHtml(school.def.objective)}</div><div class="mode-prompt">${prompt}</div>` +
        `<div class="mode-foot">${key('respawn')} restart lesson · ${key('pause')} menu${this.input.gamepadConnected ? ' · controller connected' : ''}</div>`,
    );
  }

  private showPracticeSetup(courseId?: string): void {
    if (courseId) this.practiceChoice = { ...this.practiceChoice, courseId };
    const render = (): HTMLElement =>
      practiceSetupPanel(
        BUILTIN_COURSES.slice(),
        this.practiceChoice,
        (c) => this.startPractice(c),
        () => this.showMenu(),
        (panel) => this.menu.show(panel),
        (c) => this.practiceBest.get(practiceKey(c)) ?? null,
      );
    this.toMenuScreen(render());
  }

  /** Starts (or restarts) a practice section; invalid sections stay on the setup screen. */
  private startPractice(choice: PracticeChoice): void {
    const def = BUILTIN_COURSES.find((c) => c.id === choice.courseId);
    const r = def ? selectSection(def.gates.length, def.loop, choice.start, choice.count) : null;
    if (!def || !r?.ok) {
      this.hud.showMessage(r && !r.ok ? r.error : 'Unknown course', 3);
      return;
    }
    this.practiceChoice = { ...choice };
    this.endRace();
    this.ensurePlayerJet();
    this.spawnSlot = 0;
    this.mode = 'practice';
    this.paused = false;
    this.lastCourse = null;
    this.practice = new PracticeSession(def, r.section, this.heightField, choice.timed);
    this.applySettings();
    this.menu.hide();
    this.hud.setVisible(true);
    this.raceHud.setVisible(false);
    this.modeHud.setVisible(true);
    this.retryPractice();
    this.hud.showMessage(`PRACTICE – unranked · ${def.name}`, 2.5);
  }

  /** Back to the start of the same section. */
  private retryPractice(): void {
    const pr = this.practice!;
    pr.retry();
    this.rings.setGates(pr.gates);
    this.rings.showProgress(0);
    const p = pr.spawnPose(this.heightField, 0);
    this.spawnAt(p.position, p.heading, p.speed, false);
    this.flightTime = 0;
  }

  private updatePracticeHud(): void {
    const pr = this.practice!;
    const k = this.promptKeys();
    const key = (a: InputAction): string => `<kbd>${escapeHtml(k.key(a))}</kbd>`;
    const t = pr.sectionTime;
    let timing = '';
    if (pr.timed) {
      const best = this.practiceBest.get(practiceKey(this.practiceChoice));
      timing =
        `<div class="mode-big">${t === null ? '–:–' : formatRaceClock(t)}</div>` +
        (pr.crashed ? '<div class="mode-warn">Crashed – this run\'s time doesn\'t count</div>' : '') +
        (pr.progress.penalties ? `<div class="mode-warn">Penalties +${pr.progress.penalties} s</div>` : '') +
        (best !== undefined ? `<div>Best this session ${formatRaceClock(best)}</div>` : '');
    }
    const done = pr.state === 'complete';
    this.modeHud.set(
      `PRACTICE – unranked · ${pr.course.def.name}`,
      `<div class="mode-objective">${escapeHtml(describeSection(pr.section))}</div>` +
        `<div class="mode-prompt">${done ? 'Section complete!' : `Gate <b>${Math.min(pr.gatesDone + 1, pr.gates.length)}/${pr.gates.length}</b>`}</div>` +
        timing +
        `<div class="mode-foot">${key('respawn')} retry section · ${key('pause')} menu</div>`,
    );
  }

  private onPracticeComplete(): void {
    const pr = this.practice!;
    this.audio.playLapComplete();
    const key = practiceKey(this.practiceChoice);
    let text = 'Section complete';
    if (pr.timed && pr.lastTime !== null) {
      const prev = this.practiceBest.get(key);
      if (prev === undefined || pr.lastTime < prev) this.practiceBest.set(key, pr.lastTime);
      text += ` ${formatRaceClock(pr.lastTime)}${prev !== undefined && pr.lastTime < prev ? ' – new session best!' : ''}`;
    } else if (pr.timed) text += ' (crashed – time not counted)';
    this.hud.showMessage(`${text} · R to retry`, 4);
  }

  private modePause(): HTMLElement {
    const kind = this.mode === 'lesson' ? 'lesson' : 'practice';
    return modePausePanel(kind, {
      onResume: () => this.setPaused(false),
      onRestart: () => this.restart(),
      onChoose: () => (kind === 'lesson' ? this.showLessonList() : this.showPracticeSetup()),
      onSettings: () => this.menu.show(this.settingsPanel.render(() => this.menu.show(this.modePause(), true)), true),
      onMenu: () => this.showMenu(),
    });
  }

  private restart(): void {
    this.paused = false;
    this.setMpMenu(false);
    this.menu.hide();
    if (this.mpGame) {
      // Multiplayer: never restart the shared race, just respawn (not during the countdown: we're already on the grid).
      if (this.phase !== 'crashed' && !this.race?.frozen) this.respawnAfterCrash();
    } else if (this.mode === 'race' && this.lastCourse) this.startRace(this.lastCourse);
    else if (this.mode === 'free') this.spawnFree();
    else if (this.mode === 'lesson' && this.school) this.spawnLesson();
    else if (this.mode === 'practice' && this.practice) this.retryPractice();
  }

  private setPaused(p: boolean): void {
    if (this.mode === 'menu') return;
    if (this.mode === 'lesson' && this.school?.tracker.status === 'complete') {
      // The lesson is over: its completion screen stays up (Next / Retry / List / Menu).
      this.paused = true;
      this.showLessonComplete();
      return;
    }
    if (this.mode === 'lesson' || this.mode === 'practice') {
      this.paused = p;
      if (p) this.menu.show(this.modePause(), true);
      else this.menu.hide();
      return;
    }
    if (this.mpGame) {
      // Multiplayer doesn't pause the world: just show the menu and release the controls.
      this.setMpMenu(p);
      if (p) this.menu.showPause(this.mode === 'race', true);
      else this.menu.hide();
      return;
    }
    this.paused = p;
    if (p) this.menu.showPause(this.mode === 'race');
    else this.menu.hide();
  }

  private setMpMenu(open: boolean): void {
    this.mpMenuOpen = open;
    this.input.enabled = !open;
  }

  /** Browser tab hidden / window blurred (never G-force blackout). Inputs were already released. */
  private onFocusChange(focused: boolean): void {
    if (this.mode === 'menu' || this.race?.state === 'finished' || this.school?.tracker.status === 'complete') return;
    if (this.mpGame) {
      // Multiplayer runs on the shared session clock: no pause, just say so on return.
      if (focused) this.hud.showMessage('Multiplayer race still running', 3);
      return;
    }
    if (!focused && !this.paused) {
      this.setPaused(true);
      this.hud.showMessage('Paused – game lost focus', 2);
    }
  }

  // ---------------------------------------------------------------- spawning

  private spawnFree(): void {
    const s = this.settings.values;
    // Multiplayer: spread players over the runway (2 columns, 60 m rows) / the air start.
    const slot = this.spawnSlot;
    const dx = slot === 0 ? 0 : (slot % 2 === 1 ? -1 : 1) * 14;
    const back = Math.ceil(slot / 2) * 60;
    if (s.startOnRunway) {
      const r = this.heightField.runway;
      const pos = new Vector3(r.x + dx, r.height + GEAR_HEIGHT, r.z + r.halfLength - 80 - back);
      this.spawnAt(pos, 0, 0, true);
    } else {
      // In the air above the runway's axis, heading straight down it toward the canyon.
      const r = this.heightField.runway;
      const z = SPAWN_CONFIG.z + back * 2;
      const pos = new Vector3(r.x + dx * 3, this.heightField.getSurfaceHeight(r.x, z) + SPAWN_CONFIG.heightAboveGround, z);
      this.spawnAt(pos, 0, SPAWN_CONFIG.speed, false);
    }
    this.freeProgress = new RaceProgress(this.freeGates.length, 99);
    this.rings.showProgress(0);
    this.flightTime = 0;
  }

  private spawnAt(position: Vector3, heading: number, speed: number, onGround: boolean, opts: { orientation?: Quaternion; throttle?: number; gearDown?: boolean } = {}): void {
    const q = opts.orientation ?? new Quaternion().setFromAxisAngle(UP, heading);
    this.jet.reset({ position, orientation: q, speed, throttle: opts.throttle ?? (onGround ? 0 : 0.6) }, opts.gearDown ?? onGround);
    this.ground.reset(onGround, heading);
    this.phase = 'flying';
    this.respawnTimer = 0;
    this.vapor.reset();
    this.dust.reset();
    this.gforce.reset();
    this.explosion.group.visible = false;
    this.terrain.update(position, true);
    this.cameras.snap(this.cameraTarget);
  }

  /** Starting grid slot of the current race: two columns, 45 m apart, rows 70 m apart. */
  private gridPosition(): Vector3 {
    const st = this.race!.course.start;
    const fwd = new Vector3(-Math.sin(st.heading), 0, -Math.cos(st.heading));
    const side = new Vector3(-fwd.z, 0, fwd.x);
    const slot = this.spawnSlot;
    return st.position.clone().addScaledVector(side, slot === 0 ? 0 : (slot % 2 === 1 ? -1 : 1) * 45).addScaledVector(fwd, -Math.ceil(slot / 2) * 70);
  }

  private respawnAfterCrash(): void {
    if (this.mode === 'race' && this.race) {
      const p = this.race.respawnPose(this.heightField);
      // Before the first gate, go back to our own grid slot (not the pole position, where another player may be).
      const pos = this.race.player.totalGates === 0 ? this.gridPosition() : p.position;
      this.spawnAt(pos, p.heading, p.speed, false);
    } else if (this.mode === 'lesson' && this.school) {
      this.spawnLesson();
    } else if (this.mode === 'practice' && this.practice && this.practice.state === 'complete') {
      this.retryPractice();
    } else if (this.mode === 'practice' && this.practice) {
      // Practice checkpoint: back on the approach to the next gate of the section (the run's time is voided).
      const p = this.practice.checkpointPose(this.heightField);
      this.spawnAt(p.position, p.heading, p.speed, false);
    } else {
      this.spawnFree();
    }
  }

  private crash(reason: CrashReason): void {
    this.phase = 'crashed';
    this.respawnTimer = RESPAWN_DELAY;
    this.explosion.trigger(this.jet.position, this.jet.flight.state.velocity);
    this.jet.object.visible = false;
    this.shakeImpulse = 1.5;
    this.audio.playCrash();
    this.hud.showMessage(CRASH_TEXT[reason], 2.5);
    this.net.sendEvent('crash');
  }

  // ---------------------------------------------------------------- multiplayer

  /** Default server: the same host the game was loaded from (works for friends on the LAN). */
  private serverUrl(): string {
    const s = this.settings.values;
    if (s.serverUrl === DEFAULT_SETTINGS.serverUrl && location.hostname && location.hostname !== 'localhost') {
      return `ws://${location.hostname}:8787`;
    }
    return s.serverUrl;
  }

  private async connect(): Promise<string | null> {
    const s = this.settings.values;
    const url = this.serverUrl();
    try {
      await this.net.connect(url, s.playerName, s.jetId);
      return null;
    } catch {
      return `Could not reach the multiplayer server at ${url}.`;
    }
  }

  // ---------------------------------------------------------------- loop

  private handleActions(): void {
    const i = this.input;
    const flying = this.mode !== 'menu';
    if (i.consumePressed('pause') && flying) {
      if (this.race?.state === 'finished') {
        if (this.mpGame) this.backToLobby();
        else this.showMenu();
      } else this.setPaused(this.mpGame ? !this.mpMenuOpen : !this.paused);
    }
    if (i.consumePressed('fullscreen')) void this.toggleFullscreen();
    if (!flying || this.paused || this.mpMenuOpen) return;
    const leverNotice = i.consumeThrottleLeverNotice();
    if (leverNotice) this.hud.showMessage(leverNotice, 3);
    if (i.consumePressed('respawn')) this.restart();
    if (i.consumePressed('toggleCamera')) this.cameras.toggle(this.cameraTarget);
    if (i.consumePressed('toggleHelp')) this.hud.setHelpVisible(!this.hud.helpVisible);
    if (i.consumePressed('toggleGear')) {
      if (this.ground.grounded) this.hud.showMessage('Gear locked on the ground', 1.5);
      else {
        this.jet.gearDown = !this.jet.gearDown;
        this.hud.showMessage(this.jet.gearDown ? 'Gear down' : 'Gear up', 1.2);
      }
    }
    if (i.consumePressed('toggleLights')) this.hud.showMessage(this.jet.lights.toggle() ? 'Lights on' : 'Lights off', 1.2);
    this.jet.airbrake = i.isDown('airbrake');
  }

  private fixedUpdate(dt: number): void {
    if (this.mode === 'menu') return;
    if (this.paused) return;
    this.weather.tick(dt);
    this.impacts.tick(dt);

    const race = this.race;
    if (race) {
      const beep = race.tick(dt);
      if (beep !== null) {
        this.audio.playCountdownBeep(beep === 0);
      }
      race.fixedUpdateAIs(dt, this.heightField, this.weather, this.collision);
    }

    if (this.phase === 'crashed') {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawnAfterCrash();
      return;
    }
    if (race?.frozen) return;

    this.flightTime += dt;
    const jet = this.jet;
    this.weather.apply(jet.flight, this.collision.altitudeAboveGround(jet.position));
    jet.fixedUpdate(dt, this.input.getFlightControls());

    const groundEvent = this.ground.update(jet, dt);
    if (groundEvent === 'hardLanding') return this.crash('hardLanding');
    if (groundEvent === 'touchdown') this.hud.showMessage('Touchdown', 1.5);

    jet.getPreviousWorldCollisionPoints(this.before);
    jet.getWorldCollisionPoints(this.after);

    // Gates
    if (race) {
      const r = race.updatePlayer(this.before, this.after, jet.position, jet.flight.state.orientation, jet.flight.state.throttle);
      if (r) {
        this.rings.showProgress(r.finished ? race.course.gates.length : race.player.gateIndex);
        if (r.kind === 'missed') {
          this.audio.playGateMissed();
          this.hud.showMessage('Missed gate +3 s', 1.5);
        } else this.audio.playGatePass();
        if (r.lapCompleted && !r.finished) {
          this.audio.playLapComplete();
          this.hud.showMessage(`Lap ${race.player.lap}/${race.laps}`, 2);
        }
        if (r.finished) this.finishRace();
      }
    } else if (this.school) {
      const r = this.school.updateGates(this.before, this.after, dt);
      if (r) {
        if (r.kind === 'passed') this.audio.playGatePass();
        else this.audio.playGateMissed();
        this.rings.showProgress(r.finished ? this.school.gates.length : this.school.progress!.gateIndex);
      }
    } else if (this.practice) {
      const pr = this.practice;
      const r = pr.update(this.before, this.after, dt);
      if (r) {
        if (r.kind === 'missed') {
          this.audio.playGateMissed();
          this.hud.showMessage(pr.timed ? 'Missed gate +3 s' : 'Missed gate', 1.5);
        } else this.audio.playGatePass();
        this.rings.showProgress(r.finished ? pr.gates.length : pr.progress.gateIndex);
        if (r.finished) this.onPracticeComplete();
      }
    } else if (this.freeProgress) {
      const r = this.freeProgress.update(this.before, this.after, this.freeGates, this.flightTime);
      if (r?.kind === 'passed') this.audio.playGatePass();
      if (r) this.rings.showProgress(this.freeProgress.gateIndex);
    }

    // Collisions (same rules as the AI racers: ImpactTracker)
    const hit = this.impacts.apply(this.collision.check(this.after), jet);
    if (hit?.kind === 'crash') return this.crash(hit.reason);
    if (hit) {
      this.audio.playDamage();
      this.shakeImpulse = 0.8;
      this.hud.showMessage(hit.tree ? 'Tree strike!' : 'Wing scrape!', 1.2);
      if (hit.destroyed) return this.crash('damage');
    }

    // Flight school objective (checked after collisions: a crash restarts the lesson instead).
    const school = this.school;
    if (school) {
      const status = school.step(jet, this.collision.altitudeAboveGround(jet.position), this.ground.grounded, dt);
      if (status === 'complete') this.onLessonComplete();
      else if (school.failExpired) this.spawnLesson();
      else if (status === 'failed' && school.failTime <= dt) this.hud.showMessage(school.tracker.failReason, 2.5);
    }
  }

  private finishRace(): void {
    const race = this.race!;
    const result = race.finish(this.jet.position, this.remoteStandings());
    if (this.mpGame) this.net.sendEvent('finish', result.time);
    this.audio.playLapComplete();
    this.raceHud.showResults({
      courseName: race.course.def.name,
      ...result,
      multiplayer: this.mpGame,
      onRestart: () => this.restart(),
      onMenu: () => (this.mpGame ? this.backToLobby() : this.showMenu()),
    });
  }

  /** Race standings entries for the other players in the multiplayer lobby. */
  private remoteStandings(): Standing[] {
    const race = this.race;
    if (!this.mpGame || !race) return [];
    const gates = race.course.gates;
    const now = performance.now();
    const out: Standing[] = [];
    for (const p of this.net.lobby?.players ?? []) {
      if (p.id === this.net.id || !p.inGame) continue;
      const prog = this.net.getProgress(p.id);
      const gate = Math.min(prog?.gate ?? 0, gates.length - 1);
      const lap = prog?.lap ?? 1;
      const snap = this.net.getRemoteSnapshot(p.id, now, this.remoteSnap);
      out.push({
        name: p.name,
        isPlayer: false,
        finished: prog?.finishTime != null,
        time: prog?.finishTime ?? 0,
        totalGates: (lap - 1) * gates.length + gate,
        distance: snap ? snap.position.distanceTo(gates[gate]!.center) : Infinity,
      });
    }
    return out;
  }

  private render(alpha: number, frameDt: number): void {
    // Menu mode: keys go to the menu, the gamepad navigates it, and nothing leaks into flight.
    this.input.setMenuMode(this.mode === 'menu' || this.paused || this.mpMenuOpen);
    this.input.poll(frameDt);
    this.handleActions();
    this.time += frameDt;
    const flying = this.mode !== 'menu';
    const dt = this.paused ? 0 : frameDt;
    const camera = this.cameras.camera;

    if (this.mode === 'menu') {
      this.updateMenuCamera();
      this.audio.update(null, frameDt);
      this.audio.updateFlybys(null, null);
    } else {
      this.renderFlight(alpha, dt);
    }

    this.explosion.update(dt, (x, z) => this.heightField.getSurfaceHeight(x, z));
    this.rings.animate(this.time);
    this.remotes.setVisible(this.mpGame);
    if (this.mpGame) this.remotes.render(performance.now(), this.time, dt);
    this.terrain.update(camera.position);
    this.props.update(camera.position);
    this.river.update(camera.position, this.time);
    this.clouds.update(camera, this.weather.wind, dt);
    this.lights.follow(flying ? this.jet.object.position : this.tmp.copy(camera.position).setY(this.heightField.getHeightAt(camera.position.x, camera.position.z)));
    this.sky.update(camera.position);
    this.renderer.render(this.scene, camera);
    this.adaptResolution(frameDt);
  }

  /**
   * Dynamic resolution: if frames take too long, render fewer pixels; when there is headroom,
   * go back up to the quality preset's resolution.
   */
  private adaptResolution(frameDt: number): void {
    if (frameDt <= 0) return;
    this.frameTimeAvg += (frameDt * 1000 - this.frameTimeAvg) * 0.05;
    this.resolutionTimer += frameDt;
    if (this.resolutionTimer < 1) return;
    this.resolutionTimer = 0;
    const g = GRAPHICS_PRESETS[this.settings.values.graphics];
    const max = Math.min(window.devicePixelRatio, g.pixelRatio);
    let next = this.pixelRatio;
    if (this.frameTimeAvg > 20) next = Math.max(g.minPixelRatio, this.pixelRatio - 0.1);
    else if (this.frameTimeAvg < 14) next = Math.min(max, this.pixelRatio + 0.05);
    if (Math.abs(next - this.pixelRatio) > 1e-3) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
    }
  }

  /** Other aircraft the player can hear: race AIs and visible multiplayer pilots. */
  private collectFlybySources(): FlybySource[] {
    const out = this.flybySources;
    out.length = 0;
    this.race?.ais.forEach((ai, i) => {
      const s = ai.jet.flight.state;
      out.push({ key: `ai:${i}`, position: s.position, velocity: s.velocity, throttle: s.throttle, jetId: ai.jet.definition.id });
    });
    if (this.mpGame) {
      for (const [id, p] of this.remotes.puppets) {
        if (!p.jet.object.visible) continue;
        out.push({ key: `remote:${id}`, position: p.jet.object.position, velocity: null, throttle: p.jet.flight.state.throttle, jetId: p.jet.definition.id });
      }
    }
    return out;
  }

  private updateFlybyListener(): FlybyListener {
    const cam = this.cameras.camera;
    const l = this.flybyListener;
    l.position.copy(cam.position);
    l.right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    l.velocity.copy(this.jet.flight.state.velocity);
    return l;
  }

  private renderFlight(alpha: number, dt: number): void {
    const jet = this.jet;
    const flight = jet.flight;
    const t = flight.telemetry;
    const crashed = this.phase === 'crashed';
    if (!crashed) jet.render(this.paused ? 1 : alpha, this.time, dt);
    this.race?.render(this.time, dt, this.paused ? 1 : alpha);

    this.cameraTarget.speed = t.speed;
    this.cameras.update(this.cameraTarget, dt);
    const agl = this.collision.altitudeAboveGround(flight.state.position);
    shakeOffset(this.time, crashed ? 0 : t.speed, agl, this.shakeImpulse, this.shake);
    this.shakeImpulse = Math.max(0, this.shakeImpulse - dt * 1.5);
    this.cameras.camera.position.add(this.shake.applyQuaternion(this.cameras.camera.quaternion));
    jet.parts.canopy.visible = this.cameras.mode !== 'cockpit';

    // Effects
    jet.object.updateMatrixWorld();
    const left = jet.object.localToWorld(this.tmp.set(-6.6, 0, 4));
    const right = jet.object.localToWorld(this.tmp2.set(6.6, 0, 4));
    const vaporIntensity = crashed ? 0 : Math.max(smoothstep(4.5, 7.5, t.gLoad), smoothstep(0.18, 0.27, Math.abs(t.aoa)) * smoothstep(80, 140, t.speed));
    this.vapor.update(dt, left, right, vaporIntensity, this.cameras.camera.position);
    this.dust.update(dt, flight.state.position, flight.state.velocity, crashed ? 999 : agl, (x, z) => this.heightField.getSurfaceHeight(x, z));
    this.gforce.update(crashed ? 1 : t.gLoad, dt);

    const pullUp = !crashed && !this.ground.grounded && !this.race?.frozen && this.collision.terrainAhead(flight.state.position, flight.state.velocity, 2.5);
    this.audio.update(
      crashed || this.paused
        ? null
        : { throttle: flight.state.throttle, afterburner: t.afterburner, speed: t.speed, gLoad: t.gLoad, stallWarning: t.stallWarning && !this.ground.grounded, pullUp, agl },
      dt,
    );
    this.audio.setJet(jet.definition.id);
    this.audio.updateFlybys(this.paused ? null : this.collectFlybySources(), this.updateFlybyListener());

    // Multiplayer: share our state.
    if (this.mpGame && !crashed) {
      const p = this.race?.player ?? this.freeProgress;
      this.net.sendState(
        { position: flight.state.position, quaternion: flight.state.orientation, velocity: flight.state.velocity, throttle: flight.state.throttle, afterburner: t.afterburner, gate: p?.gateIndex ?? 0, lap: p?.lap ?? 1 },
        performance.now(),
      );
    }
    this.netEventTimer += dt;

    // Gate navigator: every frame, from the active camera, so it follows passes, misses and respawns at once.
    const prog = this.race?.player ?? this.school?.progress ?? this.practice?.progress ?? this.freeProgress;
    const navGates = this.race ? this.race.course.gates : this.school?.progress ? this.school.gates : this.practice ? this.practice.gates : this.freeGates;
    this.hud.nav.update(
      this.cameras.camera,
      prog && !prog.finished && !crashed
        ? { gates: navGates, gateIndex: prog.gateIndex, lap: prog.lap, laps: prog.laps, loop: this.race ? this.race.course.def.loop : this.mode === 'free', position: flight.state.position }
        : null,
      dt,
    );

    // The HUD is DOM text: 20 updates per second is plenty and saves layout work every frame.
    this.hudTimer += dt;
    if (this.hudTimer < 0.05 && !this.paused) return;
    const hudDt = this.hudTimer;
    this.hudTimer = 0;
    const s = flight.state;
    const next = this.mode === 'free' && this.freeProgress ? this.freeGates[this.freeProgress.gateIndex] : undefined;
    this.hud.update(
      {
        phase: this.paused ? 'paused' : this.phase,
        speed: t.speed,
        altitude: s.position.y,
        agl,
        verticalSpeed: s.velocity.y,
        heading: Math.atan2(s.velocity.x, -s.velocity.z) * RAD2DEG,
        throttle: s.throttle,
        afterburner: t.afterburner,
        gLoad: t.gLoad,
        aoa: t.aoa * RAD2DEG,
        stallWarning: t.stallWarning && !this.ground.grounded,
        pullUp,
        ringsPassed: this.freeProgress?.totalGates ?? 0,
        ringsTotal: this.freeGates.length,
        nextRingDistance: next ? next.center.distanceTo(s.position) : null,
        flightTime: this.flightTime,
        cameraMode: this.cameras.mode,
        respawnIn: Math.max(0, this.respawnTimer),
        health: jet.damage.health,
        gearDown: jet.gearDown,
        airbrake: jet.airbrake,
        showRings: this.mode === 'free',
      },
      hudDt,
    );
    if (this.school) this.updateLessonHud(agl);
    else if (this.practice) this.updatePracticeHud();

    const race = this.race;
    if (race) {
      const standings = race.standings(s.position, this.remoteStandings());
      this.raceHud.update(
        {
          countdown: race.state === 'countdown' ? race.countdown : race.raceTime < 1 ? 0 : null,
          raceTime: race.state === 'finished' ? race.player.finishTime : race.raceTime + race.player.penalties,
          lap: race.player.lap,
          laps: race.laps,
          gate: race.player.gateIndex,
          gates: race.course.gates.length,
          position: standings.findIndex((x) => x.isPlayer) + 1,
          racers: standings.length,
          penalties: race.player.penalties,
          split: race.split,
          standings: standings.map((x, i) => `${i + 1}. ${x.isPlayer ? '<b>' : ''}${x.name}${x.isPlayer ? '</b>' : ''}${x.finished ? ` ${formatTime(x.time)}` : ''}`),
        },
        hudDt,
      );
    }
  }

  /** Slow cinematic orbit over the valley behind the main menu. */
  private updateMenuCamera(): void {
    const cam = this.cameras.camera;
    const z = 1500 - this.time * 40;
    const x = valleyCenterX(z);
    const ground = this.heightField.getSurfaceHeight(x, z);
    cam.position.set(x + Math.sin(this.time * 0.1) * 60, ground + 90, z);
    const lz = z - 400;
    cam.up.copy(UP);
    cam.lookAt(valleyCenterX(lz), this.heightField.getSurfaceHeight(valleyCenterX(lz), lz) + 40, lz);
  }

  private async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await this.container.requestFullscreen();
    // In fullscreen, Chrome/Edge let the page capture Ctrl+W & co. so the throttle key can't close the tab.
    const keyboard = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard;
    await keyboard?.lock?.().catch(() => undefined);
  }
}
