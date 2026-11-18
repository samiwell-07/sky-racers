import { describe, expect, it } from 'vitest';
import { cloneLobbySettings, DEFAULT_LOBBY_SETTINGS, type Lobby } from '../src/net/lobbyTypes';
import { aircraftContext, aircraftContextError } from '../src/ui/lobbyAircraftSelection';

const lobby = (): Lobby => ({
  id: 'room', code: 'ABCDE', hostId: 'host', state: 'lobby', startedAt: 0,
  settings: cloneLobbySettings(DEFAULT_LOBBY_SETTINGS),
  players: [],
});

describe('lobby aircraft selection validity', () => {
  it('keeps a personal tour valid through player, ready and unrelated settings updates', () => {
    const room = lobby();
    const context = aircraftContext(room, false);
    room.players.push({ id: 'pilot', name: 'Pilot', jetId: 'viper', ready: true, inGame: false, team: 'alpha' });
    room.settings.name = 'Renamed';
    expect(aircraftContextError(context, room)).toBeNull();
    expect(aircraftContextError(aircraftContext(null, false), null)).toBeNull();
  });

  it('invalidates stale personal choices after forced-aircraft, host or lobby changes', () => {
    const room = lobby();
    const context = aircraftContext(room, false);
    room.settings.forceJet = 'raptor';
    expect(aircraftContextError(context, room)).toMatch(/aircraft rule/);
    room.settings.forceJet = '';
    room.hostId = 'other';
    expect(aircraftContextError(context, room)).toMatch(/host changed/);
    expect(aircraftContextError(context, null)).toMatch(/lobby changed/);
    expect(aircraftContextError(aircraftContext(null, false), room)).toMatch(/lobby changed/);
  });

  it('rejects stale host drafts but not player-only updates', () => {
    const room = lobby();
    const context = aircraftContext(room, true);
    room.players = [];
    expect(aircraftContextError(context, room)).toBeNull();
    room.settings.world.windSpeed++;
    expect(aircraftContextError(context, room)).toMatch(/settings changed/);
    expect(room.settings.forceJet).toBe('');
  });
});
