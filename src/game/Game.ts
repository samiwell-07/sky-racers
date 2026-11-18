import { Group, Mesh, MeshStandardMaterial, Points, Quaternion, Scene, Vector3, type Material, type Object3D, type WebGLRenderer } from 'three';
import { AudioEngine, type FlybyListener, type FlybySource } from '../audio/AudioEngine';
import { CameraManager } from '../camera/CameraManager';
import { cockpitEyeFor } from '../camera/CockpitCamera';
import type { CameraTarget } from '../camera/CameraController';
import { createCameraConfig } from '../config/cameraConfig';
import { DEFAULT_FLIGHT_CONFIG, createFlightConfig } from '../config/flightConfig';
import { GameLoop } from '../core/GameLoop';
import { createRenderer, handleResize } from '../core/Renderer';
import { shakeOffset } from '../effects/CameraShake';
import { DustKicker } from '../effects/DustKicker';
import { VaporTrails } from '../effects/VaporTrails';
import { Explosion } from '../entities/effects/Explosion';
import { Jet } from '../entities/jet/Jet';
import { GEAR_HEIGHT } from '../entities/jet/JetModel';
import { getJetDefinition } from '../entities/jet/jetCatalog';
import { loadJetAppearance, sameJetAppearance } from '../entities/jet/jetAppearance';
import { InputManager } from '../input/InputManager';
import { KeyBindings, keyLabel } from '../input/KeyBindings';
import { PadBindings } from '../input/PadBindings';
import { NetClient } from '../net/NetClient';
import { BUILTIN_COURSES, type CourseDef } from '../race/Course';
import type { Lobby } from '../net/lobbyTypes';
import { LobbyMenu } from '../ui/LobbyMenu';
import { CourseLibrary } from '../race/CourseLibrary';
import { Leaderboard } from '../race/Leaderboard';
import { DEFAULT_SETTINGS, GRAPHICS_PRESETS, SettingsStore } from '../settings/Settings';
import { CollisionSystem, IMPACT_RULES, ImpactTracker, type CrashReason } from '../systems/CollisionSystem';
import { GroundHandling } from '../systems/GroundHandling';
import { GForceOverlay } from '../ui/GForceOverlay';
import type { FlightControls } from '../physics/types';
import { Hud, formatTime, type GamePhase } from '../ui/Hud';
import { MainMenu } from '../ui/MainMenu';
import { attachMenuNavigation } from '../ui/menuFocus';
import { RaceHud } from '../ui/RaceHud';
import { SettingsPanel } from '../ui/SettingsPanel';
import { RAD2DEG, smoothstep } from '../utils/math';
import { Clouds } from '../world/environment/Clouds';
import { Lights } from '../world/environment/Lights';
import { createRunwayMesh } from '../world/environment/Runway';
import { Sky } from '../world/environment/Sky';
import { applyTimeOfDay } from '../world/environment/TimeOfDay';
import { Weather } from '../world/environment/Weather';
import { PropsManager } from '../world/props/PropsManager';
import { RingManager } from '../world/rings/RingManager';
import { HeightField } from '../world/terrain/HeightField';
import { createTerrainMaterial } from '../world/terrain/TerrainMaterial';
import { TerrainStreamer } from '../world/terrain/TerrainStreamer';
import { RaceSession, type Standing } from './RaceSession';
import type { InputAction } from '../config/controlsConfig';
import { FlightSchool, snapshotOf } from '../modes/FlightSchool';
import { escapeHtml, LESSON_WORLD, LESSONS, LessonProgressStore, nextLesson, type LessonDef, type PromptKeys } from '../modes/lessons';
import { describeSection, PracticeSession, selectSection, type PracticeChoice } from '../modes/PracticeSession';
import { formatRaceClock } from '../race/Splits';
import { ModeHud } from '../ui/ModeHud';
import type { SaveResult } from '../settings/safeStorage';
import { lessonCompletePanel, lessonListPanel, modePausePanel, practiceSetupPanel } from '../ui/ModeMenus';
import { RemotePlayers } from './RemotePlayers';
import { freeSpawnPose, menuCameraPose, menuOrbitHeight, propsOptionsFor } from './worldSession';
import { createWorld } from '../world/gen/createWorld';
import { CLASSIC_WORLD, worldKey, type WorldGenerator, type WorldSpec } from '../world/gen/WorldGenerator';
import { updateWater } from '../world/water/water';
import { lobbyForcedView, lobbyJetId, lobbyRaceCourse, lobbyWorldSpec, type LobbyMode } from '../net/lobbyTypes';
import type { RaceDifficulty, RaceLayout } from '../race/generatedCourse';
import { generateCourseForRequest } from '../race/CourseGenerator';
import { Radar } from '../ui/radar/Radar';
import { RadarContactList, addAirfieldContact, addGateContacts, addJetContact, addMissileContacts, selfFromPose } from '../ui/radar/radarProviders';
import { DogfightSession, dogfightSlot } from '../modes/DogfightSession';
import { PICKUP_REWARDS } from '../modes/dogfight/pickups';
import { DogfightHud } from '../ui/dogfight/DogfightHud';
import type { Combatant, WeaponInput } from '../combat';
import { DOGFIGHT_RULES } from '../combat/types';

