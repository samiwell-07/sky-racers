import type { Vector3 } from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import type { CombatEvent } from './WeaponSystem';

/** Gain for a sound `distance` m away (full within 150 m, ~silent beyond 3 km). */
export function combatSoundGain(distance: number): number {
  return Math.min(1, 150 / Math.max(150, distance)) ** 0.8 * (distance > 3000 ? 0 : 1);
}

type CombatAudio = Pick<AudioEngine, 'playGunBurst' | 'playMissileLaunch' | 'playFlarePop' | 'playHitMarker' | 'playExplosion' | 'playDamage'>;

/** Plays the sounds for a frame's combat events, attenuated by distance from `listener`. */
export function playCombatEvents(audio: CombatAudio, events: readonly CombatEvent[], listener: Vector3): void {
  let remoteRounds = 0;
  let remoteGain = 0;
  for (const e of events) {
    switch (e.type) {
      case 'gunFired':
        if (e.local) audio.playGunBurst(e.rounds, 1);
        else {
          remoteRounds += e.rounds;
          remoteGain = Math.max(remoteGain, combatSoundGain(e.position.distanceTo(listener)));
        }
        break;
      case 'missileLaunched':
        audio.playMissileLaunch(e.local ? 1 : combatSoundGain(e.position.distanceTo(listener)));
        break;
      case 'flaresReleased':
        audio.playFlarePop(e.count, e.local ? 1 : combatSoundGain(e.position.distanceTo(listener)));
        break;
      case 'hit':
        if (e.cause === 'gun') audio.playHitMarker();
        break;
      case 'damaged':
        audio.playDamage();
        break;
      case 'explosion':
        audio.playExplosion(Math.max(0.15, combatSoundGain(e.position.distanceTo(listener))));
        break;
      default:
        break;
    }
  }
  if (remoteRounds > 0) audio.playGunBurst(remoteRounds, remoteGain);
}
