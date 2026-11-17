import { JET_CATALOG, getJetDefinition } from '../entities/jet/jetCatalog';
import type { NetClient } from '../net/NetClient';
import {
  DEFAULT_LOBBY_SETTINGS,
  DOGFIGHT_MAX_PLAYERS,
  DOGFIGHT_MIN_PLAYERS,
  cloneLobbySettings,
  lobbyForcedView,
  lobbyJetId,
  lobbyWorldLabel,
  lobbyWorldSpec,
  newLobbySettings,
  setLobbyClassic,
  setLobbySeed,
  type Lobby,
  type LobbyMode,
  type LobbySettings,
  type LobbySummary,
  type LobbyView,
} from '../net/lobbyTypes';
import { BUILTIN_COURSES } from '../race/Course';
import type { RaceDifficulty, RaceLayout } from '../race/generatedCourse';
import type { SettingsStore } from '../settings/Settings';
import { button, checkbox, h, select, slider, textInput } from './dom';
import type { MainMenu } from './MainMenu';
import { dogfightZoneRadius } from '../modes/dogfight/zone';

type Screen = 'connecting' | 'connect' | 'browser' | 'create' | 'room' | 'edit' | null;

const courseName = (id: string): string => BUILTIN_COURSES.find((c) => c.id === id)?.name ?? id;
const MODE_NAMES: Record<LobbyMode, string> = { race: 'Race', free: 'Free flight', dogfight: 'Dogfight' };
const modeName = (mode: string): string => MODE_NAMES[mode as LobbyMode] ?? mode;
/** Combat zone diameter (km) for a dogfight of `players` pilots: 6 km for a duel, +2 km per extra pilot. */
const zoneKm = (players: number): number => Math.round((dogfightZoneRadius(players) * 2) / 1000);
const dogfightText = (players: number): string => (players <= 2 ? `Duel · ${zoneKm(2)} km zone` : `${players}-way free-for-all · ${zoneKm(players)} km zone`);
const DIFFICULTY_NAMES: Record<RaceDifficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const LAYOUT_NAMES: Record<RaceLayout, string> = { sprint: 'Sprint', loop: 'Loop' };
const lapsText = (laps: number): string => `${laps} lap${laps > 1 ? 's' : ''}`;
const clock = (h24: number): string => `${Math.floor(h24)}:${String(Math.round((h24 % 1) * 60)).padStart(2, '0')}`;
const VIEW_OPTIONS: Array<[LobbyView, string]> = [['any', "Pilot's choice (C to switch)"], ['chase', 'Chase view only'], ['cockpit', 'Cockpit view only']];
/** "Chase view · Falcon for everyone", or '' when pilots choose both. */
function rulesText(s: Pick<LobbySettings, 'forceView' | 'forceJet'>): string {
  const view = lobbyForcedView(s);
  const jet = s.forceJet ? lobbyJetId(s, '') : '';
  return [view ? `${view === 'chase' ? 'Chase' : 'Cockpit'} view only` : '', jet ? `${getJetDefinition(jet).name} for everyone` : ''].filter(Boolean).join(' · ');
}

type RaceInfo = Pick<LobbySettings, 'courseId' | 'laps' | 'raceDifficulty' | 'raceLayout'> & { worldKey: string };

/** "Canyon Loop · 2 laps" (Classic) or "Hard loop · 3 laps" / "Easy sprint" (generated). */
function raceText(r: RaceInfo): string {
  if (lobbyWorldSpec(r).kind === 'classic') {
    const loop = BUILTIN_COURSES.find((c) => c.id === r.courseId)?.loop ?? true;
    return `${courseName(r.courseId)}${loop ? ` · ${lapsText(r.laps)}` : ''}`;
  }
  const kind = `${DIFFICULTY_NAMES[r.raceDifficulty] ?? r.raceDifficulty} ${(LAYOUT_NAMES[r.raceLayout] ?? r.raceLayout).toLowerCase()}`;
  return r.raceLayout === 'loop' ? `${kind} · ${lapsText(r.laps)}` : kind;
}

const summaryWorld = (l: LobbySummary): string => lobbyWorldLabel({ worldKey: l.worldKey ?? 'classic', seedText: l.seedText ?? '' });

export interface LobbyMenuHost {
  connect(): Promise<string | null>;
  backToMain(): void;
}