/** 'lesson' = flight school, 'practice' = unranked gate-section practice. Every mode but 'menu' is flying. */
type Mode = 'menu' | 'free' | 'race' | 'lesson' | 'practice' | 'dogfight';

/** Remote opponent as a Combatant, refreshed from the interpolated network snapshot every fixed step. */
interface RemoteCombatant extends Combatant {
  id: string;
  afterburner: boolean;
  alive: boolean;
}

interface RemoteOpponent {
  snap: { position: Vector3; quaternion: Quaternion; velocity: Vector3; throttle: number; afterburner: boolean };
  combatant: RemoteCombatant;
  explosion: Explosion;
}

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
const NO_FLIGHT_CONTROLS: FlightControls = { pitch: 0, roll: 0, throttle: 0 };
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
  private readonly padBindings = new PadBindings();
  private readonly input: InputManager;
  private readonly flightConfig = createFlightConfig();
  private readonly cameraConfig = createCameraConfig();

  // World
  /** The loaded world (Classic Canyon or a seeded world); switched with setWorld() between sessions. */
  private currentWorld: WorldGenerator = createWorld(CLASSIC_WORLD);
  private heightField = new HeightField(this.currentWorld);
  private runwayMesh: Mesh;
  /** Cached menu flyover height of the current (non-Classic) world. */
  private menuOrbitY: number | null = null;
  private readonly terrain: TerrainStreamer;
  private readonly sky: Sky;
  private readonly lights: Lights;
  private readonly clouds = new Clouds();
  private readonly weather: Weather;
  private readonly props: PropsManager;

  // Player
  private jet: Jet;
  private ground: GroundHandling;
  private collision: CollisionSystem;
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
  private lastLaps: number | undefined = undefined;

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
  /** Camera view the lobby host imposes during the current multiplayer game (null = pilot's choice). */
  private forcedView: 'chase' | 'cockpit' | null = null;
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
  /** Terrain materials per (simple shader, world water level). */
  private readonly terrainMaterials = new Map<string, Material>();
  // Radar (every flying mode) and the dogfight session (dogfight mode only).
  private readonly radar: Radar;
  private readonly radarList = new RadarContactList();
  private readonly radarSelf = { x: 0, y: 0, z: 0, heading: 0 };
  private dogfight: DogfightSession | null = null;
  /** One explosion per possible opponent (a dogfight has up to DOGFIGHT_RULES.maxPlayers - 1). */
  private readonly opponentExplosions = Array.from({ length: DOGFIGHT_RULES.maxPlayers - 1 }, () => new Explosion());
  /** Dogfight opponents: interpolated snapshot + Combatant view, by player id. */
  private readonly opponents = new Map<string, RemoteOpponent>();
  private readonly weaponInput: WeaponInput = { fireGun: false, fireMissile: false, fireMissileHeld: false, releaseFlares: false };
  private readonly oppList: Combatant[] = [];
  // Dynamic resolution + UI throttling.
  private pixelRatio = 1;
  private frameTimeAvg = 16;
  private resolutionTimer = 0;
  private hudTimer = 0;

  constructor(private readonly container: HTMLElement) {
    const preset = GRAPHICS_PRESETS[this.settings.values.graphics];
    // Anti-aliasing can only be chosen when the WebGL context is created (applies after a reload).
    this.renderer = createRenderer(container, preset.antialias);
    this.input = new InputManager(this.bindings, this.settings.values, this.renderer.domElement, window, this.padBindings);
    this.input.onFocusChange((focused) => this.onFocusChange(focused));
    this.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.terrain = new TerrainStreamer(this.heightField, this.terrainMaterial(preset.simpleTerrain));
    this.sky = new Sky(this.scene);
    this.lights = new Lights(this.scene);
    this.weather = new Weather({ windSpeed: 0, windDirection: 0, turbulence: 0 });
    this.weather.setCanyonFactor((x, z) => this.currentWorld.canyonFactor(x, z));
    this.props = new PropsManager(propsOptionsFor(this.currentWorld));
    this.ground = new GroundHandling(this.heightField);
    this.collision = new CollisionSystem(this.heightField, this.props);
    this.jet = this.createPlayerJet();
    this.runwayMesh = createRunwayMesh(this.heightField.runway);
    this.scene.add(this.terrain.group, this.clouds.mesh, this.props.group, this.rings.group, this.explosion.group, ...this.opponentExplosions.map((e) => e.group), this.vapor.object, this.dust.object, this.runwayMesh);

    const groundHeight = (x: number, z: number): number => this.heightField.getSurfaceHeight(x, z);
    this.cameras = new CameraManager(this.cameraConfig, groundHeight);
    this.cameraTarget = { position: this.jet.object.position, quaternion: this.jet.object.quaternion, speed: 0, cockpitEye: cockpitEyeFor(this.jet.definition.id) };

    this.gforce = new GForceOverlay(container);
    this.hud = new Hud(container, this.bindings, this.padBindings);
    const sv = this.settings.values;
    this.radar = new Radar(this.hud.element, { range: sv.radarRange, visible: sv.showRadar, scale: sv.hudScale });
    this.hud.mountRadar(this.radar.root);
    this.radar.onRangeChange = (m) => {
      if (this.settings.values.radarRange !== m) this.settings.set('radarRange', m);
    };
    this.raceHud = new RaceHud(container);
    this.modeHud = new ModeHud(container);
    const settingsPanel = (this.settingsPanel = new SettingsPanel(this.settings, this.bindings, this.input, this.padBindings));
    this.menu = new MainMenu(container, this.settings, this.courses, this.leaderboard, settingsPanel, {
      startFreeFlight: (world) => this.startFreeFlight(world),
      startRace: (id) => {
        const c = this.courses.get(id);
        if (c) this.startRace(c);
      },
      startGeneratedRace: (world, difficulty, layout, laps) => this.startGeneratedRace(world, difficulty, layout, laps),
      openFlightSchool: () => this.showLessonList(),
      openPractice: (courseId) => this.showPracticeSetup(courseId),
      openMultiplayer: (mode?: LobbyMode) => void this.lobbyMenu.open(mode ?? null),
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
      () => this.input.capturing,
      () => this.input.cancelCapture(),
    );
    // Leaving or redrawing a menu screen abandons a pending key / button capture.
    this.menu.onScreenChange = () => this.input.cancelCapture();
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

  private createPlayerJet(jetId = this.settings.values.jetId): Jet {
    const def = getJetDefinition(jetId);
    Object.assign(this.flightConfig, DEFAULT_FLIGHT_CONFIG, def.flight);
    const jet = new Jet(def, this.flightConfig, true, loadJetAppearance(def.id));
    this.scene.add(jet.object);
    return jet;
  }

  /** Refresh the airframe and its saved finish before spawning for the next flight. */
  private ensurePlayerJet(lobby: Lobby | null = null): void {
    const jetId = lobby ? lobbyJetId(lobby.settings, this.settings.values.jetId) : this.settings.values.jetId;
    if (this.jet.definition.id === jetId && sameJetAppearance(this.jet.appearance, loadJetAppearance(jetId))) {
      Object.assign(this.flightConfig, DEFAULT_FLIGHT_CONFIG, this.jet.definition.flight);
      return;
    }
    this.jet.dispose();
    this.jet = this.createPlayerJet(jetId);
    this.cameraTarget.position = this.jet.object.position;
    this.cameraTarget.quaternion = this.jet.object.quaternion;
    this.cameraTarget.cockpitEye = cockpitEyeFor(this.jet.definition.id);
  }

  private terrainMaterial(simple: boolean): Material {
    // Seeded worlds have their sea at 0 m, Classic's river at 17 m: the bank shading follows the world.
    const cfg = this.currentWorld.config;
    const key = `${simple}:${cfg.waterLevel}:${cfg.detailTextureScale}`;
    let m = this.terrainMaterials.get(key);
    if (!m) {
      m = createTerrainMaterial(cfg, this.anisotropy, simple);
      this.terrainMaterials.set(key, m);
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
    this.radar.setVisible(s.showRadar);
    this.radar.setScale(s.hudScale);
    this.radar.setRange(s.radarRange);
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
    const world = lobbyWorldSpec(lobby.settings.world);
    if (lobby.settings.mode === 'race') {
      const rc = lobbyRaceCourse(lobby.settings);
      if (rc.kind === 'classic') {
        const course = BUILTIN_COURSES.find((c) => c.id === rc.courseId) ?? BUILTIN_COURSES[0]!;
        this.startRace(course, lobby);
      } else {
        this.startGeneratedRace(rc.request.world, rc.request.difficulty, rc.request.layout, rc.laps, lobby);
      }
    } else if (lobby.settings.mode === 'dogfight') {
      this.startDogfight(lobby, world);
    } else {
      this.startFreeFlight(world, lobby);
      if (late) this.hud.showMessage(`Joined ${lobby.settings.name}`, 3);
    }
    this.forcedView = lobbyForcedView(lobby.settings);
    if (this.forcedView) this.setCameraView(this.forcedView);
  }

  private setCameraView(view: 'chase' | 'cockpit'): void {
    // CameraManager only toggles; bounded in case more views are added.
    for (let i = 0; i < 4 && this.cameras.mode !== view; i++) this.cameras.toggle(this.cameraTarget);
  }

  /** Race on the course generated for a seeded world (deterministic: same request = same course). */
  private startGeneratedRace(world: WorldSpec, difficulty: RaceDifficulty, layout: RaceLayout, laps: number, lobby: Lobby | null = null): void {
    this.startRace(generateCourseForRequest({ world, difficulty, layout }), lobby, laps);
  }

  /** Multiplayer dogfight (free-for-all, 2-4 pilots) on the lobby's world. */
  private startDogfight(lobby: Lobby, world: WorldSpec): void {
    this.endRace();
    this.ensurePlayerJet(lobby);
    this.setWorld(world);
    this.mpGame = true;
    this.mode = 'dogfight';
    this.paused = false;
    this.menu.hide();
    this.hud.setVisible(true);
    this.raceHud.setVisible(false);
    this.rings.clear();
    this.flightTime = 0;
    const selfId = this.net.id ?? 'local';
    // The pilots who started the match (late joiners wait in the lobby); they size the zone.
    const pilots = lobby.players.filter((p) => p.inGame || p.id === selfId);
    const rivals = pilots.filter((p) => p.id !== selfId);
    this.opponents.clear();
    rivals.forEach((p, i) => {
      const snap = { position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), throttle: 0, afterburner: false };
      const combatant: RemoteCombatant = { id: p.id, position: snap.position, velocity: snap.velocity, orientation: snap.quaternion, afterburner: false, alive: false };
      this.opponents.set(p.id, { snap, combatant, explosion: this.opponentExplosions[i % this.opponentExplosions.length]! });
    });
    const hud = new DogfightHud({ onBackToLobby: () => this.backToLobby() });
    hud.mount(this.container);
    const spec = this.currentWorld.spec;
    this.dogfight = new DogfightSession({
      net: this.net,
      selfId,
      opponents: rivals.map((p) => ({ id: p.id, name: p.name })),
      world: this.currentWorld,
      seed: spec.kind === 'seeded' ? spec.seed : 0,
      slot: dogfightSlot(selfId, pilots.map((p) => p.id)),
      jet: this.jet,
      scene: this.scene,
      hud,
      audio: this.audio,
      hooks: {
        respawn: (s) => this.spawnAt(s.position, s.heading, s.speed, false, { orientation: s.orientation }),
        destroyed: () => {
          this.phase = 'crashed';
          this.respawnTimer = 0;
          this.explosion.trigger(this.jet.position, this.jet.flight.state.velocity);
          this.jet.object.visible = false;
          this.shakeImpulse = 1.5;
          this.audio.playCrash();
        },
        opponentDestroyed: (id) => {
          const o = this.opponents.get(id);
          if (o && o.combatant.alive) o.explosion.trigger(o.snap.position, o.snap.velocity);
        },
        countdownBeep: (go) => this.audio.playCountdownBeep(go),
        finished: () => {
          if (document.pointerLockElement) document.exitPointerLock();
        },
      },
    });
    this.dogfight.start();
    const zoneKm = Math.round((this.dogfight.zone.radius * 2) / 1000);
    this.hud.showMessage(
      rivals.length === 0
        ? 'Dogfight: waiting for an opponent'
        : rivals.length === 1
          ? `Dogfight vs ${rivals[0]!.name} · ${zoneKm} km zone`
          : `Dogfight: ${pilots.length}-way free-for-all · ${zoneKm} km zone`,
      3,
    );
  }

  /** Free flight on `spec` (default Classic): no gates, just the world. */
  private startFreeFlight(spec: WorldSpec = CLASSIC_WORLD, lobby: Lobby | null = null): void {
    this.endRace();
    this.ensurePlayerJet(lobby);
    this.setWorld(spec);
    this.mpGame = lobby !== null;
    if (!lobby) this.spawnSlot = 0;
    this.mode = 'free';
    this.menu.hide();
    this.hud.setVisible(true);
    this.raceHud.setVisible(false);
    this.rings.clear();
    this.spawnFree();
    this.hud.showMessage(this.settings.values.startOnRunway ? 'Full throttle, pull up at 280 km/h · G = gear' : 'Free flight', 4);
  }

  /** `laps` overrides the settings' laps (generated races pick theirs in the setup screen). */
  private startRace(course: CourseDef, lobby: Lobby | null = null, laps?: number): void {
    this.endRace();
    this.ensurePlayerJet(lobby);
    this.setWorld(course.world ?? CLASSIC_WORLD);
    this.mpGame = lobby !== null;
    if (!lobby) this.spawnSlot = 0;
    this.mode = 'race';
    this.lastCourse = course;
    this.lastLaps = laps;
    this.menu.hide();
    this.hud.setVisible(true);
    this.raceHud.setVisible(true);
    // Multiplayer races: the lobby decides the laps; no AI or ghost so everyone races the same field.
    const raceSettings = lobby
      ? { ...this.settings.values, laps: laps ?? lobby.settings.laps, aiOpponents: 0, showGhost: false }
      : laps !== undefined ? { ...this.settings.values, laps } : this.settings.values;
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
    this.school = null;
    this.practice = null;
    if (this.dogfight) {
      this.dogfight.dispose();
      this.dogfight = null;
      this.opponents.clear();
      for (const e of this.opponentExplosions) e.group.visible = false;
    }
    this.modeHud.setVisible(false);
    this.raceHud.hideResults();
  }

  /**
   * Loads another world between sessions (no-op if it is already loaded): terrain, chunk water,
   * props, runway, weather canyon factor, ground handling and collision all follow the world.
   */
  private setWorld(spec: WorldSpec): void {
    if (worldKey(spec) === worldKey(this.currentWorld.spec)) return;
    const world = createWorld(spec);
    this.currentWorld = world;
    this.heightField = new HeightField(world);
    this.menuOrbitY = null;
    this.terrain.setWorld(this.heightField);
    this.terrain.setMaterial(this.terrainMaterial(GRAPHICS_PRESETS[this.settings.values.graphics].simpleTerrain));
    this.sky.setFogRange(this.terrain.viewDistance * 0.12, this.terrain.viewDistance * 0.9);
    this.props.setWorld(propsOptionsFor(world));
    this.weather.setCanyonFactor((x, z) => world.canyonFactor(x, z));
    this.ground = new GroundHandling(this.heightField);
    this.collision = new CollisionSystem(this.heightField, this.props);
    this.scene.remove(this.runwayMesh);
    this.runwayMesh.geometry.dispose();
    const runwayMaterial = this.runwayMesh.material as MeshStandardMaterial;
    runwayMaterial.map?.dispose();
    runwayMaterial.dispose();
    this.runwayMesh = createRunwayMesh(this.heightField.runway);
    this.scene.add(this.runwayMesh);
  }

  // ---------------------------------------------------------------- flight school & practice

  /** Leaves any game in progress for a menu screen (keeps the menu background running). */
  private toMenuScreen(panel: HTMLElement): void {
    if (this.mode !== 'menu') this.showMenu();
    this.menu.show(panel);
  }

  private showLessonList(): void {
    this.toMenuScreen(lessonListPanel(this.lessonProgress, (l) => this.startLesson(l), () => this.showPracticeMenu()));
  }

  /** Practice chooser: flight school or gate sections. */
  private showPracticeMenu(): void {
    if (this.mode !== 'menu') this.showMenu();
    this.menu.showPracticeMenu();
  }

  private startLesson(lesson: LessonDef): void {
    this.endRace();
    this.ensurePlayerJet();
    this.spawnSlot = 0;
    this.setWorld(CLASSIC_WORLD);
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
      pad: (a: InputAction) => (pad ? this.padBindings.hint(a) : null),
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
        () => this.showPracticeMenu(),
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
    this.setWorld(CLASSIC_WORLD);
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
      // Dogfight respawns are decided by the match itself.
      if (this.mode !== 'dogfight' && this.phase !== 'crashed' && !this.race?.frozen) this.respawnAfterCrash();
    } else if (this.mode === 'race' && this.lastCourse) this.startRace(this.lastCourse, null, this.lastLaps);
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
    const p = freeSpawnPose(this.currentWorld, this.spawnSlot, this.settings.values.startOnRunway, (x, z) => this.heightField.getSurfaceHeight(x, z), GEAR_HEIGHT);
    this.spawnAt(new Vector3(p.x, p.y, p.z), p.heading, p.speed, p.onGround);
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
    if (this.dogfight) this.dogfight.onLocalCrash();
    else this.net.sendEvent('crash');
  }

  /** Weapon triggers and the opponents for one dogfight step (no triggers while frozen, dead or in the menu). */
  private dogfightContext(withInput: boolean): { input: WeaponInput; opponents: readonly Combatant[] } {
    const i = this.input;
    const w = this.weaponInput;
    const live = withInput && !this.mpMenuOpen;
    const missilePressed = i.consumePressed('fireMissile');
    const flaresPressed = i.consumePressed('releaseFlares');
    w.fireGun = live && i.isDown('fireGun');
    w.fireMissile = live && missilePressed;
    w.fireMissileHeld = live && i.isDown('fireMissile');
    w.releaseFlares = live && flaresPressed;
    this.updateOpponents();
    return { input: w, opponents: this.oppList };
  }

  /** Refreshes the remote opponent combatants from the interpolated snapshots (unknown ones are skipped). */
  private updateOpponents(): void {
    const df = this.dogfight;
    this.oppList.length = 0;
    const now = performance.now();
    for (const [id, o] of this.opponents) {
      const c = o.combatant;
      const snap = df && df.isOpponent(id) ? this.net.getRemoteSnapshot(id, now, o.snap) : null;
      if (!df || !snap) {
        c.alive = false;
        continue;
      }
      c.afterburner = snap.afterburner;
      c.alive = df.isOpponentAlive(id);
      this.oppList.push(c);
    }
  }

  /** Radar contacts of the current mode: gates, AI racers, ghost, other players, missiles, flares, airfield. */
  private updateRadar(): void {
    const list = this.radarList;
    list.clear();
    addAirfieldContact(list, this.heightField.runway);
    const race = this.race;
    if (race) {
      addGateContacts(list, race.course.gates, race.player.gateIndex, 4, race.course.def.loop);
      for (const ai of race.ais) addJetContact(list, 'ai', ai.jet.position, ai.jet.flight.state.orientation, ai.name);
      const ghost = race.ghost;
      if (ghost) addJetContact(list, 'ghost', ghost.position, ghost.flight.state.orientation);
    } else if (this.school?.progress && this.school.gates.length) {
      addGateContacts(list, this.school.gates, this.school.progress.gateIndex, 4, false);
    } else if (this.practice) {
      addGateContacts(list, this.practice.gates, this.practice.progress.gateIndex, 4, false);
    }
    const df = this.dogfight;
    if (this.mpGame) {
      for (const [id, p] of this.remotes.puppets) {
        if (!p.jet.object.visible) continue;
        const enemy = df !== null && df.isOpponent(id);
        if (enemy && !df.isOpponentAlive(id)) continue;
        addJetContact(list, enemy ? 'enemy' : 'player', p.jet.object.position, p.jet.object.quaternion, this.net.players.get(id)?.name);
      }
    }
    if (df) {
      const w = df.weapons;
      addMissileContacts(list, w.missiles, w.selfId);
      addMissileContacts(list, w.remoteMissiles, w.selfId);
      for (const f of w.flares) list.add('flare', f.position.x, f.position.y, f.position.z);
      for (const g of df.pickups.gates) list.add('pickup', g.position.x, g.position.y, g.position.z).color = PICKUP_REWARDS[g.kind].color;
    }
    const s = this.jet.flight.state;
    this.radar.update({ self: selfFromPose(s.position, s.orientation, this.radarSelf), contacts: list.items, zone: df ? df.radarZone() : null });
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
      if (this.race?.state === 'finished' || this.dogfight?.finished) {
        if (this.mpGame) this.backToLobby();
        else this.showMenu();
      } else this.setPaused(this.mpGame ? !this.mpMenuOpen : !this.paused);
    }
    if (i.consumePressed('fullscreen')) void this.toggleFullscreen();
    if (!flying || this.paused || this.mpMenuOpen) return;
    if (i.consumePressed('radarZoom')) this.radar.cycleRange();
    if (!this.dogfight) {
      // Weapons only exist in Dogfight: drop stray presses so they can't fire later.
      i.consumePressed('fireMissile');
      i.consumePressed('releaseFlares');
    }
    const leverNotice = i.consumeThrottleLeverNotice();
    if (leverNotice) this.hud.showMessage(leverNotice, 3);
    if (i.consumePressed('respawn')) this.restart();
    if (i.consumePressed('toggleCamera')) {
      if (this.mpGame && this.forcedView) this.hud.showMessage(`The host locked the ${this.forcedView} view`, 1.5);
      else this.cameras.toggle(this.cameraTarget);
    }
    if (i.consumePressed('toggleHelp')) this.hud.setHelpVisible(!this.hud.helpVisible, i.gamepadConnected);
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

    const df = this.dogfight;
    if (this.phase === 'crashed') {
      // Dogfight: the match decides when to respawn (hooks.respawn); keep its clock and projectiles running.
      if (df) return df.fixedUpdate(dt, this.dogfightContext(false));
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawnAfterCrash();
      return;
    }
    if (race?.frozen) return;
    if (df?.frozen) return df.fixedUpdate(dt, this.dogfightContext(false));

    this.flightTime += dt;
    const jet = this.jet;
    this.weather.apply(jet.flight, this.collision.altitudeAboveGround(jet.position));
    // G-LOC: the pilot is out cold, the stick goes neutral and the throttle stays where it was.
    jet.fixedUpdate(dt, this.gforce.unconscious ? NO_FLIGHT_CONTROLS : this.input.getFlightControls());

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

    // Dogfight: weapons, zone and match (after the jet moved and collided).
    if (df) df.fixedUpdate(dt, this.dogfightContext(!this.gforce.unconscious));

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
    this.raceHud.showResults(
      {
        courseName: race.course.def.name,
        ...result,
        multiplayer: this.mpGame,
        onRestart: () => this.restart(),
        onMenu: () => (this.mpGame ? this.backToLobby() : this.showMenu()),
      },
      race.standings(this.jet.position, this.remoteStandings()),
    );
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
    // A controller press unlocks audio like a key/click would (where the browser allows it).
    if (this.input.gamepadActivity) this.audio.resume();
    this.handleActions();
    if (this.mode === 'menu' && this.menu.hangarVisible) {
      this.audio.update(null, frameDt);
      this.audio.updateFlybys(null, null);
      return;
    }
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
    for (const e of this.opponentExplosions) e.update(dt, (x, z) => this.heightField.getSurfaceHeight(x, z));
    this.rings.animate(this.time);
    this.remotes.setVisible(this.mpGame);
    if (this.mpGame) this.remotes.render(performance.now(), this.time, dt);
    const df = this.dogfight;
    if (df) {
      for (const id of this.opponents.keys()) {
        if (df.isOpponentAlive(id)) continue;
        const puppet = this.remotes.puppets.get(id);
        if (puppet) puppet.visible = false;
      }
    }
    this.terrain.update(camera.position);
    this.props.update(camera.position);
    updateWater(this.time);
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
    // The exterior includes a solid cockpit shell (and optional glTFs have no guaranteed interior).
    // The seat view renders its own cockpit instead; chase retains the complete external airframe.
    jet.object.visible = !crashed && this.cameras.mode !== 'cockpit';
    jet.parts.canopy.visible = true;

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
      const p = this.race?.player;
      this.net.sendState(
        { position: flight.state.position, quaternion: flight.state.orientation, velocity: flight.state.velocity, throttle: flight.state.throttle, afterburner: t.afterburner, gate: p?.gateIndex ?? 0, lap: p?.lap ?? 1 },
        performance.now(),
      );
    }
    this.netEventTimer += dt;

    // Dogfight effects / HUD, then the radar (it redraws at most ~30 times per second itself).
    this.dogfight?.frameUpdate(dt, { camera: this.cameras.camera, viewportHeight: this.renderer.domElement.clientHeight });
    this.updateRadar();

    // Gate navigator: every frame, from the active camera, so it follows passes, misses and respawns at once.
    // Free flight has no gates, so no navigator.
    const prog = this.race?.player ?? this.school?.progress ?? this.practice?.progress ?? null;
    const navGates = this.race ? this.race.course.gates : this.school?.progress ? this.school.gates : this.practice ? this.practice.gates : [];
    this.hud.nav.update(
      this.cameras.camera,
      prog && !prog.finished && !crashed
        ? { gates: navGates, gateIndex: prog.gateIndex, lap: prog.lap, laps: prog.laps, loop: this.race ? this.race.course.def.loop : false, position: flight.state.position }
        : null,
      dt,
    );

    // The HUD is DOM text: 20 updates per second is plenty and saves layout work every frame.
    this.hudTimer += dt;
    if (this.hudTimer < 0.05 && !this.paused) return;
    const hudDt = this.hudTimer;
    this.hudTimer = 0;
    const s = flight.state;
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
        ringsPassed: 0,
        ringsTotal: 0,
        nextRingDistance: null,
        flightTime: this.flightTime,
        cameraMode: this.cameras.mode,
        orientation: jet.object.quaternion,
        respawnIn: Math.max(0, this.respawnTimer),
        health: jet.damage.health,
        gearDown: jet.gearDown,
        airbrake: jet.airbrake,
        showRings: false,
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
      if (race.state === 'finished') this.raceHud.updateResultsStandings(standings);
    }
  }

  /** Slow cinematic flyover behind the main menu: down the canyon on Classic, an orbit of the air start elsewhere. */
  private updateMenuCamera(): void {
    const cam = this.cameras.camera;
    const surfaceAt = (x: number, z: number): number => this.heightField.getSurfaceHeight(x, z);
    const world = this.currentWorld;
    if (!world.classicValleyCenterX && this.menuOrbitY === null) this.menuOrbitY = menuOrbitHeight(world, surfaceAt);
    const p = menuCameraPose(world, this.time, surfaceAt, this.menuOrbitY ?? 0);
    cam.position.set(...p.position);
    cam.up.copy(UP);
    cam.lookAt(...p.target);
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
