import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module without type declarations
import { DEFAULT_LOBBY_SETTINGS as SERVER_DEFAULTS, sanitizeSettings } from '../server/relay.mjs';
import {
  DEFAULT_LOBBY_SETTINGS,
  cloneLobbySettings,
  isLobbySettings,
  lobbyForcedView,
  lobbyJetId,
  lobbyRaceCourse,
  lobbyWorldLabel,
  newLobbySettings,
  setLobbyClassic,
  setLobbySeed,
} from '../src/net/lobbyTypes';
import { seedFromText } from '../src/utils/seed';

describe('lobby settings (client)', () => {
  it('fills missing fields from older servers before remembering lobby settings', () => {
    const legacy = JSON.parse(JSON.stringify(DEFAULT_LOBBY_SETTINGS));
    delete legacy.raceDifficulty;
    delete legacy.raceLayout;
    delete legacy.world.worldKey;
    delete legacy.world.seedText;
    legacy.laps = 4;
    legacy.world.timeOfDay = 21;
    const restored = cloneLobbySettings(legacy);
    expect(restored).toEqual({ ...DEFAULT_LOBBY_SETTINGS, laps: 4, world: { ...DEFAULT_LOBBY_SETTINGS.world, timeOfDay: 21 } });
    restored.world.timeOfDay = 7;
    expect(legacy.world.timeOfDay).toBe(21);
  });

  it('keeps the client defaults in sync with the server', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_LOBBY_SETTINGS))).toEqual(JSON.parse(JSON.stringify(SERVER_DEFAULTS)));
  });

  it('still loads lobbies saved before the host view/jet rules, and resolves the forced jet and view', () => {
    const legacy = JSON.parse(JSON.stringify(DEFAULT_LOBBY_SETTINGS));
    delete legacy.forceView;
    delete legacy.forceJet;
    expect(isLobbySettings(legacy)).toBe(true);
    expect(cloneLobbySettings(legacy)).toMatchObject({ forceView: 'any', forceJet: '' });
    expect(isLobbySettings({ ...legacy, forceView: 'drone' })).toBe(false);

    expect(lobbyJetId({ forceJet: '' }, 'falcon')).toBe('falcon');
    expect(lobbyJetId({ forceJet: 'viper' }, 'falcon')).toBe('viper');
    expect(lobbyJetId({ forceJet: 'no-such-jet' }, 'falcon')).toBe('falcon');
    expect(lobbyForcedView({ forceView: 'any' })).toBeNull();
    expect(lobbyForcedView({ forceView: 'cockpit' })).toBe('cockpit');
  });

  it('starts new lobbies on a random seeded world that the server accepts', () => {
    const s = newLobbySettings('Pilot lobby', () => 0.5);
    expect(s.world).toMatchObject({ seedText: '2147483648', worldKey: 's2147483648' });
    expect(sanitizeSettings(s)).toEqual(s);
  });

  it('turns typed seed text into the shared world key, and back to Classic', () => {
    const w = { ...DEFAULT_LOBBY_SETTINGS.world };
    setLobbySeed(w, '  Grand <Canyon>  ');
    expect(w.seedText).toBe('Grand Canyon');
    expect(w.worldKey).toBe(`s${seedFromText('Grand Canyon')}`);
    expect(lobbyWorldLabel(w)).toBe('Seed Grand Canyon');
    setLobbyClassic(w);
    expect(w).toMatchObject({ seedText: '', worldKey: 'classic' });
    expect(lobbyWorldLabel(w)).toBe('Classic Canyon');
  });

  it('picks the classic course or a generated one', () => {
    const classic = { ...DEFAULT_LOBBY_SETTINGS, world: { ...DEFAULT_LOBBY_SETTINGS.world } };
    expect(lobbyRaceCourse(classic)).toEqual({ kind: 'classic', courseId: 'canyon-loop', laps: 2 });
    const seeded = { ...classic, raceDifficulty: 'hard' as const, raceLayout: 'sprint' as const, world: { ...classic.world, worldKey: 's9', seedText: '9' } };
    const gen = lobbyRaceCourse(seeded);
    expect(gen).toMatchObject({ kind: 'generated', laps: 1 });
    expect(gen.courseId).toMatch(/^gen:s9:sprint:hard:v\d+$/);
    expect(lobbyRaceCourse({ ...seeded, raceLayout: 'loop', laps: 3 }).laps).toBe(3);
  });
});
