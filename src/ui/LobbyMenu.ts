import { JET_CATALOG, getJetDefinition } from '../entities/jet/jetCatalog';
import type { NetClient } from '../net/NetClient';
import {
  DEFAULT_LOBBY_SETTINGS,
  cloneLobbySettings,
  type Lobby,
  type LobbyMode,
  type LobbySettings,
  type LobbySummary,
} from '../net/lobbyTypes';
import { BUILTIN_COURSES } from '../race/Course';
import type { SettingsStore } from '../settings/Settings';
import { button, checkbox, h, select, slider, textInput } from './dom';
import type { MainMenu } from './MainMenu';

type Screen = 'connecting' | 'connect' | 'browser' | 'create' | 'room' | 'edit' | null;

const courseName = (id: string): string => BUILTIN_COURSES.find((c) => c.id === id)?.name ?? id;
const modeName = (mode: string): string => (mode === 'race' ? 'Race' : 'Free flight');
const clock = (h24: number): string => `${Math.floor(h24)}:${String(Math.round((h24 % 1) * 60)).padStart(2, '0')}`;

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
      if (lobby && (this.screen === 'browser' || this.screen === 'create' || this.screen === 'connecting')) this.showRoom();
      else if (!lobby && (this.screen === 'room' || this.screen === 'edit')) this.showBrowser();
      else if (lobby && this.screen === 'room') this.showRoom();
    });
    net.errors.on((message) => {
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

  async open(): Promise<void> {
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
        h('div', { class: 'menu-row' }, button('Try again', () => void this.open(), 'primary'), button('Back', () => this.leaveToMain())),
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
        h('td', {}, modeName(l.mode), h('div', { class: 'lobby-dim' }, l.mode === 'race' ? `${courseName(l.courseId)} · ${l.laps} lap${l.laps > 1 ? 's' : ''}` : '')),
        h('td', {}, `${l.players}/${l.maxPlayers}`),
        h('td', {}, l.state === 'playing' ? (l.mode === 'race' ? 'Racing' : 'Flying') : 'Waiting'),
        h('td', {}, l.joinable ? button('Join', () => this.net.joinLobby(l.id), 'small primary') : h('span', { class: 'lobby-dim' }, l.players >= l.maxPlayers ? 'Full' : 'Playing')),
      ),
    );
    this.listBox.replaceChildren(
      rows.length
        ? h('table', { class: 'menu-table' }, h('tr', {}, ...['Lobby', 'Mode', 'Players', 'Status', ''].map((t) => h('th', {}, t))), ...rows)
        : h('p', { class: 'menu-sub' }, 'No public lobbies right now. Create one!'),
    );
  }

  /** Name + jet, shared by the browser and the room. */
  private profileFields(): HTMLElement {
    const s = this.settings.values;
    const push = (): void => this.net.setProfile(s.playerName, s.jetId);
    return h(
      'div',
      { class: 'menu-col' },
      textInput('Pilot name', () => s.playerName, (v) => {
        this.settings.set('playerName', v.trim().slice(0, 20) || 'Pilot');
        push();
      }),
      select('Jet', JET_CATALOG.map((j) => [j.id, j.name] as [string, string]), () => s.jetId, (v) => {
        this.settings.set('jetId', v);
        push();
      }),
    );
  }

  private showSettingsForm(kind: 'create' | 'edit'): void {
    this.setScreen(kind);
    const lobby = this.net.lobby;
    const draft: LobbySettings =
      kind === 'edit' && lobby
        ? cloneLobbySettings(lobby.settings)
        : { ...cloneLobbySettings(DEFAULT_LOBBY_SETTINGS), name: `${this.settings.values.playerName}'s lobby` };
    const worldBox = h('div', { class: 'menu-col' });
    const drawWorld = (): void => {
      const w = draft.world;
      worldBox.replaceChildren(
        slider('Time of day', 0, 24, 0.25, () => w.timeOfDay, (v) => (w.timeOfDay = v), clock),
        slider('Clouds', 0, 1, 0.05, () => w.cloudCoverage, (v) => (w.cloudCoverage = v), (v) => `${Math.round(v * 100)}%`),
        slider('Wind speed', 0, 25, 1, () => w.windSpeed, (v) => (w.windSpeed = v), (v) => `${v} m/s`),
        slider('Wind direction', 0, 359, 1, () => w.windDirection, (v) => (w.windDirection = v), (v) => `${v}°`),
        slider('Turbulence', 0, 1, 0.05, () => w.turbulence, (v) => (w.turbulence = v), (v) => `${Math.round(v * 100)}%`),
      );
    };
    drawWorld();
    const raceBox = h('div', { class: 'menu-col' });
    const drawRace = (): void => {
      raceBox.replaceChildren(
        ...(draft.mode === 'race'
          ? [
              select('Course', BUILTIN_COURSES.map((c) => [c.id, c.name] as [string, string]), () => draft.courseId, (v) => {
                draft.courseId = v;
                drawRace();
              }),
              BUILTIN_COURSES.find((c) => c.id === draft.courseId)?.loop
                ? slider('Laps', 1, 5, 1, () => draft.laps, (v) => (draft.laps = v))
                : h('p', { class: 'lobby-dim' }, 'Point-to-point sprint (1 lap).'),
            ]
          : [h('p', { class: 'lobby-dim' }, 'Everyone takes off from the runway and flies freely together, with the practice gates.')]),
      );
    };
    drawRace();

    const submit = (): void => {
      if (kind === 'create') this.net.createLobby(draft);
      else {
        this.net.updateLobby(draft);
        this.showRoom();
      }
    };

    this.menu.show(
      h(
        'div',
        { class: 'menu-panel lobby-panel' },
        h('h2', {}, kind === 'create' ? 'Create lobby' : 'Lobby settings'),
        h('h3', {}, 'Lobby'),
        textInput('Lobby name', () => draft.name, (v) => (draft.name = v.slice(0, 32) || draft.name)),
        checkbox('Private (join with code only)', () => draft.private, (v) => (draft.private = v)),
        slider('Max players', Math.max(2, lobby?.players.length ?? 2), 8, 1, () => draft.maxPlayers, (v) => (draft.maxPlayers = v)),
        checkbox('Allow joining during a game', () => draft.allowLateJoin, (v) => (draft.allowLateJoin = v)),
        h('h3', {}, 'Mode'),
        select<LobbyMode>('Mode', [['race', 'Race'], ['free', 'Free flight']], () => draft.mode, (v) => {
          draft.mode = v;
          drawRace();
        }),
        raceBox,
        h('h3', {}, 'World (same for everyone in the lobby)'),
        worldBox,
        button('Reset world to default', () => {
          draft.world = { ...DEFAULT_LOBBY_SETTINGS.world };
          drawWorld();
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
        ? h('p', { class: 'lobby-status' }, self?.inGame ? 'Game in progress…' : `${s.mode === 'race' ? 'A race' : 'A session'} is in progress. You will join the next one.`)
        : null;

    const actions: Array<HTMLElement | null> = [];
    if (isHost) {
      actions.push(
        button(notReady.length ? `Waiting for ${notReady.length} player${notReady.length > 1 ? 's' : ''}…` : s.mode === 'race' ? 'Start race' : 'Start flying', () => this.net.startGame(), notReady.length ? '' : 'primary'),
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
          `${modeName(s.mode)}${s.mode === 'race' ? ` · ${courseName(s.courseId)} · ${s.laps} lap${s.laps > 1 ? 's' : ''}` : ''} · ${lobby.players.length}/${s.maxPlayers} players · ${s.private ? 'Private' : 'Public'}`,
        ),
        h(
          'div',
          { class: 'lobby-code' },
          'Invite code: ',
          h('b', {}, lobby.code),
          ' ',
          button('Copy', () => void navigator.clipboard?.writeText(lobby.code), 'small'),
        ),
        h('p', { class: 'lobby-dim' }, `World: ${clock(s.world.timeOfDay)} · clouds ${Math.round(s.world.cloudCoverage * 100)}% · wind ${s.world.windSpeed} m/s · turbulence ${Math.round(s.world.turbulence * 100)}%`),
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