/**
 * Multiplayer screens: connecting, lobby browser (public lobbies + join by code), create / edit
 * lobby settings, and the lobby room (players, ready, invite code, chat, host start).
 */
export class LobbyMenu {
  private screen: Screen = null;
  private lobbies: LobbySummary[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly chatLog = h('div', { class: 'lobby-chat-log' });
  /** Kept across re-renders so a half-typed message survives lobby updates. */
  private readonly chatInput = h('input', { type: 'text', placeholder: 'Say something…', maxLength: 200, class: 'lobby-chat-input' });
  private error = '';
  /** Mode preselected for lobbies created from this visit (e.g. the main menu's Dogfight entry). */
  private preferredMode: LobbyMode | null = null;
  private savingLobbySettings = false;

  constructor(
    private readonly menu: MainMenu,
    private readonly net: NetClient,
    private readonly settings: SettingsStore,
    private readonly host: LobbyMenuHost,
  ) {
    net.lobbyList.on((list) => {
      const changed = JSON.stringify(list) !== JSON.stringify(this.lobbies);
      this.lobbies = list;
      if (changed && this.screen === 'browser') this.renderLobbyList();
    });
    net.lobbyChanged.on((lobby) => {
      const saved = this.savingLobbySettings && lobby !== null && lobby.hostId === this.net.id;
      if (saved) {
        this.savingLobbySettings = false;
        this.settings.set('lobbySettings', cloneLobbySettings(lobby.settings));
        if (this.settings.lastSaveError) this.error = `Lobby updated, but settings could not be remembered: ${this.settings.lastSaveError}.`;
      } else if (!lobby) this.savingLobbySettings = false;
      if (lobby && (this.screen === 'browser' || this.screen === 'create' || this.screen === 'connecting' || (this.screen === 'edit' && saved))) this.showRoom();
      else if (!lobby && (this.screen === 'room' || this.screen === 'edit')) this.showBrowser();
      else if (lobby && this.screen === 'room') this.showRoom();
    });
    net.errors.on((message) => {
      this.savingLobbySettings = false;
      this.error = message;
      if (this.screen === 'browser') this.showBrowser();
      else if (this.screen === 'room') this.showRoom();
      else if (this.screen === 'create' || this.screen === 'edit') this.flashError();
    });
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.chatInput.value.trim()) {
        this.net.sendChat(this.chatInput.value);
        this.chatInput.value = '';
      }
    });
    net.chat.on((name, text) => {
      this.chatLog.append(h('div', {}, h('b', {}, `${name}: `), text));
      this.chatLog.scrollTop = this.chatLog.scrollHeight;
    });
  }

  get active(): boolean {
    return this.screen !== null;
  }

  /** Called when the menu overlay is taken over by something else (game start). */
  deactivate(): void {
    this.screen = null;
    this.stopRefresh();
  }

  async open(mode: LobbyMode | null = null): Promise<void> {
    this.preferredMode = mode;
    if (this.net.connected) {
      if (this.net.lobby) this.showRoom();
      else this.showBrowser();
      return;
    }
    this.showConnecting();
    const err = await this.host.connect();
    if (err) this.showConnect(err);
    else this.showBrowser();
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private setScreen(screen: Screen): void {
    this.screen = screen;
    if (screen !== 'browser') this.stopRefresh();
  }

  private flashError(): void {
    const el = document.querySelector('.menu-root .menu-error');
    if (el) el.textContent = this.error;
  }

  private takeError(): HTMLElement {
    const el = h('p', { class: 'menu-error' }, this.error);
    this.error = '';
    return el;
  }

  // ------------------------------------------------------------- screens

  private showConnecting(): void {
    this.setScreen('connecting');
    this.menu.show(h('div', { class: 'menu-panel' }, h('h2', {}, 'Multiplayer'), h('p', {}, 'Connecting to the multiplayer server…')));
  }

  private showConnect(error: string): void {
    this.setScreen('connect');
    const s = this.settings.values;
    this.menu.show(
      h(
        'div',
        { class: 'menu-panel' },
        h('h2', {}, 'Multiplayer'),
        h('p', { class: 'menu-error' }, error),
        h(
          'p',
          { class: 'menu-sub' },
          'The multiplayer server starts with "npm run dev" on the host PC. Friends on the same network open the game at http://<host-ip>:5173 and connect to ws://<host-ip>:8787.',
        ),
        textInput('Server address', () => s.serverUrl, (v) => this.settings.set('serverUrl', v.trim())),
        h('div', { class: 'menu-row' }, button('Try again', () => void this.open(this.preferredMode), 'primary'), button('Back', () => this.leaveToMain())),
      ),
    );
  }

  showBrowser(): void {
    this.setScreen('browser');
    if (!this.refreshTimer) {
      this.net.listLobbies();
      this.refreshTimer = setInterval(() => this.net.listLobbies(), 3000);
    }
    const s = this.settings.values;
    const code = h('input', { type: 'text', placeholder: 'CODE', maxLength: 5, class: 'lobby-code-input' });
    const joinCode = (): void => {
      if (code.value.trim()) this.net.joinByCode(code.value);
    };
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinCode();
    });
    this.renderLobbyList();

    this.menu.show(
      h(
        'div',
        { class: 'menu-panel lobby-panel' },
        h('h2', {}, 'Multiplayer lobbies'),
        this.profileFields(),
        this.takeError(),
        this.listBox,
        h(
          'div',
          { class: 'menu-row' },
          button('Create lobby', () => this.showSettingsForm('create'), 'primary'),
          h('span', { class: 'lobby-join-code' }, 'Private lobby code: ', code, button('Join', joinCode, 'small')),
        ),
        h('div', { class: 'menu-row' }, button('Back', () => this.leaveToMain())),
        h('p', { class: 'lobby-dim' }, `Server: ${s.serverUrl}`),
      ),
    );
  }

  /** Only the lobby table refreshes, so typing in the page isn't interrupted. */
  private readonly listBox = h('div', {});

  private renderLobbyList(): void {
    const rows = this.lobbies.map((l) =>
      h(
        'tr',
        {},
        h('td', {}, h('b', {}, l.name), h('div', { class: 'lobby-dim' }, `host: ${l.hostName}`)),
        h('td', {}, modeName(l.mode), h('div', { class: 'lobby-dim' }, l.mode === 'race' ? raceText({ ...l, worldKey: l.worldKey ?? 'classic' }) : '')),
        h('td', {}, summaryWorld(l)),
        h('td', {}, `${l.players}/${l.maxPlayers}`),
        h('td', {}, l.state === 'playing' ? (l.mode === 'race' ? 'Racing' : l.mode === 'dogfight' ? 'Fighting' : 'Flying') : 'Waiting'),
        h('td', {}, l.joinable ? button('Join', () => this.net.joinLobby(l.id), 'small primary') : h('span', { class: 'lobby-dim' }, l.players >= l.maxPlayers ? 'Full' : 'Playing')),
      ),
    );
    this.listBox.replaceChildren(
      rows.length
        ? h('table', { class: 'menu-table' }, h('tr', {}, ...['Lobby', 'Mode', 'World', 'Players', 'Status', ''].map((t) => h('th', {}, t))), ...rows)
        : h('p', { class: 'menu-sub' }, 'No public lobbies right now. Create one!'),
    );
  }

  /** Name + jet, shared by the browser and the room. */
  private profileFields(): HTMLElement {
    const s = this.settings.values;
    const push = (): void => this.net.setProfile(s.playerName, s.jetId);
    const lobbySettings = this.net.lobby?.settings;
    const forcedJet = lobbySettings?.forceJet ? lobbyJetId(lobbySettings, '') : '';
    return h(
      'div',
      { class: 'menu-col' },
      textInput('Pilot name', () => s.playerName, (v) => {
        this.settings.set('playerName', v.trim().slice(0, 20) || 'Pilot');
        push();
      }),
      forcedJet
        ? h('p', { class: 'lobby-dim' }, `Jet: ${getJetDefinition(forcedJet).name} (chosen by the host for everyone)`)
        : select('Jet', JET_CATALOG.map((j) => [j.id, j.name] as [string, string]), () => s.jetId, (v) => {
            this.settings.set('jetId', v);
            push();
          }),
    );
  }

  private showSettingsForm(kind: 'create' | 'edit'): void {
    this.setScreen(kind);
    const lobby = this.net.lobby;
    const savedSettings = this.settings.values.lobbySettings;
    const draft: LobbySettings =
      kind === 'edit' && lobby
        ? cloneLobbySettings(lobby.settings)
        : savedSettings ? cloneLobbySettings(savedSettings) : newLobbySettings(`${this.settings.values.playerName}'s lobby`);
    if (kind === 'create' && this.preferredMode && draft.mode !== this.preferredMode) {
      draft.mode = this.preferredMode;
      if (draft.mode === 'dogfight') draft.maxPlayers = DOGFIGHT_MAX_PLAYERS;
    }
    const minPlayers = Math.max(2, lobby?.players.length ?? 2);
    const dogfightMin = Math.min(DOGFIGHT_MAX_PLAYERS, Math.max(DOGFIGHT_MIN_PLAYERS, minPlayers));
    let groupMaxPlayers = draft.mode === 'dogfight' ? Math.max(minPlayers, DEFAULT_LOBBY_SETTINGS.maxPlayers) : draft.maxPlayers;

    const weatherBox = h('div', { class: 'menu-col' });
    const drawWeather = (): void => {
      const w = draft.world;
      weatherBox.replaceChildren(
        slider('Time of day', 0, 24, 0.25, () => w.timeOfDay, (v) => (w.timeOfDay = v), clock),
        slider('Clouds', 0, 1, 0.05, () => w.cloudCoverage, (v) => (w.cloudCoverage = v), (v) => `${Math.round(v * 100)}%`),
        slider('Wind speed', 0, 25, 1, () => w.windSpeed, (v) => (w.windSpeed = v), (v) => `${v} m/s`),
        slider('Wind direction', 0, 359, 1, () => w.windDirection, (v) => (w.windDirection = v), (v) => `${v}°`),
        slider('Turbulence', 0, 1, 0.05, () => w.turbulence, (v) => (w.turbulence = v), (v) => `${Math.round(v * 100)}%`),
      );
    };
    drawWeather();

    const isClassic = (): boolean => lobbyWorldSpec(draft.world).kind === 'classic';
    const seedBox = h('div', { class: 'menu-col' });
    const drawSeed = (): void => {
      if (isClassic()) {
        seedBox.replaceChildren(h('p', { class: 'lobby-dim' }, 'The original hand-made canyon with its built-in courses.'));
        return;
      }
      const field = textInput('World seed', () => draft.world.seedText, (v) => {
        setLobbySeed(draft.world, v);
        input.value = draft.world.seedText;
      });
      const input = field.querySelector('input')!;
      input.maxLength = 32;
      seedBox.replaceChildren(
        h(
          'div',
          { class: 'menu-row' },
          field,
          button('Random', () => {
            setLobbySeed(draft.world, '');
            input.value = draft.world.seedText;
          }, 'small'),
        ),
        h('p', { class: 'lobby-dim' }, 'Any text or number. The same seed always builds the same world: share it with friends.'),
      );
    };

    const playersBox = h('div', { class: 'menu-col' });
    const drawPlayers = (): void => {
      playersBox.replaceChildren(
        draft.mode === 'dogfight'
          ? slider('Max pilots', dogfightMin, DOGFIGHT_MAX_PLAYERS, 1, () => draft.maxPlayers, (v) => (draft.maxPlayers = v))
          : slider('Max players', minPlayers, 8, 1, () => draft.maxPlayers, (v) => (draft.maxPlayers = groupMaxPlayers = v)),
      );
    };

    const raceBox = h('div', { class: 'menu-col' });
    const drawRace = (): void => {
      let content: HTMLElement[];
      if (draft.mode === 'free') {
        content = [h('p', { class: 'lobby-dim' }, 'Everyone takes off from the runway and flies freely together, with the practice gates.')];
      } else if (draft.mode === 'dogfight') {
        content = [
          h(
            'p',
            { class: 'lobby-dim' },
            `Free-for-all for ${DOGFIGHT_MIN_PLAYERS}–${DOGFIGHT_MAX_PLAYERS} pilots: guns, missiles and flares. First to 3 kills wins. ` +
              `The combat zone is ${zoneKm(2)} km across for a duel and grows 2 km per extra pilot (${zoneKm(3)} km for 3, ${zoneKm(4)} km for 4); stay inside it.`,
          ),
          h('p', { class: 'lobby-dim' }, 'Space gun · Q missile (hold to wait for the lock) · E flares · Z radar zoom'),
        ];
      } else if (isClassic()) {
        content = [
          select('Course', BUILTIN_COURSES.map((c) => [c.id, c.name] as [string, string]), () => draft.courseId, (v) => {
            draft.courseId = v;
            drawRace();
          }),
          BUILTIN_COURSES.find((c) => c.id === draft.courseId)?.loop
            ? slider('Laps', 1, 5, 1, () => draft.laps, (v) => (draft.laps = v))
            : h('p', { class: 'lobby-dim' }, 'Point-to-point sprint (1 lap).'),
        ];
      } else {
        content = [
          select<RaceDifficulty>('Difficulty', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], () => draft.raceDifficulty, (v) => (draft.raceDifficulty = v)),
          select<RaceLayout>('Layout', [['sprint', 'Sprint (point to point)'], ['loop', 'Loop (laps)']], () => draft.raceLayout, (v) => {
            draft.raceLayout = v;
            drawRace();
          }),
          draft.raceLayout === 'loop'
            ? slider('Laps', 1, 5, 1, () => draft.laps, (v) => (draft.laps = v))
            : h('p', { class: 'lobby-dim' }, 'A course generated on this world (1 lap).'),
        ];
      }
      raceBox.replaceChildren(...content);
    };

    drawSeed();
    drawPlayers();
    drawRace();

    const submit = (): void => {
      if (this.savingLobbySettings) return;
      this.savingLobbySettings = true;
      if (kind === 'create') this.net.createLobby(draft);
      else this.net.updateLobby(draft);
    };

    this.menu.show(
      h(
        'div',
        { class: 'menu-panel lobby-panel' },
        h('h2', {}, kind === 'create' ? 'Create lobby' : 'Lobby settings'),
        h('h3', {}, 'Lobby'),
        textInput('Lobby name', () => draft.name, (v) => (draft.name = v.slice(0, 32) || draft.name)),
        checkbox('Private (join with code only)', () => draft.private, (v) => (draft.private = v)),
        playersBox,
        checkbox('Allow joining during a game', () => draft.allowLateJoin, (v) => (draft.allowLateJoin = v)),
        h('h3', {}, 'Rules (same for everyone)'),
        select<LobbyView>('Camera view', VIEW_OPTIONS, () => draft.forceView, (v) => (draft.forceView = v)),
        select('Plane', [['', "Pilot's choice"], ...JET_CATALOG.map((j) => [j.id, `${j.name} for everyone`] as [string, string])], () => draft.forceJet, (v) => (draft.forceJet = v)),
        h('h3', {}, 'World (same for everyone in the lobby)'),
        select<'seeded' | 'classic'>('World', [['seeded', 'Seeded world'], ['classic', 'Classic Canyon']], () => (isClassic() ? 'classic' : 'seeded'), (v) => {
          if (v === 'classic') setLobbyClassic(draft.world);
          else setLobbySeed(draft.world, '');
          drawSeed();
          drawRace();
        }),
        seedBox,
        h('h3', {}, 'Mode'),
        select<LobbyMode>('Mode', [['race', 'Race'], ['free', 'Free flight'], ['dogfight', `Dogfight (${DOGFIGHT_MIN_PLAYERS}–${DOGFIGHT_MAX_PLAYERS} pilots)`]], () => draft.mode, (v) => {
          draft.mode = v;
          draft.maxPlayers = v === 'dogfight' ? DOGFIGHT_MAX_PLAYERS : Math.max(minPlayers, groupMaxPlayers);
          drawPlayers();
          drawRace();
        }),
        raceBox,
        h('h3', {}, 'Weather'),
        weatherBox,
        button('Reset weather to default', () => {
          const { seedText, worldKey } = draft.world;
          draft.world = { ...DEFAULT_LOBBY_SETTINGS.world, seedText, worldKey };
          drawWeather();
        }, 'small'),
        h('p', { class: 'menu-error' }),
        h(
          'div',
          { class: 'menu-row' },
          button(kind === 'create' ? 'Create' : 'Save', submit, 'primary'),
          button('Cancel', () => (kind === 'create' ? this.showBrowser() : this.showRoom())),
        ),
      ),
    );
  }

  showRoom(): void {
    const lobby = this.net.lobby;
    if (!lobby) return this.showBrowser();
    this.setScreen('room');
    const me = this.net.id;
    const isHost = lobby.hostId === me;
    const self = lobby.players.find((p) => p.id === me);
    const s = lobby.settings;
    const others = lobby.players.filter((p) => p.id !== lobby.hostId);
    const notReady = others.filter((p) => !p.ready);

    const playerRows = lobby.players.map((p) =>
      h(
        'tr',
        {},
        h('td', {}, p.id === lobby.hostId ? '★ ' : '', h('b', {}, p.name), p.id === me ? ' (you)' : ''),
        h('td', {}, getJetDefinition(p.jetId).name),
        h('td', { class: p.ready || p.id === lobby.hostId ? 'lobby-ready' : 'lobby-dim' }, p.id === lobby.hostId ? 'Host' : p.inGame ? 'In game' : p.ready ? 'Ready' : 'Not ready'),
        h('td', {}, isHost && p.id !== me ? button('Kick', () => this.net.kick(p.id), 'small') : ''),
      ),
    );


    const status =
      lobby.state === 'playing'
        ? h('p', { class: 'lobby-status' }, self?.inGame ? 'Game in progress…' : `${s.mode === 'race' ? 'A race' : s.mode === 'dogfight' ? 'A dogfight' : 'A session'} is in progress. You will join the next one.`)
        : null;

    const needsOpponent = s.mode === 'dogfight' && lobby.players.length < DOGFIGHT_MIN_PLAYERS;
    const startLabel = s.mode === 'race' ? 'Start race' : s.mode === 'dogfight' ? 'Start dogfight' : 'Start flying';
    const actions: Array<HTMLElement | null> = [];
    if (isHost) {
      actions.push(
        button(
          notReady.length ? `Waiting for ${notReady.length} player${notReady.length > 1 ? 's' : ''}…` : needsOpponent ? 'Waiting for an opponent…' : startLabel,
          () => this.net.startGame(),
          notReady.length || needsOpponent ? '' : 'primary',
        ),
        button('Lobby settings', () => this.showSettingsForm('edit')),
      );
    } else {
      actions.push(button(self?.ready ? 'Not ready' : 'Ready!', () => this.net.setReady(!self?.ready), self?.ready ? '' : 'primary'));
    }
    actions.push(button('Leave lobby', () => this.net.leaveLobby()));

    this.menu.show(
      h(
        'div',
        { class: 'menu-panel lobby-panel' },
        h('h2', {}, s.name),
        h(
          'p',
          { class: 'menu-sub' },
          `${modeName(s.mode)}${s.mode === 'race' ? ` · ${raceText({ ...s, worldKey: s.world.worldKey ?? 'classic' })}` : s.mode === 'dogfight' ? ` · ${dogfightText(lobby.players.length)}` : ''} · ${lobby.players.length}/${s.maxPlayers} players · ${s.private ? 'Private' : 'Public'}`,
        ),
        h(
          'div',
          { class: 'lobby-code' },
          'Invite code: ',
          h('b', {}, lobby.code),
          ' ',
          button('Copy', () => void navigator.clipboard?.writeText(lobby.code), 'small'),
        ),
        h(
          'div',
          { class: 'lobby-code' },
          'World: ',
          h('b', {}, lobbyWorldLabel({ worldKey: s.world.worldKey ?? 'classic', seedText: s.world.seedText ?? '' })),
          ' ',
          lobbyWorldSpec({ worldKey: s.world.worldKey ?? 'classic' }).kind === 'seeded'
            ? button('Copy seed', () => void navigator.clipboard?.writeText(s.world.seedText), 'small')
            : null,
        ),
        h('p', { class: 'lobby-dim' }, `Weather: ${clock(s.world.timeOfDay)} · clouds ${Math.round(s.world.cloudCoverage * 100)}% · wind ${s.world.windSpeed} m/s · turbulence ${Math.round(s.world.turbulence * 100)}%`),
        rulesText(s) ? h('p', { class: 'lobby-dim' }, `Host rules: ${rulesText(s)}`) : null,
        status,
        this.takeError(),
        h('table', { class: 'menu-table' }, h('tr', {}, ...['Pilot', 'Jet', 'Status', ''].map((t) => h('th', {}, t))), ...playerRows),
        h('div', { class: 'menu-row' }, ...actions),
        h('h3', {}, 'Your pilot'),
        this.profileFields(),
        h('h3', {}, 'Chat'),
        this.chatLog,
        this.chatInput,
      ),
    );
  }

  private leaveToMain(): void {
    this.setScreen(null);
    if (this.net.lobby) this.net.leaveLobby();
    this.host.backToMain();
  }
}

export type { Lobby };
