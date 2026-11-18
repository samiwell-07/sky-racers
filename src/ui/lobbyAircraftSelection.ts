import type { Lobby } from '../net/lobbyTypes';

export interface LobbyAircraftContext {
  lobbyId: string | null;
  hostId: string | null;
  forceJet: string;
  hostSettings: string | null;
}

export function aircraftContext(lobby: Lobby | null, hostRule: boolean): LobbyAircraftContext {
  return {
    lobbyId: lobby?.id ?? null,
    hostId: lobby?.hostId ?? null,
    forceJet: lobby?.settings.forceJet ?? '',
    hostSettings: hostRule && lobby ? JSON.stringify(lobby.settings) : null,
  };
}

/** Network updates may keep the tour open, but must never authorize a stale selection. */
export function aircraftContextError(context: LobbyAircraftContext, lobby: Lobby | null): string | null {
  if ((lobby?.id ?? null) !== context.lobbyId) return 'The lobby changed while choosing an aircraft.';
  if (!lobby) return null;
  if (lobby.hostId !== context.hostId) return 'The lobby host changed. Please choose again.';
  if ((lobby.settings.forceJet ?? '') !== context.forceJet) return 'The host changed the aircraft rule. Please choose again.';
  if (context.hostSettings !== null && JSON.stringify(lobby.settings) !== context.hostSettings) {
    return 'Lobby settings changed while choosing an aircraft. Please reopen the settings.';
  }
  return null;
}
